"""erp_mcp_server.py -- mock ERP MCP server for Ledgerline invoice reconciliation.

Exposes three read-only operations over stdio JSON-RPC (mirrors
koboi-agent's ``mcp_servers/todo_server.py`` pattern exactly):

    fetch_invoice(invoice_id)        -- pull an invoice header + lines
    fetch_purchase_order(po_id)      -- pull a PO and its delivery record
    three_way_match(invoice_id, po_id) -- compare invoice vs PO vs delivery

There is no real ERP behind this -- a handful of sample invoices/POs are
hardcoded in-memory below so the demo has something concrete to reconcile.

DEPLOYMENT NOTE: the design doc (docs/03-finance-invoice-reconciliation.md)
describes this as a separately-deployed service reached over Streamable
HTTP. koboi-agent's only proven, working MCP example is the stdio
(subprocess) transport (see ``mcp_servers/todo_server.py`` upstream) -- there
is no verified Streamable-HTTP example to build against. For this runnable
demo we deliberately run this file as a stdio subprocess co-located in the
same container as koboi (see backend/Dockerfile + config/agent.yaml
``mcp.servers``). A production deployment would split this into its own
HTTP service, as the design doc intends.
"""

import json

from koboi.mcp.server import MCPServer

server = MCPServer(name="erp-mcp", version="1.0.0")

# --- Mock ERP data -----------------------------------------------------

_INVOICES: dict[str, dict] = {
    "INV-8842": {
        "invoice_id": "INV-8842",
        "vendor": "Alden Fasteners Co.",
        "po_id": "PO-4471",
        "amount": 4200.00,
        "currency": "USD",
        "lines": [
            {"sku": "FST-100", "qty": 2000, "unit_price": 1.75},
            {"sku": "FST-200", "qty": 500, "unit_price": 1.40},
        ],
    },
    "INV-9013": {
        "invoice_id": "INV-9013",
        "vendor": "Brightline Steel",
        "po_id": "PO-5502",
        "amount": 12800.00,
        "currency": "USD",
        "lines": [{"sku": "STL-COIL-A", "qty": 4, "unit_price": 3200.00}],
    },
    "INV-9104": {
        "invoice_id": "INV-9104",
        "vendor": "Coreway Machining",
        "po_id": "PO-5610",
        "amount": 990.00,
        "currency": "USD",
        "lines": [{"sku": "MCH-VLV-9", "qty": 30, "unit_price": 33.00}],
    },
}

_PURCHASE_ORDERS: dict[str, dict] = {
    "PO-4471": {
        "po_id": "PO-4471",
        "vendor": "Alden Fasteners Co.",
        "amount": 4200.00,
        "currency": "USD",
        "delivery": {"status": "received", "received_qty": {"FST-100": 2000, "FST-200": 500}},
    },
    "PO-5502": {
        "po_id": "PO-5502",
        "vendor": "Brightline Steel",
        "amount": 12800.00,
        "currency": "USD",
        "delivery": {"status": "received", "received_qty": {"STL-COIL-A": 4}},
    },
    "PO-5610": {
        "po_id": "PO-5610",
        "vendor": "Coreway Machining",
        "amount": 900.00,  # deliberately mismatched vs. invoice amount (990.00)
        "currency": "USD",
        "delivery": {"status": "partial", "received_qty": {"MCH-VLV-9": 27}},
    },
}


@server.tool(
    name="fetch_invoice",
    description="Fetch an invoice (header + lines) from the ERP by ID.",
    input_schema={
        "type": "object",
        "properties": {"invoice_id": {"type": "string", "description": "Invoice ID, e.g. INV-8842"}},
        "required": ["invoice_id"],
    },
)
def fetch_invoice(invoice_id: str) -> str:
    invoice = _INVOICES.get(invoice_id)
    if invoice is None:
        return f"Error: invoice {invoice_id!r} not found"
    return json.dumps(invoice)


@server.tool(
    name="fetch_purchase_order",
    description="Fetch a purchase order and its delivery record from the ERP by PO number.",
    input_schema={
        "type": "object",
        "properties": {"po_id": {"type": "string", "description": "Purchase order ID, e.g. PO-4471"}},
        "required": ["po_id"],
    },
)
def fetch_purchase_order(po_id: str) -> str:
    po = _PURCHASE_ORDERS.get(po_id)
    if po is None:
        return f"Error: purchase order {po_id!r} not found"
    return json.dumps(po)


@server.tool(
    name="three_way_match",
    description=(
        "Compare an invoice against its purchase order and delivery record. "
        "Returns 'matched' if amounts and received quantities line up, or "
        "'mismatch: <reason>' describing the first discrepancy found."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "invoice_id": {"type": "string", "description": "Invoice ID, e.g. INV-8842"},
            "po_id": {"type": "string", "description": "Purchase order ID, e.g. PO-4471"},
        },
        "required": ["invoice_id", "po_id"],
    },
)
def three_way_match(invoice_id: str, po_id: str) -> str:
    invoice = _INVOICES.get(invoice_id)
    if invoice is None:
        return f"Error: invoice {invoice_id!r} not found"
    po = _PURCHASE_ORDERS.get(po_id)
    if po is None:
        return f"Error: purchase order {po_id!r} not found"

    if invoice.get("po_id") != po_id:
        return f"mismatch: invoice {invoice_id} references {invoice.get('po_id')}, not {po_id}"

    if invoice["amount"] != po["amount"]:
        return (
            f"mismatch: invoice amount {invoice['amount']} {invoice['currency']} does not match "
            f"PO amount {po['amount']} {po['currency']}"
        )

    delivery = po.get("delivery", {})
    if delivery.get("status") != "received":
        return f"mismatch: delivery status is {delivery.get('status', 'unknown')!r}, not fully received"

    received_qty = delivery.get("received_qty", {})
    for line in invoice.get("lines", []):
        sku = line["sku"]
        if received_qty.get(sku, 0) < line["qty"]:
            return (
                f"mismatch: SKU {sku} short-shipped -- invoiced {line['qty']}, "
                f"received {received_qty.get(sku, 0)}"
            )

    return f"matched: invoice {invoice_id} reconciles against {po_id} ({invoice['amount']} {invoice['currency']})"


if __name__ == "__main__":
    server.run()
