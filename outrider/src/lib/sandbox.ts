// Range <-> Cloudflare Sandbox SDK glue + koboi-agent 0.19.1 suspend/resume wiring.
//
// ROOT-CAUSE FIX (2026-07-24): DO.fetch(req) is SDK RPC, NOT HTTP-to-container -- using it for
// /healthz hung the ride. The control plane now stays ENTIRELY on SDK RPC, which is guaranteed
// to work on .workers.dev (no tunnel/exposePort/custom-domain/cloudflared needed):
//   - readiness: proc.waitForPort(8000, {path:'/healthz', status:200})  (SDK-internal port check)
//   - /suspend + session create/verify: httpInMount() runs a one-shot HTTP call FROM INSIDE the
//     container (localhost:8000) via sb.exec -- RPC, not Worker->container HTTP.
// Client chat streaming (data plane) needs a public Mount URL (tunnel/exposePort) -> Wave-1.
//
// Verified against @cloudflare/sandbox@0.12.4: getSandbox, createBackup, restoreBackup,
// startProcess->Process.waitForPort, exec. koboi 0.19.1: POST /v1/sessions/{id}/suspend ->
// {snapshot_path:`{db}.{sid}.suspend.db`, snapshot_bytes, checkpoint}; consistent_backup is
// atomicity-independent. koboi serve opens shared_db EAGERLY at boot, so the resume swap MUST
// happen before koboi serve starts -> keep-alive Mount + Outrider-owned serve lifecycle.
import { getSandbox } from "@cloudflare/sandbox";
import type { Sandbox, DirectoryBackup, BackupOptions, Process } from "@cloudflare/sandbox";

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  RANGE_KV: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  BACKUP_BUCKET_NAME: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  MOUNT_CONFIG: string;
}

export const SADDLEBAG_DIR = "/workspace";
const SADDLEBAG_TTL_SEC = 7 * 24 * 3600;
const MOUNT_PORT = 8000;
const MOUNT_DB = "/workspace/koboi_memory.db";
const mountConfig = (env: Env) => env.MOUNT_CONFIG || "/app/config/finance.yaml";

/** A Mount = the per-session Sandbox/container, named by session id. */
export function mount(env: Env, sessionId: string): Sandbox {
  return getSandbox(env.Sandbox, sessionId);
}

/** One-shot HTTP call to koboi serve FROM INSIDE the Mount (localhost) via SDK exec (RPC).
 *  Sidesteps the Worker->container HTTP problem entirely. Returns {status, body}. */
async function httpInMount(sb: Sandbox, method: string, path: string): Promise<{ status: number; body: unknown }> {
  const py = [
    "import json,urllib.request,urllib.error",
    `url="http://localhost:${MOUNT_PORT}${path}"`,
    `req=urllib.request.Request(url,method="${method}")`,
    "try:",
    "  r=urllib.request.urlopen(req,timeout=20); print(json.dumps({'status':r.status,'body':json.loads(r.read().decode() or 'null')}))",
    "except urllib.error.HTTPError as e: print(json.dumps({'status':e.code,'body':e.read().decode()}))",
    "except Exception as e: print(json.dumps({'status':0,'body':'ERR: '+str(e)}))",
  ].join("\n");
  const b64 = btoa(py);
  const res = await sb.exec(`python3 -c "import base64;exec(base64.b64decode('${b64}'))"`, { timeout: 30000 });
  const line = (res.stdout || "").trim().split("\n").pop() || "{}";
  try {
    return JSON.parse(line) as { status: number; body: unknown };
  } catch {
    return { status: 0, body: `parse error: ${(res.stdout || "").slice(0, 200)}` };
  }
}

async function startServe(sb: Sandbox, env: Env): Promise<Process> {
  return sb.startProcess(`koboi serve ${mountConfig(env)}`);
}

/** Wait for koboi serve's /healthz via the SDK's internal port check (not Worker HTTP). */
async function waitReady(proc: Process): Promise<void> {
  await proc.waitForPort(MOUNT_PORT, { path: "/healthz", status: 200 });
}

async function stopServe(sb: Sandbox): Promise<void> {
  await sb.exec("pkill -TERM -f 'koboi serve' || true", { timeout: 15000 });
}

async function swapSnapshot(sb: Sandbox, sid: string): Promise<void> {
  const snap = `${MOUNT_DB}.${sid}.suspend.db`;
  await sb.exec(
    `sh -c 'rm -f ${MOUNT_DB} ${MOUNT_DB}-wal ${MOUNT_DB}-shm; [ -f ${snap} ] && mv ${snap} ${MOUNT_DB} || true'`,
    { timeout: 15000 },
  );
}

