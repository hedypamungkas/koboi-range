#!/usr/bin/env bash
# demo/stream.sh -- prove live-token SSE streaming through the Wave-1 preview URL.
#
# Usage: ./demo/stream.sh <OUTRIDER_URL> <SESSION_ID> [message]
#   e.g. ./demo/stream.sh https://koboi-range-outrider.<acct>.workers.dev demo-stream-1 \
#          "Reconcile INV-8842 vs PO-4471 using the ERP tools."
#
# Flow:
#   t0  POST <OUTRIDER>/lifecycle/session/<sid>  -> boots the Mount, creates a koboi session,
#       and mints the per-session preview URL (proxyToSandbox + exposePort(8000)).
#   t1  curl -N the streamUrl  -> proxyToSandbox routes <port>-<sid>-<token>.<domain> straight to
#       the Mount's `koboi serve /v1/chat/stream`; SSE frames print token-by-token (-N = no buffer).
#
# Prereqs (the ONLY thing that needs a real deploy -- unit tests can't prove live bytes):
#   - a DEPLOYED Outrider (see README "Deploy");
#   - PUBLIC_DOMAIN set in wrangler.jsonc + wildcard DNS *.range.<domain> -> the Worker
#     (workers.dev alone does NOT route the <port>-<sid>-<token> subdomain -- that is the SDK's
#      CUSTOM_DOMAIN_REQUIRED constraint; without it, ride succeeds but the streamUrl won't resolve);
#   - the koboi/LLM secret (OPENAI_API_KEY / OPENAI_MODEL) on the Mount.
set -euo pipefail

OUTRIDER="${1:?usage: $0 <OUTRIDER_URL> <SESSION_ID> [message]}"
SID="${2:?usage: $0 <OUTRIDER_URL> <SESSION_ID> [message]}"
MESSAGE="${3:-Reconcile invoice INV-8842 against PO-4471 using the ERP tools (fetch_invoice, fetch_purchase_order, three_way_match) and report the result.}"

say() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p"; }

say "t0 — RIDE + create koboi session for $SID (mints the streaming preview URL)"
SESSION_JSON="$(curl -fsS -X POST "$OUTRIDER/lifecycle/session/$SID")"
printf '%s\n' "$SESSION_JSON" >&2
STREAM_URL="$(field "$SESSION_JSON" streamUrl)"
KOBOI_SID="$(field "$SESSION_JSON" koboiSessionId)"

if [ -z "$STREAM_URL" ]; then
  echo "✗ no streamUrl in the response -- is PUBLIC_DOMAIN set in wrangler.jsonc and the Worker deployed with it?" >&2
  exit 1
fi

say "t1 — STREAM: curl -N the preview URL (proxyToSandbox -> koboi serve /v1/chat/stream)"
echo "    url:     $STREAM_URL"
echo "    koboi session: ${KOBOI_SID:-<none>}"
echo "    message: $MESSAGE"
printf '\n\033[1;32m--- SSE stream (tokens should appear incrementally) ---\033[0m\n'

HDRS=(-H 'content-type: application/json' -H 'accept: text/event-stream')
[ -n "$KOBOI_SID" ] && HDRS+=(-H "X-Session-Id: $KOBOI_SID")
ESC_MSG="$(printf '%s' "$MESSAGE" | sed 's/\\/\\\\/g; s/"/\\"/g')"

# -N disables curl's output buffering -- the whole point: frames must flush as they arrive.
# streamUrl is the host root; append the koboi SSE endpoint path.
curl -N -sS -X POST "${STREAM_URL%/}/v1/chat/stream" "${HDRS[@]}" -d "{\"message\":\"$ESC_MSG\"}"
printf '\n\033[1;32m--- end stream ---\033[0m\n'

say "done. If the 'data: {...}' frames printed one-by-one (not as one blob), live-token streaming works."
