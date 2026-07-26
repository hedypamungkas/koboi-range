// Outrider fetch routing: healthz, 404, the Wave-1 501 chat placeholder, and the
// /lifecycle/observe webhook -> registry transition. Sandbox SDK is globally mocked.
import { describe, it, expect, beforeEach } from "vitest";
import { env, exports } from "cloudflare:workers";
import type { Env } from "../src/lib/sandbox";
import { sandboxSpy } from "./_sdk-mock";

const e = env as unknown as Env;
// `exports.default` is the Worker's default export (our { fetch, scheduled }); the pool injects
// env + ctx the same way the deprecated SELF.fetch did. Cloudflare.Exports is untyped, so cast.
const outrider = (exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }).default;
const call = (url: string, init?: RequestInit) => outrider.fetch(new Request(url, init));
const json = (r: Response) => r.json();

beforeEach(async () => {
  const keys = (await e.RANGE_KV.list()).keys;
  await Promise.all(keys.map((k) => e.RANGE_KV.delete(k.name)));
  sandboxSpy.proxyToSandbox.mockClear();
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

  it("bare-hostname /chat/stream -> 501 use_preview_url (streaming lives at the preview URL)", async () => {
    const r = await call("http://outrider/chat/stream", { headers: { "X-Session-Id": "s1" } });
    expect(r.status).toBe(501);
    expect(await json(r)).toMatchObject({ error: "use_preview_url" });
    expect(sandboxSpy.proxyToSandbox).toHaveBeenCalledTimes(1); // gate ran, returned null, fell through
  });

  // Subdomain-shaped preview URLs are proxied to the per-session Mount (proxyToSandbox); a bare
  // hostname is NOT, so it falls through to the 501 above. (The real DO-proxy SSE bytes can't run
  // under Miniflare -- no live container -- so this asserts the routing decision, not the stream.)
  it("subdomain-shaped preview URL -> proxied to the Mount (not the 501 fallback)", async () => {
    const r = await call("https://8000-s1-s1.range.example.com/v1/chat/stream", {
      headers: { "X-Session-Id": "s1", Accept: "text/event-stream" },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("proxied:/v1/chat/stream");
    expect(sandboxSpy.proxyToSandbox).toHaveBeenCalledTimes(1);
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
