// Outrider fetch routing: healthz, 404, the Wave-1 501 chat placeholder, and the
// /lifecycle/observe webhook -> registry transition. Sandbox SDK is globally mocked.
import { describe, it, expect, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import type { Env } from "../src/lib/sandbox";

const e = env as unknown as Env;
// `exports.default` is the Worker's default export (our { fetch, scheduled }); the pool injects
// env + ctx the same way the deprecated SELF.fetch did. Cloudflare.Exports is untyped, so cast.
const outrider = (exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }).default;
const call = (url: string, init?: RequestInit) => outrider.fetch(new Request(url, init));
const json = (r: Response) => r.json();

beforeEach(async () => {
  const keys = (await e.RANGE_KV.list()).keys;
  await Promise.all(keys.map((k) => e.RANGE_KV.delete(k.name)));
});

describe("routing", () => {
  it("GET /healthz -> 200 ok", async () => {
    const r = await call("http://outrider/healthz");
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ status: "ok" });
  });

  it("unknown path -> 404", async () => {
    expect((await call("http://outrider/nope")).status).toBe(404);
  });

  it("chat data plane is not wired (Wave-1) -> 501", async () => {
    const r = await call("http://outrider/chat/stream", { headers: { "X-Session-Id": "s1" } });
    expect(r.status).toBe(501);
    expect(await json(r)).toMatchObject({ error: "data_plane_not_wired" });
  });

  it("observe awaiting -> registry awaiting_human", async () => {
    const r = await call("http://outrider/lifecycle/observe/s9", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "awaiting_human" }),
    });
    expect(r.status).toBe(200);
    const status = (await json(await call("http://outrider/lifecycle/status/s9"))) as { status: string };
    expect(status).toMatchObject({ status: "awaiting_human" });
  });

  it("observe completed -> registry done", async () => {
    await call("http://outrider/lifecycle/observe/sX", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    const status = (await json(await call("http://outrider/lifecycle/status/sX"))) as { status: string };
    expect(status.status).toBe("done");
  });
});
