// ConcurrencyGate Durable Object -- enforces global and per-repo concurrency caps.
//
// Single-writer semantics (DO serializes requests) = race-safe. The DO maintains an
// in-flight set tracking all active sessions. Global cap leaves headroom under the
// ~750-CPU account ceiling; per-repo cap of 1 preserves edison's project-slot /
// same-branch protection (two jobs on the same repo must not run concurrently).

export interface ConcurrencyGate {
  reserve(sid: string, opts: { repo?: string; squad?: string }): Promise<{ ok: boolean; reason?: string }>;
  release(sid: string): Promise<void>;
}

export interface ConcurrencyGateEnv {
  CONCURRENCY_GATE_MAX_GLOBAL?: string;
}

interface InFlightEntry {
  sid: string;
  repo?: string;
  squad?: string;
  since: number;
}

export class ConcurrencyGateDO implements DurableObject {
  private state: DurableObjectState;
  private inFlight = new Map<string, InFlightEntry>();

  // Default global cap: 50 (leaves headroom under ~750 CPU account ceiling)
  // Configurable via env.CONCURRENCY_GATE_MAX_GLOBAL env var.
  private MAX_GLOBAL: number;
  // Per-repo cap: 1 (preserves edison's project-slot / same-branch protection)
  private readonly MAX_PER_REPO = 1;

  constructor(state: DurableObjectState, env: ConcurrencyGateEnv) {
    this.state = state;
    this.MAX_GLOBAL = env.CONCURRENCY_GATE_MAX_GLOBAL ? parseInt(env.CONCURRENCY_GATE_MAX_GLOBAL, 10) : 50;
  }

  async reserve(sid: string, opts: { repo?: string; squad?: string }): Promise<{ ok: boolean; reason?: string }> {
    // Check global cap
    if (this.inFlight.size >= this.MAX_GLOBAL) {
      return { ok: false, reason: "global_cap_exceeded" };
    }

    // Check per-repo cap (if repo specified) - preserves edison's project-slot protection
    if (opts.repo) {
      let repoCount = 0;
      for (const entry of this.inFlight.values()) {
        if (entry.repo === opts.repo) {
          repoCount++;
          if (repoCount >= this.MAX_PER_REPO) {
            return { ok: false, reason: "repo_slot_held" };
          }
        }
      }
    }

    // Reserve the slot
    this.inFlight.set(sid, { sid, repo: opts.repo, squad: opts.squad, since: Date.now() });
    await this.persist();
    return { ok: true };
  }

  async release(sid: string): Promise<void> {
    if (this.inFlight.delete(sid)) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.state.storage.put({ inFlight: Array.from(this.inFlight.entries()) });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/reserve" && request.method === "POST") {
      const { sid, repo, squad } = await request.json() as { sid: string; repo?: string; squad?: string };
      const result = await this.reserve(sid, { repo, squad });
      return Response.json(result);
    }

    if (path === "/release" && request.method === "POST") {
      const { sid } = await request.json() as { sid: string };
      await this.release(sid);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "unknown_action" }, { status: 400 });
  }
}
