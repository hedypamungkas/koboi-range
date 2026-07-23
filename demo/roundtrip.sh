#!/usr/bin/env bash
# demo/roundtrip.sh -- drive one koboi-range ride through the full t0->t4 lifecycle.
#
# Usage: ./demo/roundtrip.sh <OUTRIDER_URL> <SESSION_ID>
#   e.g. ./demo/roundtrip.sh https://koboi-range-outrider.<acct>.workers.dev demo-1
#
# Requires a deployed Outrider (see README "Deploy"). This script exercises the
# /lifecycle/* control API + the cron heartbeat; it does NOT drive the chat path
# (that's the Wave-0 placeholder in the Outrider). The point is to prove a koboi
# session survives dismount -> remount.
set -euo pipefail

OUTRIDER="${1:?usage: $0 <OUTRIDER_URL> <SESSION_ID>}"
SID="${2:?usage: $0 <OUTRIDER_URL> <SESSION_ID>}"

say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
get() { curl -fsS "$OUTRIDER/lifecycle/status/$SID"; }

say "t0 — RIDE: start Mount for session $SID (restores a Saddlebag if one exists)"
curl -fsS -X POST "$OUTRIDER/lifecycle/ride/$SID" | tee /dev/stderr >/dev/null
get

say "t1 — koboi hits post_journal_entry (DESTRUCTIVE) -> session goes awaiting_human"
say "    (in a real run koboi's jobs/handover webhook fires /lifecycle/observe;"
say "     here we simulate the controller-pending observation directly)"
curl -fsS -X POST "$OUTRIDER/lifecycle/observe/$SID" \
  -H 'content-type: application/json' \
  -d '{"status":"awaiting_human"}' | tee /dev/stderr >/dev/null
get

say "t2 — DISMOUNT: snapshot /data -> R2 Saddlebag, Mount scales to zero (~\$0)"
curl -fsS -X POST "$OUTRIDER/lifecycle/dismount/$SID" | tee /dev/stderr >/dev/null
get
say "    ...session now off the Range. Imagine the controller reviewing overnight..."

say "t3 — REMOUNT: controller approved -> fresh Mount + restoreBackup + koboi resume"
curl -fsS -X POST "$OUTRIDER/lifecycle/remount/$SID" | tee /dev/stderr >/dev/null
get

say "t4 — RETIRE: run done -> drop Mount + Saddlebag"
curl -fsS -X POST "$OUTRIDER/lifecycle/retire/$SID" | tee /dev/stderr >/dev/null
say "done. If each step returned status without error, the round-trip survived."
