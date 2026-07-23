"""finance_ext/entrypoint.py -- custom server entrypoint that wires InvoiceAuditHook in.

There is no YAML/entry-point way to preload a custom hook into ``koboi
serve`` -- ``server.app.create_app()`` accepts ``extra_hooks=[...]`` as a
Python kwarg, so a config-driven ``koboi serve config/agent.yaml`` alone
cannot register ``InvoiceAuditHook``. This script is the container's ``CMD``
in place of the bare CLI, calling ``create_app`` directly.

Run: ``python -m finance_ext.entrypoint``
"""

from __future__ import annotations

import logging
import os

import uvicorn

from koboi.config import Config
from koboi.server.app import _build_key_store, create_app

from finance_ext.hooks import AUDIT_LOG_PATH, InvoiceAuditHook

_logger = logging.getLogger(__name__)

CONFIG_PATH = os.environ.get("KOBOI_CONFIG", "config/agent.yaml")
HOST = os.environ.get("HOST", "0.0.0.0")  # noqa: S104 -- intentional container bind
PORT = int(os.environ.get("PORT", "8000"))


def main() -> None:
    os.makedirs(os.path.dirname(AUDIT_LOG_PATH), exist_ok=True)

    cfg = Config.from_yaml(CONFIG_PATH)

    # koboi.server.app.serve_app() (the bare `koboi serve` path we're not using,
    # see module docstring) refuses to bind a non-loopback host when
    # auth_required=true and no API keys are configured, rather than silently
    # serving open (its "C1" check). Since this custom entrypoint replaces
    # serve_app entirely, that guard doesn't come for free -- reproduce it here
    # so flipping `server.auth_required: true` later (README says production
    # should) fails fast at boot instead of serving unauthenticated.
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        if cfg.get("server", "auth_required", default=True) and not _build_key_store(cfg).has_keys:
            raise SystemExit(
                f"Refusing to bind {HOST}:{PORT}: auth_required=true with no API keys configured "
                "would leave the server fully open. Run `koboi keys create`, set KOBOI_API_KEYS, "
                "or set server.auth_required:false only for local dev."
            )

    # AgentPool._build_agent (koboi/server/pool.py) wraps each extra_hooks entry
    # in a CallbackHook via KoboiAgent.add_hook(callback, events=...) -- it does
    # NOT accept a raw Hook subclass instance directly (that path is
    # `callable(hook_spec)`, which a plain Hook instance without __call__ isn't).
    # Passing (bound_method, events) reuses InvoiceAuditHook's real execute()
    # logic while satisfying that tuple contract.
    audit_hook = InvoiceAuditHook()
    app = create_app(cfg, extra_hooks=[(audit_hook.execute, audit_hook.handles())])

    _logger.info("Starting invoice-reconciliation server on %s:%s (audit log: %s)", HOST, PORT, AUDIT_LOG_PATH)
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
