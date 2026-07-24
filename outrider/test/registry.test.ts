// RANGE_KV registry: CRUD + the idleSince state-machine rules, against REAL ephemeral KV.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/lib/sandbox";
import * as reg from "../src/lib/registry";

const e = env as unknown as Env;

beforeEach(async () => {
  const keys = (await e.RANGE_KV.list()).keys;
  await Promise.all(keys.map((k) => e.RANGE_KV.delete(k.name)));
});

describe("registry", () => {
  it("get returns null for an unknown session", async () => {
    expect(await reg.get(e, "nope")).toBeNull();
  });

  it("put/get round-trips a record and stamps lastSeen", async () => {
    await reg.put(e, { sessionId: "s1", status: "riding", saddlebag: null, lastSeen: 0 });
    const got = await reg.get(e, "s1");
    expect(got).not.toBeNull();
    expect(got!.status).toBe("riding");
    expect(got!.lastSeen).toBeGreaterThan(0);
  });

  it("setStatus stamps idleSince on the first awaiting_human, and clears it back to riding", async () => {
    await reg.setStatus(e, "s2", "riding");
    expect((await reg.get(e, "s2"))!.idleSince).toBeNull();

    await reg.setStatus(e, "s2", "awaiting_human");
    const first = (await reg.get(e, "s2"))!.idleSince;
    expect(first).toBeGreaterThan(0);

    // re-asserting awaiting_human must NOT reset the timestamp (so the idle clock survives re-observe)
    await reg.setStatus(e, "s2", "awaiting_human");
    expect((await reg.get(e, "s2"))!.idleSince).toBe(first);

    await reg.setStatus(e, "s2", "riding");
    expect((await reg.get(e, "s2"))!.idleSince).toBeNull();
  });

  it("list returns every session record", async () => {
    await reg.setStatus(e, "a", "riding");
    await reg.setStatus(e, "b", "suspended");
    const ids = (await reg.list(e)).map((r) => r.sessionId).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});
