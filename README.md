<div align="center">

# koboi-range

**The open Range where koboi ride out & work — self-hosted, scale-to-zero, suspend/resume.**

A per-session, on-demand deployment runner for [koboi-agent](https://github.com/hedypamungkas/koboi-agent):
one isolated **Mount** (Cloudflare Container) per agent session, spun up when there's work,
**dismounted to a Saddlebag** (R2 snapshot) when idle (≈ $0), and **remounted** on resume.
No standby container. Your brain, your infra.

</div>

---

## Why

koboi-agent is *"self-hostable AI agents you can actually leave running."* Today that means
keeping a server container warm 24/7 — even when a session sits for hours in `pending_approval`
waiting for a human. **koboi-range kills that idle bill**: sessions that aren't actively working
are snapshotted to object storage and pay ~nothing, then resume exactly where they left off
(koboi's durable `steps` journal makes the gap survivable).

This is the same deployment pattern as **Devin Outposts** (per-session container, queue-driven
scale-to-zero, suspend/resume via FS snapshot) — but the agent **brain is yours** (open Python,
BYO-LLM), not a closed vendor cloud. See the feasibility study that motivates this repo:
[`koboi-agent/docs/devin-outposts-feasibility.md`](../koboi-agent/docs/devin-outposts-feasibility.md).

> **Wave-0 status — proof scaffold, not production.** Deps install and `tsc --noEmit` pass clean
> against `@cloudflare/sandbox@0.12.4` (verified 2026-07-23 against the SDK's own `.d.ts`:
> `getSandbox`, the `Sandbox` Durable-Object class, and the `createBackup`/`restoreBackup`
> signatures all match the code). Remaining gaps are **operational** (CF account / KV / R2 / secrets)
> plus the no-WAL-quiesce caveat. See [Honest caveats](#honest-caveats).

---

## The Range vocabulary

Every technical concept maps to one cowboy term — koboi is the Indonesian for *cowboy*, and the
Range is its home territory.

| Range term | Means |
|---|---|
| **Range** | the platform — your sovereign execution infra |
| **Outrider** | the edge coordinator (Cloudflare Worker + cron) that dispatches per session |
| **Mount** | one per-session Cloudflare Container running a single-session koboi server |
| **Saddlebag** | the `/workspace` snapshot (`koboi_memory.db` + steps journal + audit git) → `createBackup`/`restoreBackup` to R2 |
| **Ride** | start a Mount (restore its Saddlebag if it has one) |
| **off the Range** | suspended / scale-to-zero (≈ $0) — `dismount` |
| **Remount** | resume — fresh Mount + `restoreBackup` + koboi `resume_on_startup` / `POST /v1/sessions/:id/resume` |
| **Retire** | terminate — drop Mount + Saddlebag |

---

## Architecture

```
  controller browser ─┐
                      ├─▶  OUTRIDER (Cloudflare Worker, edge, ~$0 idle)
  overnight cron ─────┘        │  • route per-session traffic to the right Mount
                               │  • /lifecycle/* control API + /lifecycle/observe webhook
                               │  • cron 1/min = the "Range heartbeat"
                               ▼
                        RANGE_KV (session registry: status + Saddlebag handle)
                               │
                               │  getSandbox(env.Sandbox, sessionId)   [Sandbox SDK]
                               ▼
                  ┌──────────────────────────────────┐   ◀── restoreBackup() on remount
                  │  MOUNT (CF Container, instance=sid)│       createBackup()  on dismount
                  │   koboi serve  (single-session)    │
                  │   /workspace ◀── the Saddlebag root ──▶ │
                  │     ├ koboi_memory.db (WAL sqlite)  │
                  │     ├ steps journal (durable)       │
                  │     └ audit git (sandbox.git_init)  │
                  │   mcp: erp_mcp_server.py (stdio)    │
                  │   tools: finance_ext.* (incl.        │
                  │           post_journal_entry DESTR.) │
                  └──────────────┬───────────────────┘
                                 │ (real ERP only)
                                 ▼   CF Tunnel / Hyperdrive → internal services

            R2 bucket "range-saddlebags"  ← squashfs Saddlebags (TTL/lifecycle backstop)
```

**Three pieces, three homes:**

| Piece | Lives in | Stack |
|---|---|---|
| **Mount** image + use-case config | `mount/` | Dockerfile (Python + koboi `[api]`) |
| **Outrider** coordinator | `outrider/` | TypeScript / Cloudflare Workers (`@cloudflare/sandbox`) |
| The koboi **brain** itself | [koboi-agent](../koboi-agent) (consumed as a PyPI image) | Python |

---

## The lifecycle of one ride (the money shot)

The pattern earns its keep on sessions that **wait for a human** — like Ledgerline's controller
approving a journal entry. The wait is no longer billed:

```
t0  controller: "reconcile INV-8842 vs PO-4471"
      Outrider: POST /lifecycle/ride/<sid>  → Mount boots (restoreBackup if a Saddlebag exists)
      koboi act-loop: fetch_invoice → fetch_po → three_way_match   [SAFE reads, no gate]

t1  koboi calls post_journal_entry  (DESTRUCTIVE)
      → emits pending_approval → /lifecycle/observe marks session awaiting_human → IDLE

t2  cron (1/min): sid awaiting_human + idle > 60s
      → createBackup({dir:"/workspace"}) → R2 Saddlebag
      → Mount scales to zero                               💤 ~$0 while the controller reviews

t3  controller clicks Approve  (hours later)
      → status -> resuming → cron REMOUNTS: fresh Mount + restoreBackup(/workspace)
      → koboi resume_on_startup rehydrates the interrupted turn from the steps journal
      → post_journal_entry completes → ledger row written → audit row appended

t4  run terminal → cron sees done → RETIRE: drop Mount + delete Saddlebag
```

> koboi's `steps` journal writes the `running` marker **before** each LLM/tool step
> (`koboi-agent/koboi/journal.py:81-87`), so the t2→t3 gap is *survivable*. The generic
> Devin template warns "abrupt failure can lose recent changes"; koboi-range does not, because
> the journal is the durability source and the Saddlebag is just the FS that holds it.

---

## Repo layout

```
koboi-range/
├── mount/                      # the Mount image
│   ├── Dockerfile              # koboi [api] + git + /workspace Saddlebag root, single-session
│   ├── configs/finance.yaml    # Ledgerline config (adapted from koboi-use-cases)
│   └── usecase/finance-ext/    # vendored use-case code (tools + stdio ERP MCP server)
├── outrider/                   # the Outrider (edge coordinator)
│   ├── wrangler.jsonc          # containers + Durable Object + R2 + KV + cron bindings
│   ├── package.json / tsconfig.json
│   └── src/
│       ├── index.ts            # Worker: routes + scheduled cron (Range heartbeat)
│       └── lib/
│           ├── sandbox.ts      # ride/dismount/remount/retire via @cloudflare/sandbox
│           └── registry.ts     # RANGE_KV session registry
├── demo/roundtrip.sh           # drives the t0→t4 lifecycle against a deployed Outrider
└── README.md
```

---

## Deploy (Wave-0 proof)

Prereqs: a Cloudflare account with Workers + Containers + R2, `wrangler` logged in, and an
OpenAI key (or your provider) for the koboi Mount.

```bash
cd outrider
npm install                       # pins real dep versions; resolves the TS types

# 1. create the backing stores
npx wrangler kv namespace create RANGE_KV            # paste the id into wrangler.jsonc
npx wrangler r2 bucket create range-saddlebags

# 2. set the koboi/LLM secret on the Mount (rides the container env)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_MODEL        # e.g. gpt-4o-mini

# 3. fill wrangler.jsonc placeholders: KV id, CLOUDFLARE_ACCOUNT_ID
# 4. deploy the Outrider + Mount image + cron
npx wrangler deploy

# 5. prove a ride survives suspend/resume
../demo/roundtrip.sh <YOUR_WORKER_URL> demo-session-1
```

---

## Honest caveats (Wave-0)

- **Not deployable blind.** Needs `npm install`, a CF account, KV + R2 created, secrets set,
  and the `wrangler.jsonc` placeholders filled. The repo is a head start, not a one-click ship.
- **`@cloudflare/sandbox` API verified against v0.12.4 `.d.ts`** (2026-07-23): `getSandbox`,
  the `Sandbox` DO-class re-export, and the `createBackup({dir,name,ttl})` → `DirectoryBackup` →
  `restoreBackup(handle)` flow all typecheck clean. One hard constraint caught & fixed:
  `BackupOptions.dir` **must** be under `/workspace`·`/home`·`/tmp`·`/var/tmp`·`/app` (not `/data`)
  — hence the Saddlebag root is `/workspace`. Per-instance container teardown (`sb.stop()`/destroy)
  is still a Wave-1b TODO (today: TTL auto-GC + idle scale-to-zero).
- **No WAL quiesce yet.** `dismount` snapshots `/workspace` without `PRAGMA wal_checkpoint(TRUNCATE)`.
  Safe **only because the Outrider dismounts at session-idle** (no SQLite writer in flight). The
  clean fix is a ~10-LOC `SQLiteMemory.quiesce()` helper + `POST /v1/sessions/:id/suspend` /
  `/resume` endpoints — a small follow-up PR to **koboi-agent core**, not this repo.
- **Chat reverse-proxy uses standard DO RPC** (`env.Sandbox.idFromName(sid)` → `stub.fetch(req)`),
  routing `X-Session-Id` to that session's Mount; the Container DO forwards into the Mount's
  `koboi serve`. Confirm the container forwards arbitrary HTTP paths at first deploy (the SDK also
  ships `proxyToSandbox`/`proxyTerminal` if a URL-convention routing fits you better). The lifecycle
  control API + the Wave-0 proof work regardless.
- **`pending_approval` observation is via a webhook receiver** (`/lifecycle/observe/:sid`).
  Wire the Mount's `jobs.webhooks` / `handover.webhooks` to POST there. (Polling the Mount's job
  status from the cron is the alternative.)
- **Native CF container disk-suspend + native snapshots are "coming soon."** Today
  suspend/resume = `createBackup`/`restoreBackup` (FUSE overlay). Same API going forward.
- **Fits heavy per-session workloads** (reconciliation, contract review, research) — *not*
  high-fanout multi-tenant chat, where a warm multi-tenant server is cheaper.

---

## Relation to the koboi ecosystem

- **[koboi-agent](../koboi-agent)** — the brain (consumed as `koboi-agent[api]` in the Mount image). Zero engine change required for Wave-0; the only core touches (quiesce + suspend/resume endpoints) are a small follow-up PR.
- **[koboi-use-cases](../koboi-use-cases)** — the sector apps (finance-reconciliation is the demo use case vendored here). Sibling repo, same "consume koboi" pattern.
- **`koboi-agent/docs/devin-outposts-feasibility.md`** — the feasibility study that motivates this repo and classifies what's READY vs GAP.

---

## License

MIT, matching koboi-agent.
