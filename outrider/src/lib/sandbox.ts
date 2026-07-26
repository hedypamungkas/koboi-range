// Range <-> Cloudflare Sandbox SDK glue + koboi-agent 0.19.1 suspend/resume wiring.
//
// ROOT-CAUSE FIX (2026-07-24): DO.fetch(req) is SDK RPC, NOT HTTP-to-container -- using it for
// /healthz hung the ride. The control plane now stays ENTIRELY on SDK RPC, which is guaranteed
// to work on .workers.dev (no tunnel/exposePort/custom-domain/cloudflared needed):
//   - readiness: proc.waitForPort(8000, {path:'/healthz', status:200})  (SDK-internal port check)
//   - /suspend + session create/verify: httpInMount() runs a one-shot HTTP call FROM INSIDE the
//     container (localhost:8000) via sb.exec -- RPC, not Worker->container HTTP.
// Live-token streaming (data plane): proxyToSandbox + exposePort(8000) -> stable per-session preview URL (Wave-1).
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
  /** Worker's public hostname (custom domain) -- exposePort() mints the streaming preview URL under it. */
  PUBLIC_DOMAIN: string;
  // LLM secrets for the Mount (set via `wrangler secret put`). Worker secrets do NOT auto-reach the
  // container in this Sandbox-SDK setup, so startServe injects them into the koboi process env.
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODEL: string;
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

/** Stable preview-URL token for `sid`. The SDK requires `[a-z0-9_]{1,16}`; raw session ids violate
 *  that (hyphens, length), so sanitize deterministically -> the URL is predictable AND identical
 *  across remounts (proxyToSandbox re-activates the same URL each ride/remount). */
export function streamToken(sid: string): string {
  return sid.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 16) || "s";
}

/** Expose koboi serve's streaming port on a stable per-session preview URL. Per the SDK, forwarding
 *  is active only for the runtime where it was last called -> re-invoke on every ride/remount.
 *  Returns the minted URL (https://<port>-<sid>-<token>.<PUBLIC_DOMAIN>). */
export async function exposeStream(sb: Sandbox, env: Env, sid: string): Promise<string> {
  const { url } = await sb.exposePort(MOUNT_PORT, { hostname: env.PUBLIC_DOMAIN, token: streamToken(sid) });
  return url;
}

/** One-shot HTTP call to koboi serve FROM INSIDE the Mount (localhost) via SDK exec (RPC).
 *  Sidesteps the Worker->container HTTP problem entirely. Returns {status, body}.
 *  `body` (optional) is JSON-encoded, base64-wrapped, and sent with Content-Type: application/json
 *  (base64 keeps it shell-safe and lets any UTF-8 -- emoji/CJK -- round-trip). `timeoutMs` is the
 *  budget for BOTH the SDK exec wrapper AND the in-container urllib read: it is threaded into the
 *  Python `urllib.request.urlopen(timeout=...)`, so raising it actually extends the HTTP call -- the
 *  first /v1/jobs submit needs the headroom because pool.get_or_create builds the agent + MCP server. */
