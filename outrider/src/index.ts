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
// Client chat (data plane) -- async submit+poll over the same RPC (no public URL needed):
//   chat  POST /lifecycle/chat/<sid>            -> 202 {job_id} (koboi /v1/jobs, continues the session)
//         GET  /lifecycle/chat/<sid>/<job_id>   -> JobStatusResponse (poll until terminal)
//   awaiting_human on poll flips the registry so the cron dismounts (~$0 while the controller reviews).
// Live-token STREAMING (POST /chat/stream) still needs a public Mount URL -> Wave-1 streaming.

import type { Env } from "./lib/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

import { ride, createSession, dismount, remount, retire, sessionMessages, pingMount, runReconcile, submitChatJob, pollChatJob } from "./lib/sandbox";
import * as reg from "./lib/registry";

const IDLE_THRESHOLD_MS = 60_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return json({ service: "koboi-range-outrider", status: "ok" });

    const m = url.pathname.match(
      /^\/lifecycle\/(ride|session|dismount|remount|retire|status|observe|messages|ping|reconcile|chat)\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (m) return handleLifecycle(m[1], decodeURIComponent(m[2]), req, env, m[3] ? decodeURIComponent(m[3]) : undefined);

    // Chat STREAMING (data plane, live tokens): needs a public Mount URL (tunnel/exposePort) -- Wave-1 streaming.
    // Non-streaming chat (submit + poll) IS wired: POST /lifecycle/chat/<sid>, GET /lifecycle/chat/<sid>/<job_id>.
    const sid = req.headers.get("X-Session-Id");
    if (sid && (url.pathname === "/chat/stream" || url.pathname.startsWith("/v1/"))) {
      return json({ error: "streaming_not_wired", detail: "live-token streaming needs a public Mount URL (tunnel/exposePort) -- Wave-1 streaming. Use POST /lifecycle/chat/<sid> (submit) + GET /lifecycle/chat/<sid>/<job_id> (poll) for non-streaming chat." }, 501);
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

async function handleLifecycle(action: string, sid: string, req: Request, env: Env, jobId?: string): Promise<Response> {
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
    case "chat": {
      // POLL: GET /lifecycle/chat/<sid>/<job_id>
      if (req.method === "GET") {
        if (!jobId) return json({ error: "missing job_id", detail: "GET /lifecycle/chat/<sid>/<job_id>" }, 400);
        const out = await pollChatJob(env, sid, jobId);
        const st = (out.body as { status?: string }).status;
        // A chat that hit a destructive-tool approval -> surface it to the cron so it dismounts (~$0).
        if (st === "awaiting_human") await reg.setStatus(env, sid, "awaiting_human");
        return json({ sid, action: "chat", job: out.body });
      }
      // SUBMIT: POST /lifecycle/chat/<sid>  body {message, mode?, max_iterations?}
      const body = (await req.json().catch(() => ({}))) as { message?: string; mode?: string; max_iterations?: number };
      if (!body.message || !body.message.trim()) {
        return json({ error: "missing message", detail: "POST /lifecycle/chat/<sid> body {message}" }, 400);
      }
      // Ensure the Mount is riding + we have a koboi session to continue (lazily creates one),
      // skipping ride if already riding (avoids a redundant `koboi serve` spawn on repeat chats).
      const existing = await reg.get(env, sid);
      let koboiSid = existing?.koboiSessionId ?? null;
      if (existing?.status !== "riding") await ride(env, sid, existing?.saddlebag ?? null);
      if (!koboiSid) koboiSid = await createSession(env, sid);
      await reg.setStatus(env, sid, "riding", { koboiSessionId: koboiSid });
      const job = await submitChatJob(env, sid, koboiSid, {
        message: body.message,
        mode: body.mode,
        max_iterations: body.max_iterations,
      });
      return json({ sid, action: "chat", job_id: job.job_id, status: job.status, koboi_session_id: koboiSid }, 202);
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
