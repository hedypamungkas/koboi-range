// ConcurrencyGate DO tests: verify reserve/release logic and race safety.
import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyGateDO } from "../src/lib/concurrency";

describe("ConcurrencyGate DO", () => {
  let doStub: DurableObjectState;

  beforeEach(() => {
    doStub = {
      storage: {
        put: async () => {},
        get: async () => undefined,
        delete: async () => {},
        list: async () => ({ keys: [] }),
        rollback: async () => {},
      },
      id: { name: "gate" },
      waitUntil: async () => {},
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => await fn(),
    } as never;
  });

  it("global cap: rejects when MAX_GLOBAL reached", async () => {
    const do1 = new ConcurrencyGateDO(doStub, { CONCURRENCY_GATE_MAX_GLOBAL: "2" });

    const r1 = await do1.reserve("sid1", {});
    const r2 = await do1.reserve("sid2", {});
    const r3 = await do1.reserve("sid3", {});

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    expect(r3.reason).toBe("global_cap_exceeded");
  });

  it("per-repo cap: only one job per repo at a time", async () => {
    const do1 = new ConcurrencyGateDO(doStub, {});

    const r1 = await do1.reserve("sid1", { repo: "https://github.com/user/repo" });
    const r2 = await do1.reserve("sid2", { repo: "https://github.com/user/repo" });
    const r3 = await do1.reserve("sid3", { repo: "https://github.com/user/other" });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("repo_slot_held");
    expect(r3.ok).toBe(true);
  });

  it("per-repo cap: env CONCURRENCY_GATE_MAX_PER_REPO overrides the default (relax for isolated workspaces)", async () => {
    const do1 = new ConcurrencyGateDO(doStub, { CONCURRENCY_GATE_MAX_PER_REPO: "2" });

    const r1 = await do1.reserve("sid1", { repo: "repo-a" });
    const r2 = await do1.reserve("sid2", { repo: "repo-a" });
    const r3 = await do1.reserve("sid3", { repo: "repo-a" });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); // 2nd allowed under cap=2
    expect(r3.ok).toBe(false); // 3rd blocked
    expect(r3.reason).toBe("repo_slot_held");
  });

  it("release: frees the slot for reuse", async () => {
    const do1 = new ConcurrencyGateDO(doStub, { CONCURRENCY_GATE_MAX_GLOBAL: "1" });

    const r1 = await do1.reserve("sid1", { repo: "https://github.com/user/repo" });
    expect(r1.ok).toBe(true);

    await do1.release("sid1");

    const r2 = await do1.reserve("sid2", { repo: "https://github.com/user/repo" });
    expect(r2.ok).toBe(true);
  });

  it("race safety: concurrent reserves respect caps (simulate)", async () => {
    const do1 = new ConcurrencyGateDO(doStub, { CONCURRENCY_GATE_MAX_GLOBAL: "2" });

    // Simulate race by issuing reserves without await - DO serializes internally
    const promises = [
      do1.reserve("sid1", { repo: "repo-a" }),
      do1.reserve("sid2", { repo: "repo-a" }),
      do1.reserve("sid3", { repo: "repo-b" }),
    ];

    const results = await Promise.all(promises);

    // Exactly one repo-a job should succeed
    const repoAOk = results.filter((r) => r.ok && results.indexOf(r) < 2).length;
    expect(repoAOk).toBe(1);

    // repo-b should succeed (different repo)
    expect(results[2].ok).toBe(true);
  });
});