function b64encodeUtf8(s: string): string {
  // btoa is Latin1-only; encode UTF-8 -> bytes -> binary string -> base64 so non-ASCII chat works.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function httpInMount(
  sb: Sandbox,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30000,
): Promise<{ status: number; body: unknown }> {
  const hasBody = body !== undefined;
  const bodyB64 = hasBody ? b64encodeUtf8(JSON.stringify(body)) : "";
  const httpTimeoutSec = Math.max(1, Math.floor(timeoutMs / 1000));
  const py = [
    "import json,urllib.request,urllib.error,base64",
    `url="http://localhost:${MOUNT_PORT}${path}"`,
    hasBody ? `data=base64.b64decode("${bodyB64}")` : "data=None",
    `req=urllib.request.Request(url,data=data,method="${method}")`,
    hasBody ? `req.add_header("Content-Type","application/json")` : "pass",
    "try:",
    `  r=urllib.request.urlopen(req,timeout=${httpTimeoutSec}); print(json.dumps({'status':r.status,'body':json.loads(r.read().decode() or 'null')}))`,
    "except urllib.error.HTTPError as e:",
    "  raw=e.read()",
    "  try: body=json.loads(raw.decode() or 'null')",
    "  except Exception: body=raw.decode('utf-8','replace')",
    "  print(json.dumps({'status':e.code,'body':body}))",
    "except Exception as e: print(json.dumps({'status':0,'body':'ERR: '+str(e)}))",
  ].join("\n");
  const b64 = b64encodeUtf8(py);
  // Pad the exec budget so the in-container urllib timeout (the real cause) surfaces in the result
  // before the SDK kills the exec -- otherwise a slow koboi races the kill and the ERR is lost.
  const res = await sb.exec(`python3 -c "import base64;exec(base64.b64decode('${b64}'))"`, { timeout: timeoutMs + 2000 });
  // A non-zero exit (python3 missing / OOM / SDK RPC failure) leaves no JSON line -- surface stderr.
  if (res.exitCode !== 0) {
    return { status: 0, body: `exec exit ${res.exitCode}: stderr=${(res.stderr || "").trim().slice(0, 400)}` };
  }
  const line = (res.stdout || "").trim().split("\n").pop() || "{}";
  try {
    return JSON.parse(line) as { status: number; body: unknown };
  } catch {
    // Include stderr so a Python traceback (the real cause) isn't lost behind an empty parse error.
    return {
      status: 0,
      body: `parse error: stdout=${(res.stdout || "").slice(0, 200)} stderr=${(res.stderr || "").slice(0, 200)}`,
    };
  }
}

async function startServe(sb: Sandbox, env: Env): Promise<Process> {
  // Inject the LLM secrets into the koboi serve process env. Worker secrets (`wrangler secret put`)
  // do not auto-propagate to the container in this Sandbox-SDK setup; prefixing the shell command sets
  // them for the koboi process. Single-quoted -- API keys / base_urls are [A-Za-z0-9._:/-], safe.
  const llmEnv = [
    `OPENAI_API_KEY='${env.OPENAI_API_KEY ?? ""}'`,
    `OPENAI_BASE_URL='${env.OPENAI_BASE_URL ?? ""}'`,
    `OPENAI_MODEL='${env.OPENAI_MODEL ?? ""}'`,
  ].join(" ");
  // --host 0.0.0.0 is REQUIRED: koboi serve defaults to 127.0.0.1, which httpInMount/waitReady reach
  // via localhost, but the SDK's preview-forward (proxyToSandbox) connects via the container's network
  // IP (e.g. 10.0.0.1:8000) -- localhost-only bind => "container is not listening in TCP address".
  return sb.startProcess(`${llmEnv} koboi serve ${mountConfig(env)} --host 0.0.0.0 --port ${MOUNT_PORT}`);
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
export async function ride(env: Env, sessionId: string, saddlebag?: DirectoryBackup | null): Promise<string> {
  const sb = mount(env, sessionId);
  if (saddlebag) {
    await sb.restoreBackup(saddlebag);
    await swapSnapshot(sb, sessionId);
  }
  await waitReady(await startServe(sb, env));
  return exposeStream(sb, env, sessionId); // (re)activate the streaming preview URL for this runtime
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

export interface KoboiJobSubmit {
  message: string; // non-empty enforced by the POST /lifecycle/chat handler
  mode?: string; // omit -> server uses the config default (finance.yaml mode: act)
  max_iterations?: number;
}

/** koboi job lifecycle states (koboi 0.19.1 GET /v1/jobs/{id}). The const array is the single source
 *  of truth: the type is derived from it, and callers build a runtime Set to validate wire bodies
 *  (the `as JobStatusResponse` cast is compile-time only). */
export const KOBOI_JOB_STATUSES = [
  "reserved",
  "pending",
  "running",
  "completed",
  "cancelled",
  "timed_out",
  "awaiting_human",
  "failed",
] as const;
export type KoboiJobStatus = (typeof KOBOI_JOB_STATUSES)[number];

export interface KoboiJobHandle {
  job_id: string;
  status: KoboiJobStatus; // "pending" on a fresh submit
  session_id: string;
}

/** GET /v1/jobs/{id} response body. */
export interface JobStatusResponse {
  job_id: string;
  status: KoboiJobStatus;
  session_id: string;
  result?: unknown;
  error?: string;
  error_class?: string;
  retriable?: boolean;
}

/** Submit an async chat job (POST /v1/jobs) that CONTINUES session `koboiSid` -- the key to
 *  conversation continuity across suspend/resume. On koboi 0.19.1 a plain job also materializes the
 *  pooled agent at submit, after which GET /v1/sessions/{id} returns 200 instead of 404.
 *  Returns the job handle; the caller polls with pollChatJob(). */
export async function submitChatJob(
  env: Env,
  sessionId: string,
  koboiSid: string,
  job: KoboiJobSubmit,
): Promise<KoboiJobHandle> {
  const out = await httpInMount(
    mount(env, sessionId),
    "POST",
    "/v1/jobs",
    { message: job.message, session_id: koboiSid, mode: job.mode, max_iterations: job.max_iterations },
    60000, // first submit builds the agent + MCP server -- give it headroom (now also extends the urllib read)
  );
  if (out.status !== 202) {
    throw new Error(`/v1/jobs returned ${out.status}: ${JSON.stringify(out.body).slice(0, 200)}`);
  }
  const h = out.body as KoboiJobHandle;
  if (!h?.job_id) throw new Error(`/v1/jobs: no job_id in ${JSON.stringify(out.body).slice(0, 200)}`);
  return h;
}

/** Poll a koboi job (GET /v1/jobs/{id}). Returns the HTTP status + JobStatusResponse body; throws
 *  on any non-200 so callers don't mistake a transport failure (status 0) for a koboi response. */
export async function pollChatJob(
  env: Env,
  sessionId: string,
  jobId: string,
): Promise<{ status: number; body: JobStatusResponse }> {
  const out = await httpInMount(mount(env, sessionId), "GET", `/v1/jobs/${encodeURIComponent(jobId)}`);
  if (out.status !== 200) {
    throw new Error(`/v1/jobs/${jobId} returned ${out.status}: ${JSON.stringify(out.body).slice(0, 200)}`);
  }
  return out as { status: number; body: JobStatusResponse };
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
    localBucket: true, // use the BACKUP_BUCKET R2 binding directly (no presigned R2 creds needed)
  } satisfies BackupOptions);
  await stopServe(sb);
  return { backup, checkpoint: body.checkpoint, snapshotPath: body.snapshot_path };
}

