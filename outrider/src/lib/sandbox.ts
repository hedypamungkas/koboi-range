// Range <-> Cloudflare Sandbox SDK glue.
//
// Verified against @cloudflare/sandbox@0.12.4 dist types (2026-07-23):
//   getSandbox<T extends Sandbox<any>>(ns: DurableObjectNamespace<T>, id): T
//   sb.createBackup(options: BackupOptions): Promise<DirectoryBackup>
//   sb.restoreBackup(backup: DirectoryBackup): Promise<RestoreBackupResult>
//   class Sandbox<Env> extends Container<Env> implements ISandbox  -> it IS the Durable Object.
import { getSandbox } from "@cloudflare/sandbox";
import type { Sandbox, DirectoryBackup, BackupOptions } from "@cloudflare/sandbox";

export interface Env {
  // The per-session Mount DO namespace. (SandboxEnv = { Sandbox: DurableObjectNamespace<Sandbox> })
  Sandbox: DurableObjectNamespace<Sandbox>;
  RANGE_KV: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  MOUNT_CONFIG: string;
}

// The "Saddlebag" root. BackupOptions.dir MUST be one of the SDK's allowed roots:
//   /workspace | /home | /tmp | /var/tmp | /app   (NOT /data).
// We use /workspace (the Sandbox canonical cwd) and root koboi's DB + workdir there
// so ONE createBackup({dir}) captures the whole ride.
export const SADDLEBAG_DIR = "/workspace";
const SADDLEBAG_TTL_SEC = 7 * 24 * 3600; // 7-day auto-GC backstop for Retire

/** A Mount = the per-session Sandbox/container, named by session id. */
export function mount(env: Env, sessionId: string): Sandbox {
  return getSandbox(env.Sandbox, sessionId);
}

/** RIDE: ensure the Mount is up. Restore a prior Saddlebag first if present,
 *  so the koboi session comes back with its /workspace (DB + journal + workdir). */
export async function ride(env: Env, sessionId: string, saddlebag?: DirectoryBackup | null) {
  const sb = mount(env, sessionId);
  if (saddlebag) await sb.restoreBackup(saddlebag);
  return sb;
}

/** DISMOUNT: snapshot /workspace -> R2 Saddlebag. Returns the DirectoryBackup handle
 *  (caller persists it to RANGE_KV).
 *
 *  Wave-0 does NOT WAL-quiesce before snapshot -- safe ONLY because the Outrider
 *  dismounts at session-idle (no SQLite writer in flight). Production should call
 *  the koboi-core `quiesce()` helper (a follow-up PR) first. See README caveats. */
export async function dismount(env: Env, sessionId: string): Promise<DirectoryBackup> {
  const sb = mount(env, sessionId);
  return sb.createBackup({
    dir: SADDLEBAG_DIR,
    name: sessionId,
    ttl: SADDLEBAG_TTL_SEC,
  } satisfies BackupOptions);
}

/** REMOUNT: fresh container + restore the Saddlebag. koboi's `resume_on_startup`
 *  (autonomous jobs) or `POST /v1/sessions/:id/resume` (interactive) rehydrates
 *  the interrupted turn from the restored steps journal. */
export async function remount(env: Env, sessionId: string, saddlebag: DirectoryBackup) {
  const sb = mount(env, sessionId);
  await sb.restoreBackup(saddlebag);
  return sb;
}

/** RETIRE: drop the Mount + its Saddlebag.
 *  The Saddlebag auto-GCs after SADDLEBAG_TTL_SEC; explicit per-instance teardown
 *  (sb.stop() / container destroy) is a Wave-1b hardening -- CF container
 *  idle-scale-to-zero + the TTL backstop handle the rest for Wave-0. */
export async function retire(_env: Env, sessionId: string, saddlebag?: DirectoryBackup | null) {
  return { retired: true, sessionId, hadSaddlebag: Boolean(saddlebag) };
}
