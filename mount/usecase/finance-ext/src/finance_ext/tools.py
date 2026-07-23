"""finance_ext/tools.py -- the one write kept local on purpose.

``post_journal_entry`` posts an approved amount to the general ledger. It is
kept as a local ``@tool()`` (rather than pulled in over MCP, like the
read-only ERP lookups) specifically so it can carry ``RiskLevel.DESTRUCTIVE``
and always hit koboi's human-approval pause. MCP tools default to SAFE
(koboi 0.18+ can risk-gate a whole server via ``mcp.servers[].risk_level``,
but a local ``@tool()`` is still the most direct way to mark this one write
DESTRUCTIVE), so the operation Ledgerline's controller must approve by hand
lives here instead of in ``erp_mcp_server.py``.
"""

from koboi.tools.registry import tool
from koboi.types import RiskLevel


@tool(
    name="post_journal_entry",
    description="Post an approved amount to the general ledger. Requires human approval.",
    parameters={
        "type": "object",
        "properties": {
            "invoice_id": {"type": "string", "description": "Invoice ID being posted, e.g. INV-8842"},
            "gl_account": {"type": "string", "description": "General ledger account code"},
            "amount": {"type": "number", "description": "Amount to post"},
        },
        "required": ["invoice_id", "gl_account", "amount"],
    },
    risk_level=RiskLevel.DESTRUCTIVE,
)
async def post_journal_entry(invoice_id: str, gl_account: str, amount: float) -> str:
    return f"Posted {amount} to {gl_account} for invoice {invoice_id} (mock -- no real ERP)."
