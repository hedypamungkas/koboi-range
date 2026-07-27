# Roadmap — what's ridden, what's still in the corral

The README's [Honest caveats](../README.md#honest-caveats) scatter the Wave-N TODOs across
several sections. This page consolidates them into one place so a contributor can see, at a
glance, what is proven today and where the next ride is headed.

Status legend: ✅ done in this repo · 🟡 works, with a documented workaround · 🔴 placeholder/not yet.

## Wave-0 — proof scaffold (current)

The point of Wave-0 is to **prove a koboi session survives dismount → remount** on real Cloudflare
infra, end to end. Everything below is exercised by [`demo/roundtrip.sh`](../demo/roundtrip.sh).

| Area | Status | Notes |
|---|---|---|
| Outrider control plane (ride/dismount/remount/retire/status/observe) | ✅ | All SDK RPC — works on `.workers.dev`, no tunnel/exposePort needed. |
| Range heartbeat cron (1/min) | ✅ | Drives `awaiting_human`→dismount, `resuming`→remount, `done`→retire. |
| Consistent snapshot on dismount | ✅ | Via koboi 0.19.2 `POST /v1/sessions/{id}/suspend` (sqlite3 Online Backup API) — atomicity-independent. |
| Saddlebag → R2 (`createBackup({dir:"/workspace"})`) | 🟡 | Uses the FUSE-overlay `createBackup`/`restoreBackup` flow; native disk-suspend is the eventual target (same API going forward). |
| `pending_approval` observation | 🟡 | Webhook receiver `/lifecycle/observe/:sid`. You must wire the Mount's `jobs.webhooks`/`handover.webhooks` to POST there (polling the Mount's job status from the cron is the alternative). |
| Unit + integration tests | ✅ | `npm test` — KV/cron/routing/lifecycle covered with the Sandbox SDK mocked; no Cloudflare account needed to run. |

## Wave-1 — the data plane

| Area | Status | Notes |
|---|---|---|
| Client chat **streaming** (the data plane) | 🟡 | Wired: `proxyToSandbox(request, env)` gates `fetch()` (after the lifecycle router) and proxies `<port>-<sid>-<token>.<domain>` subdomains to the per-session Mount's `koboi serve`; `exposeStream` calls `exposePort(8000, {hostname: env.PUBLIC_DOMAIN, token: streamToken(sid)})` at the tail of `ride()`/`remount()` (re-activated each runtime → the preview URL is stable across suspend/resume). Routing + re-activation are covered by `lifecycle.test.ts` / `routing.test.ts`. **Deploy-proof pending:** live token-by-token SSE still wants a `curl -N` smoke check against a deployed Worker+container+custom-domain (koboi already sets `X-Accel-Buffering: no` + a 15s keepalive, so edge-buffering risk is low). Quick tunnels (`*.trycloudflare.com`) ruled out: buffer SSE + URL churns every remount. |
| Public Mount URL plumbing | ✅ | `proxyToSandbox` gate + `exposePort(8000, {hostname, token: streamToken(sid)})` (stable token → predictable URL, re-activated each ride/remount) + `PUBLIC_DOMAIN` var + wildcard DNS `*.range.<domain>` → Worker. `defaultPort(3000≠8000)` is why `exposePort` pins port 8000. `streamUrl` is persisted to the registry and returned by `ride`/`session`/`remount` + `/status`. Optional follow-ups: `keepAlive` for active streams; `unexposePort` on `retire`. |

## Wave-1b — operational hardening

| Area | Status | Notes |
|---|---|---|
| Explicit per-instance container teardown | 🔴 | Today `retire` stops `koboi serve` + drops the Saddlebag record; the Mount itself is reclaimed by **TTL auto-GC + idle scale-to-zero** (`SADDLEBAG_TTL_SEC = 7d`). Add `sb.stop()`/destroy for deterministic teardown. |
| Native CF container disk-suspend + native snapshots | 🟡 | "Coming soon" upstream. Until then, suspend/resume = `createBackup`/`restoreBackup`. The API surface the Outrider depends on (`createBackup`/`restoreBackup`) is unchanged going forward, so this should be a drop-in. |

## How to pick something up

- Anything 🔴 above is unclaimed and self-contained — the README caveats name the constraint for each.
- The control plane (✅) is intentionally minimal; resist adding features there before the data plane (Wave-1) lands.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, `npm test`, and the commit/PR conventions.
