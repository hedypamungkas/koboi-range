"""finance_ext/hooks.py -- logs every tool call to an append-only audit file.

Fires for PRE_TOOL_USE and POST_TOOL_USE on every tool call regardless of
source -- the local ``post_journal_entry`` tool and the three MCP-sourced
ERP lookups (``fetch_invoice``, ``fetch_purchase_order``, ``three_way_match``)
alike, since hooks sit in the shared tool-execution pipeline and don't care
where a tool came from.

There is no YAML key for hooks (doc 00 Sec.5) -- this module is imported
once at startup and its hook instance is passed to
``koboi.server.app.create_app(cfg, extra_hooks=[...])`` directly, since there
is no bare ``koboi serve`` entrypoint that accepts custom hooks. See
``finance_ext/entrypoint.py``.

Known limitation: koboi's tool-execution pipeline resolves DESTRUCTIVE-risk
approval *before* PRE_TOOL_USE hooks run (risk/approval is step 3, this hook
is step 4 -- see koboi/loop_pipeline.py). A denied/timed-out approval returns
early and never reaches this hook, so a rejected ``post_journal_entry`` call
is NOT written to the audit trail -- only calls that clear approval (or
never needed it, i.e. the read-only ERP lookups) are. An auditor asking "what
did the controller reject" would need koboi's own approval/trust-DB records,
not this file, until/unless a future koboi version exposes an approval-outcome
hook event.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time

from koboi.hooks.chain import Hook, HookContext, HookEvent

AUDIT_LOG_PATH = os.environ.get("INVOICE_AUDIT_LOG", "/data/audit/invoice_audit.jsonl")
# Serializes concurrent appends from pooled sessions (this hook runs on every
# tool call across every session via asyncio.to_thread) so two large rows
# can't interleave their chunked BufferedWriter writes -- audit-trail P2.
_AUDIT_LOCK = threading.Lock()


def _as_json_value(s: str | None):
    """Best-effort parse a str that's usually already-JSON, for a readable log.

    ``HookContext.tool_arguments``/``.tool_result`` are plain ``str`` (the
    pipeline passes the tool call's raw JSON-arguments string and the tool's
    ``str`` return value) -- writing them into our row as-is and then
    ``json.dumps``-ing the whole row double-encodes anything that happens to
    already be JSON (e.g. arguments), which makes the log annoying to query
    with tools like ``jq``. Parse when possible so the row holds a nested
    object/value instead of an escaped string; fall back to the raw string
    for tool results that aren't JSON (e.g. ``three_way_match``'s plain-text
    "matched: ..." replies).
    """
    if s is None:
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return s


class InvoiceAuditHook(Hook):
    """Append-only JSONL audit trail for every tool call (priority 80: cleanup/audit tier)."""

    priority = 80

    def handles(self) -> list[HookEvent]:
        return [HookEvent.PRE_TOOL_USE, HookEvent.POST_TOOL_USE]

    async def execute(self, ctx: HookContext) -> HookContext:
        row = {
            "ts": time.time(),
            "event": ctx.event.value,
            "tool": ctx.tool_name,
            "args": _as_json_value(ctx.tool_arguments),
            "result": _as_json_value(ctx.tool_result) if ctx.event == HookEvent.POST_TOOL_USE else None,
        }
        # Blocking file I/O off the event loop -- this hook fires on every
        # tool call across every pooled session; a real deployment can have
        # several sessions in flight at once.
        await asyncio.to_thread(_append_row, row)
        return ctx


def _append_row(row: dict) -> None:
    # Lazy makedirs: was done at import time, which crashed the container boot
    # if /data/audit wasn't writable on first import (init/volume race) -- P1 bug G.
    os.makedirs(os.path.dirname(AUDIT_LOG_PATH) or ".", exist_ok=True)
    line = json.dumps(row)
    with _AUDIT_LOCK, open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")
