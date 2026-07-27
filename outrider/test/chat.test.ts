// Wave-1 data plane: submitChatJob/pollChatJob + the /lifecycle/chat routes.
// httpInMount parses the LAST exec stdout line as JSON {status, body}; the global _sdk-mock
// lets us stage per-call responses via sandboxSpy.exec.mockResolvedValueOnce(...).
// The body koboi receives (message + resumed session_id) is proven live; here we unit-test the
// parsing, the HTTP-status contract (202 submit / 200 poll), the error paths, and the
// awaiting_human -> registry transition that wires chat into the suspend/resume lifecycle.
import { describe, it, expect, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import type { Env } from "../src/lib/sandbox";
import { submitChatJob, pollChatJob } from "../src/lib/sandbox";
import { sandboxSpy } from "./_sdk-mock";

const e = env as unknown as Env;
const outrider = (exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }).default;
const call = (url: string, init?: RequestInit) => outrider.fetch(new Request(url, init));
const json = (r: Response) => r.json();
const envLite = { MOUNT_CONFIG: "/app/config/default.yaml" } as never;

/** Shape the mock exec result so httpInMount parses {status, body} from its last stdout line. */
const execOut = (body: unknown, status = 200) => ({
  stdout: JSON.stringify({ status, body }),
  stderr: "",
  exitCode: 0,
});

const seed = (sid: string, patch: Record<string, unknown> = {}) =>
  e.RANGE_KV.put(
    "range:session:" + sid,
    JSON.stringify({ sessionId: sid, status: "riding", koboiSessionId: "k-" + sid, lastSeen: 0, ...patch }),
  );

/** UTF-8-safe base64 decode (mirrors sandbox.ts b64encodeUtf8) for asserting what koboi received. */
const b64DecodeUtf8 = (b64: string) => {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Decode the JSON body koboi received from the i-th exec call (the POST /v1/jobs payload).
 *  The SDK mock's `calls` are typed as empty-param tuples, so index through `unknown[]`. */
const submittedBody = (callIdx = 0): Record<string, unknown> => {
  const cmd = (sandboxSpy.exec.mock.calls[callIdx] as unknown[])[0] as string;
  const py = b64DecodeUtf8(cmd.match(/b64decode\('([^']+)'\)/)![1]);
  const bodyB64 = py.match(/data=base64\.b64decode\("([^"]+)"\)/)![1];
  return JSON.parse(b64DecodeUtf8(bodyB64));
};

beforeEach(async () => {
  sandboxSpy.exec.mockClear();
  sandboxSpy.startProcess.mockClear();
  sandboxSpy.createBackup.mockClear();
  sandboxSpy.restoreBackup.mockClear();
  const keys = (await e.RANGE_KV.list()).keys;
  await Promise.all(keys.map((k) => e.RANGE_KV.delete(k.name)));
});

describe("submitChatJob", () => {
  it("POST /v1/jobs 202 -> returns the job handle {job_id, status, session_id}", async () => {
    sandboxSpy.exec.mockResolvedValueOnce(
      execOut({ job_id: "job_123", status: "pending", session_id: "k1" }, 202),
    );
    const h = await submitChatJob(envLite, "s1", "k1", { message: "reconcile INV-8842" });
    expect(h).toMatchObject({ job_id: "job_123", status: "pending", session_id: "k1" });
  });

  it("non-202 -> throws (surfaces the koboi status, not a silent success)", async () => {
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ detail: "bad request" }, 400));
    await expect(submitChatJob(envLite, "s1", "k1", { message: "x" })).rejects.toThrow(
      /\/v1\/jobs returned 400/,
    );
  });

  it("encodes message + resumed session_id (+mode/max_iterations); non-ASCII survives (C1/C2)", async () => {
    // Before the UTF-8 btoa fix, 三菱/🎉 would throw InvalidCharacterError before exec ever ran.
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ job_id: "job_x", status: "pending", session_id: "k-三菱" }, 202));
    await submitChatJob(envLite, "s1", "k-三菱", { message: "reconcile 三菱 INV-8842 🎉", mode: "act", max_iterations: 7 });
    expect(submittedBody(0)).toMatchObject({
      message: "reconcile 三菱 INV-8842 🎉",
      session_id: "k-三菱",
      mode: "act",
      max_iterations: 7,
    });
  });
});