/** RIDE: boot the Mount (keep-alive), restore+swap a prior Saddlebag if present, start koboi
 *  serve, wait for readiness. (First ride: no saddlebag -> fresh DB, no swap.) */
export async function ride(env: Env, sessionId: string, saddlebag?: DirectoryBackup | null): Promise<void> {
  const sb = mount(env, sessionId);
  if (saddlebag) {
    await sb.restoreBackup(saddlebag);
    await swapSnapshot(sb, sessionId);
  }
  await waitReady(await startServe(sb, env));
}

/** Create a koboi session inside the Mount; returns the koboi session_id. */
export async function createSession(env: Env, sessionId: string): Promise<string> {
  const out = await httpInMount(mount(env, sessionId), "POST", "/v1/sessions");
  if (out.status !== 200 && out.status !== 201) {
    throw new Error(`createSession: ${out.status} ${JSON.stringify(out.body).slice(0, 200)}`);
  }
  const sid = (out.body as { session_id?: string }).session_id;
  if (!sid) throw new Error(`createSession: no session_id in ${JSON.stringify(out.body).slice(0, 200)}`);
  return sid;
}

export interface DismountResult {
  backup: DirectoryBackup;
  checkpoint: { ok: boolean; busy: number; log: number; checkpointed: number; error?: string };
  snapshotPath: string;
}

/** DISMOUNT: /suspend (writes the consistent snapshot) -> createBackup(/workspace) -> stop serve. */
export async function dismount(env: Env, sessionId: string, koboiSid: string): Promise<DismountResult> {
  const sb = mount(env, sessionId);
  const out = await httpInMount(sb, "POST", `/v1/sessions/${encodeURIComponent(koboiSid)}/suspend`);
  if (out.status !== 200) {
    throw new Error(`/suspend returned ${out.status}: ${JSON.stringify(out.body).slice(0, 200)}`);
  }
  const body = out.body as { snapshot_path: string; checkpoint: DismountResult["checkpoint"] };
  const backup = await sb.createBackup({
    dir: SADDLEBAG_DIR,
    name: sessionId,
    ttl: SADDLEBAG_TTL_SEC,
  } satisfies BackupOptions);
  await stopServe(sb);
  return { backup, checkpoint: body.checkpoint, snapshotPath: body.snapshot_path };
}

/** REMOUNT: stop any lingering serve -> restore Saddlebag -> swap -> start serve -> ready. */
export async function remount(env: Env, sessionId: string, saddlebag: DirectoryBackup): Promise<void> {
  const sb = mount(env, sessionId);
  await stopServe(sb);
  await sb.restoreBackup(saddlebag);
  await swapSnapshot(sb, sessionId);
  await waitReady(await startServe(sb, env));
}

/** Verify: GET the koboi session's messages (proves the restored/swapped DB is live). */
export async function sessionMessages(env: Env, _sessionId: string, koboiSid: string): Promise<{ status: number; body: unknown }> {
  return httpInMount(mount(env, _sessionId), "GET", `/v1/sessions/${encodeURIComponent(koboiSid)}`);
}

/** RETIRE: stop serve + drop the Saddlebag record. (Explicit container destroy = Wave-1b.) */
export async function retire(env: Env, sessionId: string, saddlebag?: DirectoryBackup | null) {
  try {
    await stopServe(mount(env, sessionId));
  } catch {
    /* best-effort */
  }
  return { retired: true, sessionId, hadSaddlebag: Boolean(saddlebag) };
}

/** PROOF: `echo hi` via SDK exec -- the RC2 isolation diagnostic (does container RPC respond?). */
export async function pingMount(env: Env, sid: string): Promise<string> {
  const r = await mount(env, sid).exec("echo hi", { timeout: 15000 });
  return (r.stdout || "").trim();
}

/** PROOF: run the finance reconcile INSIDE the Mount via `koboi run` (the real LLM call happens
 *  in-container). Non-interactive CLI run; returns the agent's reconcile result via exec stdout. */
export async function runReconcile(
  env: Env,
  sid: string,
  message = "Reconcile invoice INV-8842 against PO-4471 using the ERP tools "
    + "(fetch_invoice, fetch_purchase_order, three_way_match) and report the result.",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const safe = message.replace(/'/g, `'\\''`); // single-quote-escape for the shell -m arg
  const r = await mount(env, sid).exec(`koboi run ${mountConfig(env)} -m '${safe}'`, { timeout: 180000 });
  return { exitCode: r.exitCode, stdout: r.stdout || "", stderr: (r.stderr || "").slice(0, 1000) };
}
