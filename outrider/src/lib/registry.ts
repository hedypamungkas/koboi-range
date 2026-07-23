// RANGE_KV session registry -- the Outrider's per-session memory.
// One record per session id: current Range status + the last Saddlebag handle.
import type { DirectoryBackup } from "@cloudflare/sandbox";

export type RangeStatus =
  | "riding" // Mount up, working
  | "awaiting_human" // pending_approval / idle -- candidate to dismount
  | "suspended" // dismounted, Saddlebag in R2 (~$0)
  | "resuming" // approved, about to remount
  | "done" // terminal -> retire
  | "error";

export interface SessionRecord {
  sessionId: string;
  status: RangeStatus;
  saddlebag?: DirectoryBackup | null; // the createBackup() handle (JSON-serializable)
  lastSeen: number; // ms epoch
  idleSince?: number | null; // ms epoch when it first went awaiting_human
  lastError?: string | null;
}

const PREFIX = "range:session:";

export async function get(env: { RANGE_KV: KVNamespace }, sid: string): Promise<SessionRecord | null> {
  const raw = await env.RANGE_KV.get(PREFIX + sid);
  return raw ? (JSON.parse(raw) as SessionRecord) : null;
}

export async function put(env: { RANGE_KV: KVNamespace }, rec: SessionRecord): Promise<void> {
  rec.lastSeen = Date.now();
  await env.RANGE_KV.put(PREFIX + rec.sessionId, JSON.stringify(rec));
}

export async function list(env: { RANGE_KV: KVNamespace }): Promise<SessionRecord[]> {
  // KV list is eventually consistent + paginated; fine for the Wave-0 proof.
  const out: SessionRecord[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.RANGE_KV.list({ prefix: PREFIX, cursor });
    for (const k of res.keys) {
      const raw = await env.RANGE_KV.get(k.name);
      if (raw) out.push(JSON.parse(raw) as SessionRecord);
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

export async function setStatus(
  env: { RANGE_KV: KVNamespace },
  sid: string,
  status: RangeStatus,
  patch: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const rec =
    (await get(env, sid)) ??
    ({ sessionId: sid, status, saddlebag: null, lastSeen: 0 } as SessionRecord);
  const prev = rec.status;
  rec.status = status;
  if (status === "awaiting_human" && prev !== "awaiting_human") rec.idleSince = Date.now();
  if (status === "riding") rec.idleSince = null;
  Object.assign(rec, patch);
  await put(env, rec);
  return rec;
}
