# Node 24 runs the .ts sources natively via type-stripping (requires >= 23).
FROM node:24-slim

# --- toolchain the agent's sandbox shells out to ---------------------------
# The Claude Code CLI is GONE: since the Flue rewrite the agent loop runs
# in-process (see agent/agents/ada.ts), so there is no `claude` binary to
# install and no stream-json contract to pin against a CLI version. What the
# image still needs is the toolchain the agent's sandbox actually invokes —
# `git` and the GitHub CLI (`gh`) — so it can do authenticated GitHub work
# (clone/push/PR) inside the container. NOTE: no inline `#` comments inside
# this RUN — line continuations collapse to one shell line and a `#` would
# comment out the rest.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# git uses gh's credential helper for github.com; gh vends whatever token is in
# GH_TOKEN at runtime — the sandbox env carries the user's per-session OAuth
# token there (agent/config/model.ts). No static token baked in; nothing to
# strip if a session is unauthenticated.
RUN git config --system credential."https://github.com".helper "!gh auth git-credential"

WORKDIR /app
# WORKSPACE_ROOT holds BOTH the per-session workspaces and Flue's conversation
# database (agent/db.ts), so multi-turn sessions survive a restart when it is
# backed by a persistent volume.
ENV NODE_ENV=production \
    PORT=80 \
    GIT_TERMINAL_PROMPT=0 \
    OTEL_SERVICE_NAME=ada \
    WORKSPACE_ROOT=/data

# Runtime deps now include the Flue runtime and its model layer, so this is no
# longer an "only @opentelemetry/api" install. devDeps (typescript, vite,
# playwright, @ag-ui/core) are still not needed at runtime.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY agent ./agent
COPY fixtures ./fixtures
COPY public ./public
COPY flue.config.ts ./

# agent.interfaces.frontend => the container MUST listen on port 80. We run as
# root to bind it. The agent's own permissions are constrained by what
# agents/ada.ts mounts (a sandbox scoped to the session workspace, with a
# scrubbed env) rather than by CLI flags.
EXPOSE 80
CMD ["node", "agent/index.ts"]
