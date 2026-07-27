# mount/Dockerfile -- the Mount: a Sandbox-SDK container running a single-session koboi server.
#
# ROOT-CAUSE FIX (RC2): the image MUST derive from the Sandbox SDK base image
# (docker.io/cloudflare:sandbox:<sdk-version>) -- it ships the in-container agent that implements
# exec / createBackup / startProcess / waitForPort. A plain python:* image lacks it, so every SDK
# RPC hangs (the container "runs" but has nothing to answer the SDK). Do NOT set CMD -- inherit the
# base image's entrypoint (the agent); `koboi serve` is started by the Outrider via startProcess.
FROM docker.io/cloudflare/sandbox:0.12.4

# git: sandbox.git_init seeds each session workdir as a git repo (audit trail).
# procps: the Outrider stops `koboi serve` via `pkill -TERM -f 'koboi serve'` on dismount.
# python3 + python3-pip: the 0.12.4 SDK base ships Python but does NOT put python3/pip on PATH,
# so install them via apt to get a working `python3 -m pip` (koboi needs >=3.10).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git procps python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# koboi-agent 0.19.2 (0.19.1: POST /v1/sessions/{id}/suspend + consistent_backup; 0.19.2: GET
# /v1/sessions/{id} survives a serve restart -- the koboi-range suspend/resume fix, PR #103).
ARG KOBOI_AGENT_VERSION=0.19.2
RUN python3 -m pip install --no-cache-dir "koboi-agent[api]==${KOBOI_AGENT_VERSION}"

# --- use-case code (demo: Ledgerline invoice reconciliation) -----------------
# finance-ext has no deps + no compiled code, so put it on PYTHONPATH instead of pip-installing
# (avoids needing the PEP 517 build backend, which the apt python3-pip doesn't ship).
WORKDIR /app
COPY usecase/finance-ext/src ./src
COPY usecase/finance-ext/erp_mcp_server.py ./erp_mcp_server.py
ENV PYTHONPATH=/app/src

# koboi config (single-session, /workspace as the snapshotted Saddlebag root).
COPY configs/finance.yaml /app/config/finance.yaml

# /workspace is the "Saddlebag" root: koboi_memory.db (WAL) + steps journal + audit git all live
# here, so ONE createBackup({dir:"/workspace"}) captures the whole ride.
RUN mkdir -p /workspace

ENV KOBOI_CONFIG=/app/config/finance.yaml
# Point the finance audit log under the Saddlebag root so it rides createBackup.
ENV INVOICE_AUDIT_LOG=/workspace/audit/invoice_audit.jsonl
EXPOSE 8000
# NO CMD: inherit the Sandbox SDK base image entrypoint (the in-container agent).
