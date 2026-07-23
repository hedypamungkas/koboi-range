// koboi-range Outrider -- the edge coordinator.
//
// Responsibilities:
//   1. Route per-session chat traffic to the right Mount (one CF Container per session).
//   2. Observe koboi session status (via the /lifecycle/observe webhook receiver).
//   3. Run a 1/min cron (the "Range heartbeat") that:
//        - awaiting_human + idle  -> DISMOUNT  (snapshot /workspace -> R2 Saddlebag, ~$0)
//        - resuming / approved    -> REMOUNT   (fresh Mount + restore Saddlebag + koboi resume)
//        - done                   -> RETIRE    (drop Mount + Saddlebag)
//
// Verified against @cloudflare/sandbox@0.12.4 (2026-07-23). The lifecycle control
// + cron are the solid Wave-0 core that proves suspend/resume; chat routing uses
// standard Durable-Object RPC (idFromName -> stub.fetch).

import type { Env } from "./lib/sandbox";
// Re-export the SDK's Sandbox DO class so the durable_objects `class_name: "Sandbox"` resolves.
export { Sandbox } from "@cloudflare/sandbox";

import { ride, dismount, remount, retire } from "./lib/sandbox";
import * as reg from "./lib/registry";

const IDLE_THRESHOLD_MS = 60_000; // dismount after 60s in awaiting_human

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz")
      return json({ service: "koboi-range-outrider", status: "ok" });

    // Lifecycle control surface (see handleLifecycle).
    const m = url.pathname.match(
      /^\/lifecycle\/(ride|dismount|remount|retire|status|observe)\/([^/]+)$/,
    );
    if (m) return handleLifecycle(m[1], decodeURIComponent(m[2]), req, env);

    // Chat reverse-proxy: route X-Session-Id -> that session's Mount DO via standard
    // DO RPC; the Container DO forwards the request into the Mount's koboi serve.
    const sid = req.headers.get("X-Session-Id");
    if (sid && (url.pathname === "/chat/stream" || url.pathname.startsWith("/v1/"))) {
      const id = env.Sandbox.idFromName(sid);
      return env.Sandbox.get(id).fetch(req);
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },

  // The Range heartbeat -- runs every 1 min via wrangler `triggers.crons`.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const sessions = await reg.list(env);
        const now = Date.now();
        for (const s of sessions) {
          try {
            if (
              s.status === "awaiting_human" &&
              s.idleSince &&
              now - s.idleSince > IDLE_THRESHOLD_MS
            ) {
              const backup = await dismount(env, s.sessionId);
              await reg.setStatus(env, s.sessionId, "suspended", { saddlebag: backup });
            } else if (s.status === "resuming") {
              if (s.saddlebag) {
                await remount(env, s.sessionId, s.saddlebag);
                await reg.setStatus(env, s.sessionId, "riding");
              }
            } else if (s.status === "done") {
              await retire(env, s.sessionId, s.saddlebag ?? null);
              await env.RANGE_KV.delete("range:session:" + s.sessionId);
            }
          } catch (err) {
            console.error("lifecycle error", s.sessionId, String(err));
            await reg.setStatus(env, s.sessionId, "error", { lastError: String(err) });
          }
        }
      })(),
    );
  },
};

async function handleLifecycle(
  action: string,
  sid: string,
  req: Request,
  env: Env,
): Promise<Response> {
  switch (action) {
    case "ride": {
      const existing = await reg.get(env, sid);
      await ride(env, sid, existing?.saddlebag ?? null);
      await reg.setStatus(env, sid, "riding", { saddlebag: existing?.saddlebag ?? null });
      return json({ sid, action: "ride", status: "riding" });
    }
    case "dismount": {
      const backup = await dismount(env, sid);
      await reg.setStatus(env, sid, "suspended", { saddlebag: backup });
      return json({
        sid,
        action: "dismount",
        status: "suspended",
        saddlebagId: backup.id,
      });
    }
    case "remount": {
      const rec = await reg.get(env, sid);
      if (!rec?.saddlebag) return json({ error: "no saddlebag to remount" }, 400);
      await remount(env, sid, rec.saddlebag);
      await reg.setStatus(env, sid, "riding");
      return json({ sid, action: "remount", status: "riding" });
    }
    case "retire": {
      const rec = await reg.get(env, sid);
      await retire(env, sid, rec?.saddlebag ?? null);
      await env.RANGE_KV.delete("range:session:" + sid);
      return json({ sid, action: "retire", status: "done" });
    }
    case "status": {
      return json(await reg.get(env, sid));
    }
    case "observe": {
      // koboi `jobs.webhooks` / `handover.webhooks` POST here on status changes.
      // Wire the Mount config to point webhooks at: https://<outrider>/lifecycle/observe/<sid>
      const body = (await req.json().catch(() => ({}))) as { status?: string };
      const st = String(body.status ?? "").toLowerCase();
      if (st.includes("await") || st.includes("pending") || st === "awaiting_human")
        await reg.setStatus(env, sid, "awaiting_human");
      else if (["completed", "done", "succeeded"].includes(st))
        await reg.setStatus(env, sid, "done");
      return json({ sid, observed: st });
    }
  }
  return json({ error: "unknown action" }, 400);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
