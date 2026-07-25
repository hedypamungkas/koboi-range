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
BYO-LLM), not a closed vendor cloud.

> **Wave-0 status — proof scaffold, not production.** Wired to **koboi-agent 0.19.1**'s
> `POST /v1/sessions/{id}/suspend` (atomicity-independent `sqlite3` backup). Deps install and
> `tsc --noEmit` pass clean against `@cloudflare/sandbox@0.12.4`. Remaining gaps are
> **operational** (CF account / KV / R2 / secrets). See [Honest caveats](#honest-caveats).

---

## The Range vocabulary

Every technical concept maps to one cowboy term — koboi is the Indonesian for *cowboy*, and the
Range is its home territory.

| Range term | Means |
|---|---|
| **Range** | the platform — your sovereign execution infra |
| **Outrider** | the edge coordinator (Cloudflare Worker + cron) that dispatches per session |
| **Mount** | one per-session Cloudflare Container — a keep-alive; the Outrider starts/stops `koboi serve` inside it |
| **Saddlebag** | the `/workspace` snapshot (`koboi_memory.db` + steps journal + audit git) → `createBackup`/`restoreBackup` to R2 |
| **Ride** | boot the Mount, restore+swap its Saddlebag if resuming, then start `koboi serve` + wait ready |
| **off the Range** | suspended / scale-to-zero (≈ $0) — `dismount` |
| **Remount** | resume — fresh Mount + `restoreBackup` + swap the consistent snapshot in + restart `koboi serve` |
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
| The koboi **brain** itself | [koboi-agent](https://github.com/hedypamungkas/koboi-agent) (consumed as a PyPI image) | Python |

---

## The lifecycle of one ride (the money shot)

The pattern earns its keep on sessions that **wait for a human** — like Ledgerline's controller
approving a journal entry. The wait is no longer billed:

```
t0  controller: "reconcile INV-8842 vs PO-4471"
      Outrider: POST /lifecycle/ride/<sid>
        → Mount boots (keep-alive); restoreBackup(<saddlebag>) if resuming, else fresh
        → swapSnapshot (resume only): mv koboi_memory.db.<sid>.suspend.db → koboi_memory.db
        → startProcess("koboi serve") + wait /healthz 200   (the DB opens eagerly at boot)

t1  koboi act-loop: fetch_invoice → fetch_po → three_way_match   [SAFE reads, no gate]
      koboi calls post_journal_entry (DESTRUCTIVE) → pending_approval → awaiting_human → IDLE

t2  cron (1/min): awaiting_human + idle > 60s  →  DISMOUNT:
        → POST /v1/sessions/<sid>/suspend   → koboi writes a consistent snapshot
          (sqlite3 Online Backup API — atomicity-independent of createBackup)
        → createBackup({dir:"/workspace"})  → R2 Saddlebag  (snapshot file + workdir + audit)
        → pkill koboi serve  → Mount scales to zero          💤 ~$0 while the controller reviews

t3  controller clicks Approve  (hours later)  →  status → resuming  →  cron REMOUNTS:
        → fresh Mount + restoreBackup  →  swapSnapshot  →  startProcess("koboi serve") + wait ready
        → koboi resume_on_startup rehydrates the interrupted turn; post_journal_entry completes

t4  run terminal → cron sees done → RETIRE: stop serve + drop Saddlebag
```

> **Why the keep-alive Mount?** `koboi serve` opens the shared SQLite DB **eagerly** in `create_app`
> (JobStore/OwnershipStore, pre-lifespan) and `resume_on_startup` reads it at lifespan startup —
> *before* the first request. So the resume-side snapshot swap **must** happen before `koboi serve`
> starts (else split-brain: sidecars hold the old file while `resume_on_startup` ran on stale rows).
> The Outrider therefore owns the `koboi serve` lifecycle (start after restore+swap; stop before
> restore). koboi's `steps` journal makes the t2→t3 gap survivable regardless.

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

## Developing & testing

The Outrider has a local test suite that runs **without a Cloudflare account or deploy** —
the per-session Mount (Cloudflare Container) is mocked, while the registry + the cron heartbeat
run against real ephemeral KV (Miniflare). A real ride (live `koboi serve` in a live Container)
still needs a Paid CF account + deploy (see [Deploy](#deploy-wave-0-proof)).

```bash
cd outrider
npm ci
npm run typecheck   # tsc --noEmit over src/ (the ship gate)
npm test            # vitest: 17 tests across registry / routing / lifecycle / scheduled
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [docs/ROADMAP.md](docs/ROADMAP.md)
for the Wave-0 → Wave-1b TODO list.

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
- **Consistency is via koboi 0.19.1 `/suspend`, not WAL quiesce.** On dismount the Outrider calls
  `POST /v1/sessions/{id}/suspend`, which writes a **consistent** snapshot via the sqlite3 Online
  Backup API (atomicity-independent — safe even while other connections write). The Outrider then
  `createBackup`s `/workspace` (capturing that file + workdir + audit). On resume it restores +
  swaps the snapshot into place **before** starting `koboi serve`. No raw WAL-trio file-copy.
- **Control plane is all SDK RPC (no Worker→container HTTP).** Readiness uses
  `proc.waitForPort(8000, {path:"/healthz"})`; `/suspend` + session create/verify run a one-shot
  HTTP call **from inside the Mount** (localhost:8000) via `sb.exec`. This is why it works on
  `.workers.dev` (no `exposePort`/tunnel/custom-domain). Client chat **streaming** (the data
  plane) needs a public Mount URL — Wave-1 (`POST /chat/stream` returns 501 for now). The first
  wiring step is missing: `proxyToSandbox(request, env)` is not yet called (the fetch() at
  `outrider/src/index.ts:22-39` jumps straight to the 501 stub). The planned Wave-1 approach
  (feasibility under review) is `proxyToSandbox` + `exposePort(8000, {hostname, token:sid})`
  on a custom domain with wildcard DNS. Quick tunnels (`*.trycloudflare.com`) are unsuitable:
  they buffer SSE responses (token streaming would not stream) and the URL does not survive
  container restarts (DO storage clears on `onStart`, so every dismount→remount yields a fresh URL).
- **`pending_approval` observation is via a webhook receiver** (`/lifecycle/observe/:sid`).
  Wire the Mount's `jobs.webhooks` / `handover.webhooks` to POST there. (Polling the Mount's job
  status from the cron is the alternative.)
- **Native CF container disk-suspend + native snapshots are "coming soon."** Today
  suspend/resume = `createBackup`/`restoreBackup` (FUSE overlay). Same API going forward.
- **Fits heavy per-session workloads** (reconciliation, contract review, research) — *not*
  high-fanout multi-tenant chat, where a warm multi-tenant server is cheaper.

---

## Relation to the koboi ecosystem

- **[koboi-agent](https://github.com/hedypamungkas/koboi-agent)** — the brain (consumed as `koboi-agent[api]==0.19.1` in the Mount image). The `POST /v1/sessions/{id}/suspend` endpoint + `SQLiteMemory.consistent_backup()` this repo consumes shipped in **0.19.1** (PR #98).
- **koboi-use-cases** — the sector apps (finance-reconciliation is the demo use case vendored here). Sibling repo, same "consume koboi" pattern.

---

## License

MIT, matching koboi-agent.
