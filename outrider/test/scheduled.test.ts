// The Range heartbeat (scheduled cron): drives the real state machine over the real KV,
// with the Mount mocked. Covers the three cron transitions: dismount / remount / retire.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { Env } from "../src/lib/sandbox";
import worker from "../src/index";
import { sandboxSpy } from "./_sdk-mock";

const e = env as unknown as Env;

const runHeartbeat = async () => {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), e, ctx);
  await waitOnExecutionContext(ctx);
};

const seed = (sid: string, rec: Record<string, unknown>) =>
  e.RANGE_KV.put("range:session:" + sid, JSON.stringify({ sessionId: sid, lastSeen: 0, ...rec }));

const read = (sid: string) => e.RANGE_KV.get("range:session:" + sid);

beforeEach(async () => {
  const keys = (await e.RANGE_KV.list()).keys;
  await Promise.all(keys.map((k) => e.RANGE_KV.delete(k.name)));
  sandboxSpy.createBackup.mockClear();
  sandboxSpy.restoreBackup.mockClear();
});

describe("Range heartbeat (scheduled)", () => {
  it("awaiting_human + idle > 60s -> DISMOUNT -> suspended + Saddlebag recorded", async () => {
    await seed("old", {
      status: "awaiting_human",
      saddlebag: null,
      idleSince: Date.now() - 120_000,
      koboiSessionId: "old",
    });
    await runHeartbeat();
    const rec = JSON.parse((await read("old"))!);
    expect(rec.status).toBe("suspended");
    expect(sandboxSpy.createBackup).toHaveBeenCalledTimes(1);
    expect(rec.saddlebag.id).toBe("bk-test");
  });

  it("awaiting_human but idle < 60s -> stays put (no dismount)", async () => {
    await seed("fresh", { status: "awaiting_human", saddlebag: null, idleSince: Date.now() });
    await runHeartbeat();
    expect(sandboxSpy.createBackup).not.toHaveBeenCalled();
    expect(JSON.parse((await read("fresh"))!).status).toBe("awaiting_human");
  });

  it("resuming + saddlebag -> REMOUNT -> riding", async () => {
    await seed("r", { status: "resuming", saddlebag: { id: "bk-1", name: "r", dir: "/workspace" } });
    await runHeartbeat();
    const rec = JSON.parse((await read("r"))!);
    expect(rec.status).toBe("riding");
    expect(sandboxSpy.restoreBackup).toHaveBeenCalledTimes(1);
  });

  it("done -> RETIRE -> record deleted", async () => {
    await seed("d", { status: "done", saddlebag: null });
    await runHeartbeat();
    expect(await read("d")).toBeNull();
  });
});
