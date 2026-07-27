// ConcurrencyGate Durable Object -- enforces global and per-repo concurrency caps.
//
// Single-writer semantics (DO serializes requests) = race-safe. The DO maintains an
// in-flight set tracking all active sessions. Global cap leaves headroom under the
// ~750-CPU account ceiling; per-repo cap of 1 enforces same-branch / single-slot
// protection (two jobs mutating one clone must not run concurrently, or the second
// clobbers the first's working tree).
//
// Reaping: a self-arming alarm (CONCURRENCY_GATE_REAP_TTL_MS, default 30 min) evicts
// entries older than the TTL. This bounds every leak path -- a failed release, a
// reserve-then-throw, or an orphaned session whose caller never returns -- so a slot
// can never be held forever. (The `since` timestamp on each entry exists for this.)
//
// Wiring (deploy): the class IS exported from src/index.ts and the CONCURRENCY_GATE
// durable_objects binding + v2 sqlite migration ARE committed in wrangler.jsonc. The
// file is skip-worktree'd locally so account/KV/domain values stay uncommitted while
// the structural binding is tracked in HEAD. ride() reserves a slot via
// env.CONCURRENCY_GATE; retire() (and ride()'s own failure path) release it. Caps are
// env-tunable: CONCURRENCY_GATE_MAX_GLOBAL (default 50), CONCURRENCY_GATE_MAX_PER_REPO
// (default 1 -- raise only with per-job workspace isolation), CONCURRENCY_GATE_REAP_TTL_MS
// (default 1800000).

export interface ConcurrencyGate {
  reserve(sid: string, opts: { repo?: string }): Promise<{ ok: boolean; reason?: string }>;
  release(sid: string): Promise<void>;
}

export interface ConcurrencyGateEnv {
  CONCURRENCY_GATE_MAX_GLOBAL?: string;
  /** Per-repo concurrency cap. Default 1 (same-branch protection: one in-flight job per clone).
   *  Raise ONLY if the host supports per-job isolated workspaces (else two jobs clobber one clone). */
  CONCURRENCY_GATE_MAX_PER_REPO?: string;
  /** Max age (ms) of an in-flight entry before the alarm reaper evicts it. Default 30 min.
   *  Bounds leaks from failed releases, reserve-then-throw, and orphaned sessions. */
  CONCURRENCY_GATE_REAP_TTL_MS?: string;
}

interface InFlightEntry {
  sid: string;
  repo?: string;
  since: number;
}

const DEFAULT_MAX_GLOBAL = 50;
const DEFAULT_MAX_PER_REPO = 1;
const DEFAULT_REAP_TTL_MS = 30 * 60_000;

export class ConcurrencyGateDO implements DurableObject {
  private state: DurableObjectState;
  private inFlight = new Map<string, InFlightEntry>();
  private readonly MAX_GLOBAL: number;
  private readonly MAX_PER_REPO: number;
  private readonly REAP_TTL_MS: number;

  constructor(state: DurableObjectState, env: ConcurrencyGateEnv) {
    this.state = state;
    this.MAX_GLOBAL = env.CONCURRENCY_GATE_MAX_GLOBAL ? parseInt(env.CONCURRENCY_GATE_MAX_GLOBAL, 10) : DEFAULT_MAX_GLOBAL;
    this.MAX_PER_REPO = env.CONCURRENCY_GATE_MAX_PER_REPO ? parseInt(env.CONCURRENCY_GATE_MAX_PER_REPO, 10) : DEFAULT_MAX_PER_REPO;
    this.REAP_TTL_MS = env.CONCURRENCY_GATE_REAP_TTL_MS ? parseInt(env.CONCURRENCY_GATE_REAP_TTL_MS, 10) : DEFAULT_REAP_TTL_MS;
  }

  async reserve(sid: string, opts: { repo?: string }): Promise<{ ok: boolean; reason?: string }> {
    // Opportunistic: drop stale entries before counting, and (re)arm the reaper alarm.
    await this.reap();
    await this.ensureAlarm();

    // Global cap
    if (this.inFlight.size >= this.MAX_GLOBAL) {
      return { ok: false, reason: "global_cap_exceeded" };
    }

    // Per-repo cap (if repo specified). Exclude the caller's own prior entry so a re-reserve
    // (e.g. a queue retry for the same sid) refreshes its slot instead of deadlocking on itself.
    if (opts.repo) {
      let repoCount = 0;
      for (const entry of this.inFlight.values()) {
        if (entry.repo === opts.repo && entry.sid !== sid) {
          repoCount++;
          if (repoCount >= this.MAX_PER_REPO) {
            return { ok: false, reason: "repo_slot_held" };
          }
        }
      }
    }

    // Reserve (or refresh) the slot
    this.inFlight.set(sid, { sid, repo: opts.repo, since: Date.now() });
    await this.persist();
    return { ok: true };
  }

  async release(sid: string): Promise<void> {
    if (this.inFlight.delete(sid)) {
      await this.persist();
    }
  }

  /** Alarm handler: reap stale entries and reschedule. Bounds every leak path to a finite TTL. */
  async alarm(): Promise<void> {
    await this.reap();
    await this.state.storage.setAlarm(Date.now() + this.REAP_TTL_MS);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + this.REAP_TTL_MS);
    }
  }

  /** Evict in-flight entries older than the TTL. */
  private async reap(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [sid, entry] of this.inFlight) {
      if (now - entry.since > this.REAP_TTL_MS) {
        this.inFlight.delete(sid);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.storage.put({ inFlight: Array.from(this.inFlight.entries()) });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    let body: unknown;
    try {
      body = await request.json();
    } catch (err) {
      return Response.json({ error: "invalid_json", detail: String(err) }, { status: 400 });
    }

    if (path === "/reserve" && request.method === "POST") {
      const { sid, repo } = body as { sid?: string; repo?: string };
      if (!sid) return Response.json({ error: "missing_sid" }, { status: 400 });
      const result = await this.reserve(sid, { repo });
      return Response.json(result);
    }

    if (path === "/release" && request.method === "POST") {
      const { sid } = body as { sid?: string };
      if (!sid) return Response.json({ error: "missing_sid" }, { status: 400 });
      await this.release(sid);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "unknown_action" }, { status: 400 });
  }
}
