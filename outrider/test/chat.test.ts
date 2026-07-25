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
const envLite = { MOUNT_CONFIG: "/app/config/finance.yaml" } as never;

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
});

describe("pollChatJob", () => {
  it("GET /v1/jobs/{id} 200 -> JobStatusResponse passthrough", async () => {
    sandboxSpy.exec.mockResolvedValueOnce(
      execOut({ job_id: "job_123", status: "completed", session_id: "k1", result: { content: "Matched" } }),
    );
    const out = await pollChatJob(envLite, "s1", "job_123");
    expect(out.status).toBe(200);
    expect((out.body as { status: string }).status).toBe("completed");
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
});