/** REMOUNT: stop any lingering serve -> restore Saddlebag -> swap -> start serve -> ready. */
export async function remount(env: Env, sessionId: string, saddlebag: DirectoryBackup): Promise<string> {
  const sb = mount(env, sessionId);
  await stopServe(sb);
  await sb.restoreBackup(saddlebag);
  await swapSnapshot(sb, sessionId);
  await waitReady(await startServe(sb, env));
  return exposeStream(sb, env, sessionId); // re-activate the SAME preview URL for the fresh runtime
}

/** Verify: GET the koboi session's messages (proves the restored/swapped DB is live). */
export async function sessionMessages(env: Env, _sessionId: string, koboiSid: string): Promise<{ status: number; body: unknown }> {
  return httpInMount(mount(env, _sessionId), "GET", `/v1/sessions/${encodeURIComponent(koboiSid)}`);
}

/** RETIRE: revoke the preview URL + stop serve. (The Saddlebag-record drop is registry-side, in
 *  the caller; explicit container destroy = Wave-1b.) `unexposePort` is idempotent DO-state cleanup
 *  -- the SDK does not contact/wake/probe the container for it, so it's safe even if the port was
 *  never exposed or the container is already gone. */
export async function retire(env: Env, sessionId: string, saddlebag?: DirectoryBackup | null) {
  const sb = mount(env, sessionId);
  try {
    await sb.unexposePort(MOUNT_PORT); // revoke the streaming preview URL (best-effort, idempotent)
  } catch {
    /* port may never have been exposed, or the DO is already gone */
  }
  try {
    await stopServe(sb);
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
