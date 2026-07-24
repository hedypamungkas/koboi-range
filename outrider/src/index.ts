// koboi-range Outrider -- the edge coordinator.
//
// Lifecycle (all SDK RPC -- no Worker->container HTTP, so it works on .workers.dev):
//   ride     boot Mount (keep-alive) + restore/swap Saddlebag + start `koboi serve` + waitForPort
//   session  create a koboi session inside the Mount (POST /v1/sessions via in-Mount exec)
//   dismount /suspend (consistent snapshot) -> createBackup(/workspace) -> stop serve (~$0)
//   remount  stop -> restore Saddlebag -> swap snapshot -> start serve -> waitForPort
//   messages GET the session's messages (proves the restored/swapped DB is live)
//   retire   stop serve + drop Saddlebag
// The cron (1/min) drives awaiting_human->dismount, resuming->remount, done->retire.
// Client chat STREAMING (data plane) needs a public Mount URL (tunnel/exposePort) -> Wave-1.

import type { Env } from "./lib/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

import { ride, createSession, dismount, remount, retire, sessionMessages, pingMount, runReconcile } from "./lib/sandbox";
import * as reg from "./lib/registry";

const IDLE_THRESHOLD_MS = 60_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json({ service: "koboi-range-outrider", status: "ok" });

    const m = url.pathname.match(
      /^\/lifecycle\/(ride|session|dismount|remount|retire|status|observe|messages|ping|reconcile)\/([^/]+)$/,
    );
    if (m) return handleLifecycle(m[1], decodeURIComponent(m[2]), req, env);

    // Chat STREAMING (data plane): needs a public Mount URL (tunnel/exposePort) -- Wave-1.
    const sid = req.headers.get("X-Session-Id");
    if (sid && (url.pathname === "/chat/stream" || url.pathname.startsWith("/v1/"))) {
      return json({ error: "data_plane_not_wired", detail: "client chat streaming needs a public Mount URL (tunnel/exposePort) -- Wave-1" }, 501);
    }

    return json({ error: "not found", path: url.pathname }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        for (const s of await reg.list(env)) {
          try {
            if (s.status === "awaiting_human" && s.idleSince && Date.now() - s.idleSince > IDLE_THRESHOLD_MS) {
              const res = await dismount(env, s.sessionId, s.koboiSessionId ?? s.sessionId);
              await reg.setStatus(env, s.sessionId, "suspended", {
                saddlebag: res.backup,
                lastCheckpointOk: res.checkpoint.ok,
              });
            } else if (s.status === "resuming" && s.saddlebag) {
              await remount(env, s.sessionId, s.saddlebag);
              await reg.setStatus(env, s.sessionId, "riding");
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

async function handleLifecycle(action: string, sid: string, req: Request, env: Env): Promise<Response> {
  try {
  switch (action) {
    case "ping": {
      return json({ sid, action: "ping", pong: await pingMount(env, sid) });
    }
    case "reconcile": {
      return json({ sid, action: "reconcile", reconcile: await runReconcile(env, sid) });
    }
    case "ride": {
      const existing = await reg.get(env, sid);
      await ride(env, sid, existing?.saddlebag ?? null);
      await reg.setStatus(env, sid, "riding", { saddlebag: existing?.saddlebag ?? null });
      return json({ sid, action: "ride", status: "riding" });
    }
    case "session": {
      await ride(env, sid, (await reg.get(env, sid))?.saddlebag ?? null); // ensure Mount is up
      const koboiSid = await createSession(env, sid);
      await reg.setStatus(env, sid, "riding", { koboiSessionId: koboiSid });
      return json({ sid, action: "session", koboiSessionId: koboiSid, status: "riding" });
    }
    case "dismount": {
      const rec = await reg.get(env, sid);
      const res = await dismount(env, sid, rec?.koboiSessionId ?? sid);
      await reg.setStatus(env, sid, "suspended", {
        saddlebag: res.backup,
        lastCheckpointOk: res.checkpoint.ok,
      });
      return json({
        sid,
        action: "dismount",
        status: "suspended",
        saddlebagId: res.backup.id,
        checkpoint: res.checkpoint,
        snapshotPath: res.snapshotPath,
      });
    }
    case "remount": {
      const rec = await reg.get(env, sid);
      if (!rec?.saddlebag) return json({ error: "no saddlebag to remount" }, 400);
      await remount(env, sid, rec.saddlebag);
      await reg.setStatus(env, sid, "riding");
      return json({ sid, action: "remount", status: "riding" });
    }
    case "messages": {
      const rec = await reg.get(env, sid);
      if (rec?.status !== "riding") return json({ error: "session_not_riding", status: rec?.status ?? "unknown" }, 503);
      return json(await sessionMessages(env, sid, rec.koboiSessionId ?? sid));
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
      const body = (await req.json().catch(() => ({}))) as { status?: string };
      const st = String(body.status ?? "").toLowerCase();
      if (st.includes("await") || st.includes("pending") || st === "awaiting_human")
        await reg.setStatus(env, sid, "awaiting_human");
      else if (["completed", "done", "succeeded"].includes(st)) await reg.setStatus(env, sid, "done");
      return json({ sid, observed: st });
    }
  }
  return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: "lifecycle_failed", action, sid, detail: String((e as Error)?.message ?? e) }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
