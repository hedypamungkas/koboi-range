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
| Consistent snapshot on dismount | ✅ | Via koboi 0.19.1 `POST /v1/sessions/{id}/suspend` (sqlite3 Online Backup API) — atomicity-independent. |
| Saddlebag → R2 (`createBackup({dir:"/workspace"})`) | 🟡 | Uses the FUSE-overlay `createBackup`/`restoreBackup` flow; native disk-suspend is the eventual target (same API going forward). |
| `pending_approval` observation | 🟡 | Webhook receiver `/lifecycle/observe/:sid`. You must wire the Mount's `jobs.webhooks`/`handover.webhooks` to POST there (polling the Mount's job status from the cron is the alternative). |
| Unit + integration tests | ✅ | `npm test` — KV/cron/routing/lifecycle covered with the Sandbox SDK mocked; no Cloudflare account needed to run. |

## Wave-1 — the data plane

| Area | Status | Notes |
|---|---|---|
| Client chat **streaming** (the data plane) | 🔴 | `POST /chat/stream` + `/v1/*` return `501 data_plane_not_wired`. The first wiring step is missing: `proxyToSandbox(request, env)` is not yet called (the fetch() at `outrider/src/index.ts:22-39` jumps straight to the 501 stub). The planned Wave-1 approach (feasibility under review): `proxyToSandbox` gate + `exposePort(8000, {hostname, token:sid})` re-activated on remount + custom domain + wildcard DNS. Quick tunnels (`*.trycloudflare.com`) are ruled out: (a) they buffer SSE responses (token streaming would not stream), and (b) the URL does not survive container restarts (DO storage clears on `onStart`, so every dismount→remount yields a fresh URL). Note: `koboi serve` runs on port 8000 but the Sandbox DO `defaultPort` is 3000 — `exposePort` must specify port 8000. |
| Public Mount URL plumbing | 🔴 | `proxyToSandbox` gate (currently missing — the first step) + `exposePort(8000, {hostname, token:sid})` re-activated on each remount + custom domain with wildcard DNS (e.g., `*.sessions.yourdomain.com` → `proxyToSandbox` → session-specific preview URL). Sub-items: `defaultPort(3000≠8000)` mismatch requires `exposePort(8000, ...)`; `keepAlive` not set (`getSandbox` called with no options) — consider setting for active chat streams so the DO alarm doesn't sleep the container mid-token (under RPC transport, `onSessionBusy`/`onSessionIdle` auto-renew during in-flight streams). |

## Wave-1b — operational hardening

| Area | Status | Notes |
|---|---|---|
| Explicit per-instance container teardown | 🔴 | Today `retire` stops `koboi serve` + drops the Saddlebag record; the Mount itself is reclaimed by **TTL auto-GC + idle scale-to-zero** (`SADDLEBAG_TTL_SEC = 7d`). Add `sb.stop()`/destroy for deterministic teardown. |
| Native CF container disk-suspend + native snapshots | 🟡 | "Coming soon" upstream. Until then, suspend/resume = `createBackup`/`restoreBackup`. The API surface the Outrider depends on (`createBackup`/`restoreBackup`) is unchanged going forward, so this should be a drop-in. |

## How to pick something up

- Anything 🔴 above is unclaimed and self-contained — the README caveats name the constraint for each.
- The control plane (✅) is intentionally minimal; resist adding features there before the data plane (Wave-1) lands.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, `npm test`, and the commit/PR conventions.
