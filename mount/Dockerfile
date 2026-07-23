# mount/Dockerfile -- "the Mount": a single-session koboi server container.
#
# One Mount is drawn per agent session (named by session id) by the Outrider.
# Mirrors the proven image in koboi-use-cases/finance-reconciliation/backend/Dockerfile.
# Build context = this `mount/` directory (see outrider/wrangler.jsonc -> containers[].image).
FROM python:3.12-slim

# Pin to the latest koboi-agent released on PyPI (>=0.18.2). Bump to match the
# version you actually want to ride on the Range.
ARG KOBOI_AGENT_VERSION=0.19.0

WORKDIR /app

# git: sandbox.git_init seeds each session workdir as a git repo (audit trail) -- needs the binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "koboi-agent[api]==${KOBOI_AGENT_VERSION}"

# --- use-case code (demo: Ledgerline invoice reconciliation) -----------------
# In a real Range deploy these come from YOUR repo. Vendored here so the Wave-0
# image builds and runs end-to-end. finance-ext provides the tools + the stdio
# ERP MCP server referenced by configs/finance.yaml.
COPY usecase/finance-ext/pyproject.toml ./pyproject.toml
COPY usecase/finance-ext/src ./src
COPY usecase/finance-ext/erp_mcp_server.py ./erp_mcp_server.py
RUN pip install --no-cache-dir -e .

# koboi config (single-session, /workspace as the snapshotted root).
COPY configs/finance.yaml /app/config/finance.yaml

# /workspace is the "Saddlebag" root: koboi_memory.db (WAL) + steps journal + audit git
# all live here, so ONE createBackup({dir:"/workspace"}) captures the whole ride.
# .dockerkeep keeps /workspace non-empty so the image seeds it non-root-owned (matches
# the upstream .dockerkeep trick -- empty dirs are skipped and would break USER app writes).
RUN useradd --create-home --uid 1000 app \
 && mkdir -p /workspace && touch /workspace/.dockerkeep \
 && chown -R app:app /app /workspace

USER app
# Runtime cwd = /workspace so koboi's default sandbox workdir (".") resolves under
# the Saddlebag root and gets captured by createBackup({dir:"/workspace"}).
WORKDIR /workspace
EXPOSE 8000

# Generic single-session server. The Outrider routes exactly ONE session to each
# Mount, so this is effectively 1 writer / 1 session regardless of pool cap.
# (Wave-1b TODO: set pool cap=1 to hard-enforce; today it's routing-enforced.)
ENV KOBOI_CONFIG=/app/config/finance.yaml
# Point the finance audit log under the Saddlebag root so it rides createBackup
# (finance_ext/hooks.py defaults to /data/audit -- outside the snapshot root).
ENV INVOICE_AUDIT_LOG=/workspace/audit/invoice_audit.jsonl
CMD ["koboi", "serve", "/app/config/finance.yaml"]
