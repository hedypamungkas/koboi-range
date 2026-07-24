# Contributing to koboi-range

Thanks for riding in. koboi-range is a **Wave-0 proof scaffold** — small, opinionated, and
deliberately minimal on the control plane until the data plane (Wave-1) lands. This file is the
short version of "how to make a change land cleanly."

## The two-minute version

```bash
cd outrider
npm ci
npm run typecheck   # ship gate: tsc --noEmit over src/
npm test            # 17 tests; runs fully LOCAL (no Cloudflare account, no deploy)
```

If both are green, you're in good shape.

## What needs no Cloudflare account

The whole Outrider test suite runs locally under Miniflare. The per-session **Mount**
(a Cloudflare Container) is **mocked** (`outrider/test/_sdk-mock.ts`); the **RANGE_KV registry**
and the **scheduled cron heartbeat** run against real ephemeral KV. So you can iterate on the
state machine, routing, and lifecycle wiring without ever deploying.

What you *can't* exercise locally is a **real ride** (a live `koboi serve` inside a real
Container). That needs a Workers **Paid** plan + R2/KV + an LLM key + `wrangler deploy` — see the
README [Deploy](README.md#deploy-wave-0-proof) section and [`demo/roundtrip.sh`](demo/roundtrip.sh).

## Test layout

| File | Covers |
|---|---|
| `test/registry.test.ts` | KV CRUD + the `idleSince` state-machine rules |
| `test/routing.test.ts` | fetch routing: `/healthz`, 404, the Wave-1 `501` chat placeholder, `/lifecycle/observe` webhook |
| `test/lifecycle.test.ts` | `ride` / `dismount` / `remount` SDK call sequences (mocked Mount) |
| `test/scheduled.test.ts` | the cron heartbeat: dismount / remount / retire transitions |

When you add behaviour, add a test. The Mount mock lives in one place — extend it there if you
need a new SDK call shape.

## Commit & branch conventions

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) (see `git log`):

```
feat(outrider): add X
fix(mount): handle Y
docs: clarify Z
test: cover the cron retire path
chore: bump deps
```

- Branch off `main` (`feat/...`, `fix/...`, `docs/...`).
- Open a PR against `main`; CI (`typecheck` + `test`) must pass.
- Keep one logical change per PR.

## Where things live / what's intentional

- **Control plane (`outrider/`) is intentionally minimal.** Resist adding features here before
  the [data plane (Wave-1)](docs/ROADMAP.md) ships — the `POST /chat/stream` `501` is the marker.
- **The cowboy vocabulary** (Range / Outrider / Mount / Saddlebag / ride / dismount) is the
  domain language, not flavour. Use it in code, tests, and docs; see the README glossary.
- **The Mount image (`mount/`)** is Python (`koboi-agent[api]`) + the vendored finance use-case.
  There is no Python test harness yet — if you touch `mount/`, prove it with a real deploy round-trip.

## Scope of the Waves

Before picking up something 🔴, skim [`docs/ROADMAP.md`](docs/ROADMAP.md) — it consolidates every
Wave-0/1/1b TODO and the constraint that blocks each one.
