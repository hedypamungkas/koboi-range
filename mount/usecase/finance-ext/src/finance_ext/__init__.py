"""finance_ext -- Ledgerline Manufacturing invoice reconciliation extension.

Adds one local DESTRUCTIVE tool (``post_journal_entry``) and one audit hook
(``InvoiceAuditHook``) on top of stock koboi-agent. Read-side ERP access
comes from ``erp_mcp_server.py``, connected as an MCP stdio server.
"""