describe("pollChatJob", () => {
  it("GET /v1/jobs/{id} 200 -> JobStatusResponse passthrough", async () => {
    sandboxSpy.exec.mockResolvedValueOnce(
      execOut({ job_id: "job_123", status: "completed", session_id: "k1", result: { content: "Matched" } }),
    );
    const out = await pollChatJob(envLite, "s1", "job_123");
    expect(out.status).toBe(200);
    expect(out.body.status).toBe("completed");
  });

  it("non-200 -> throws", async () => {
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ detail: "no such job" }, 404));
    await expect(pollChatJob(envLite, "s1", "job_missing")).rejects.toThrow(/returned 404/);
  });
});

describe("chat routes", () => {
  it("POST /lifecycle/chat/<sid> with no message -> 400 (before touching the Mount)", async () => {
    const r = await call("http://outrider/lifecycle/chat/s1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ error: "missing message" });
    expect(sandboxSpy.exec).not.toHaveBeenCalled();
  });

  it("GET /lifecycle/chat/<sid> with no job_id -> 400", async () => {
    const r = await call("http://outrider/lifecycle/chat/s1");
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ error: "missing job_id" });
  });

  it("POST happy path -> 202 {job_id}: rides, creates the koboi session, enqueues; registry riding+koboiSessionId", async () => {
    // exec fires twice: createSession (POST /v1/sessions) then submitChatJob (POST /v1/jobs).
    sandboxSpy.exec
      .mockResolvedValueOnce(execOut({ session_id: "koboi-sid-1" }, 201))
      .mockResolvedValueOnce(execOut({ job_id: "job_abc", status: "pending", session_id: "koboi-sid-1" }, 202));
    const r = await call("http://outrider/lifecycle/chat/s1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "reconcile INV-8842 vs PO-4471" }),
    });
    expect(r.status).toBe(202);
    expect(await json(r)).toMatchObject({
      action: "chat",
      job_id: "job_abc",
      status: "pending",
      koboi_session_id: "koboi-sid-1",
    });
    const st = (await json(await call("http://outrider/lifecycle/status/s1"))) as Record<string, unknown>;
    expect(st).toMatchObject({ status: "riding", koboiSessionId: "koboi-sid-1" });
  });

  it("GET poll awaiting_human -> flips registry to awaiting_human (the cron then dismounts to ~$0)", async () => {
    await seed("s2");
    sandboxSpy.exec.mockResolvedValueOnce(
      execOut({ job_id: "j1", status: "awaiting_human", session_id: "k-s2", result: { reason: "approval" } }),
    );
    const r = await call("http://outrider/lifecycle/chat/s2/j1");
    expect(r.status).toBe(200);
    const st = (await json(await call("http://outrider/lifecycle/status/s2"))) as Record<string, unknown>;
    expect(st.status).toBe("awaiting_human");
  });

  it("GET poll completed -> passes through result.content; registry stays riding", async () => {
    await seed("s3");
    sandboxSpy.exec.mockResolvedValueOnce(
      execOut({ job_id: "j2", status: "completed", session_id: "k-s3", result: { content: "Matched" } }),
    );
    const r = await call("http://outrider/lifecycle/chat/s3/j2");
    expect(r.status).toBe(200);
    const body = (await json(r)) as { job: { status: string; result: { content: string } } };
    expect(body.job.status).toBe("completed");
    expect(body.job.result.content).toBe("Matched");
    const st = (await json(await call("http://outrider/lifecycle/status/s3"))) as Record<string, unknown>;
    expect(st.status).toBe("riding");
  });

  it("POST on an already-riding session skips ride + createSession and continues the existing koboi session (C2-gap)", async () => {
    await seed("s4", { koboiSessionId: "k-s4" });
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ job_id: "job_cont", status: "pending", session_id: "k-s4" }, 202));
    const r = await call("http://outrider/lifecycle/chat/s4", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "second chat" }),
    });
    expect(r.status).toBe(202);
    expect(await json(r)).toMatchObject({ job_id: "job_cont", koboi_session_id: "k-s4" });
    // No ride -> no startProcess; no createSession -> exactly one exec (the submit), continuing k-s4.
    expect(sandboxSpy.startProcess).not.toHaveBeenCalled();
    expect(sandboxSpy.exec).toHaveBeenCalledTimes(1);
    expect(submittedBody(0)).toMatchObject({ session_id: "k-s4", message: "second chat" });
  });

  it("POST submit failure -> 500 lifecycle_failed (outer catch surfaces it, not a silent 200) (C3-gap)", async () => {
    await seed("s5", { koboiSessionId: "k-s5" });
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ detail: "koboi blew up" }, 500));
    const r = await call("http://outrider/lifecycle/chat/s5", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(r.status).toBe(500);
    expect(await json(r)).toMatchObject({ error: "lifecycle_failed", action: "chat" });
  });

  it("POST with malformed JSON -> 400 invalid_json (was silently coerced to 'missing message')", async () => {
    const r = await call("http://outrider/lifecycle/chat/s1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ error: "invalid_json" });
    expect(sandboxSpy.exec).not.toHaveBeenCalled();
  });

  it("DELETE /lifecycle/chat/<sid> -> 405 (only GET/POST supported)", async () => {
    const r = await call("http://outrider/lifecycle/chat/s1", { method: "DELETE" });
    expect(r.status).toBe(405);
    expect(sandboxSpy.exec).not.toHaveBeenCalled();
  });

  it("GET poll on a non-riding session -> 503 session_not_riding (koboi serve isn't up)", async () => {
    await seed("s6", { status: "suspended" });
    const r = await call("http://outrider/lifecycle/chat/s6/j1");
    expect(r.status).toBe(503);
    expect(await json(r)).toMatchObject({ error: "session_not_riding", status: "suspended" });
    expect(sandboxSpy.exec).not.toHaveBeenCalled();
  });

  it("GET poll failed -> records lastError, registry stays riding (visible + retryable)", async () => {
    await seed("s7", { koboiSessionId: "k-s7" });
    sandboxSpy.exec.mockResolvedValueOnce(
      execOut({ job_id: "j7", status: "failed", session_id: "k-s7", error: "tool broke", error_class: "ValueError" }),
    );
    const r = await call("http://outrider/lifecycle/chat/s7/j7");
    expect(r.status).toBe(200);
    const st = (await json(await call("http://outrider/lifecycle/status/s7"))) as Record<string, unknown>;
    expect(st.status).toBe("riding");
    expect(String(st.lastError)).toMatch(/failed/);
    expect(String(st.lastError)).toMatch(/ValueError/);
    expect(String(st.lastError)).toMatch(/tool broke/);
  });

  it("GET poll timed_out -> records lastError too", async () => {
    await seed("s8", { koboiSessionId: "k-s8" });
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ job_id: "j8", status: "timed_out", session_id: "k-s8", error: "slow" }));
    await call("http://outrider/lifecycle/chat/s8/j8");
    const st = (await json(await call("http://outrider/lifecycle/status/s8"))) as Record<string, unknown>;
    expect(st.status).toBe("riding");
    expect(String(st.lastError)).toMatch(/timed_out/);
  });

  it("GET poll cancelled -> passes through, registry stays riding (no failure recorded)", async () => {
    await seed("s9", { koboiSessionId: "k-s9" });
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ job_id: "j9", status: "cancelled", session_id: "k-s9" }));
    const r = await call("http://outrider/lifecycle/chat/s9/j9");
    expect(r.status).toBe(200);
    const st = (await json(await call("http://outrider/lifecycle/status/s9"))) as Record<string, unknown>;
    expect(st.status).toBe("riding");
    expect(st.lastError).toBeFalsy();
  });

  it("GET poll with an unrecognized koboi status -> records lastError (no silent passthrough on drift)", async () => {
    await seed("s10", { koboiSessionId: "k-s10" });
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ job_id: "j10", status: "rate_limited", session_id: "k-s10" }));
    const r = await call("http://outrider/lifecycle/chat/s10/j10");
    expect(r.status).toBe(200);
    const st = (await json(await call("http://outrider/lifecycle/status/s10"))) as Record<string, unknown>;
    expect(st.status).toBe("riding");
    expect(String(st.lastError)).toMatch(/unexpected/);
    expect(String(st.lastError)).toMatch(/rate_limited/);
  });

  it("POST submit clears a prior lastError (recovery on retry)", async () => {
    await seed("s11", { koboiSessionId: "k-s11", lastError: "prior boom" });
    sandboxSpy.exec.mockResolvedValueOnce(execOut({ job_id: "j11", status: "pending", session_id: "k-s11" }, 202));
    const r = await call("http://outrider/lifecycle/chat/s11", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "retry" }),
    });
    expect(r.status).toBe(202);
    const st = (await json(await call("http://outrider/lifecycle/status/s11"))) as Record<string, unknown>;
    expect(st.status).toBe("riding");
    expect(st.lastError).toBeNull();
  });
});
