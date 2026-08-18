# Ada execution sandbox — the isolated, secret-less side of the split.
#
# Built from the repo root (context: .) so it shares no source with the control
# plane beyond this directory. Unlike the pre-Flue version, it does NOT import
# anything from agent/: it implements Flue's SandboxDriver over HTTP and knows
# nothing about models, prompts, or credentials.
#
# Node 24 runs the .ts source natively via type-stripping (requires >= 23).
FROM node:24-slim

# The toolchain the agent's commands actually invoke. `gh` is here rather than
# in the control plane because this is where git operations now run. NOTE: no
# inline `#` inside the RUN — line continuations collapse to one shell line.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# --- project toolchain -------------------------------------------------------
# THIS IS WHERE PROJECT TOOLCHAINS GO. The agent's commands run here, not in the
# control plane, so a tool this image lacks is a tool the agent cannot use — it
# will report "not verified locally" and open a PR without running the checks.
#
# bun is installed because the repositories Ada works on use it (bun.lock,
# `bun run typecheck`). Add whatever else your repos need; there is no way to
# make this image universal, so treat it as a deliberate, reviewed list rather
# than something to grow reflexively — every addition is attack surface in the
# one container that runs model-authored commands.
ARG BUN_VERSION=1.3.9
RUN npm install -g "bun@${BUN_VERSION}" && bun --version

# git uses gh's credential helper; gh vends whatever GH_TOKEN is in the
# environment of the command being run. The control plane sends that per
# request, so no token is ever stored in this image or on its volume.
RUN git config --system credential."https://github.com".helper "!gh auth git-credential"

WORKDIR /app
# /data is the mounted volume: one directory per agent instance, TTL-swept.
# Build caches live here too, so repeat builds don't re-download a toolchain.
ENV NODE_ENV=production \
    PORT=3000 \
    GIT_TERMINAL_PROMPT=0 \
    WORKSPACE_ROOT=/data \
    GOMODCACHE=/data/.cache/go/mod \
    GOCACHE=/data/.cache/go/build \
    npm_config_cache=/data/.cache/npm \
    PIP_CACHE_DIR=/data/.cache/pip \
    BUN_INSTALL_CACHE_DIR=/data/.cache/bun \
    GOMEMLIMIT=600MiB \
    GOMAXPROCS=1

# No dependencies: the service is node: built-ins only. Nothing to install, and
# nothing in node_modules for a compromised command to tamper with.
COPY sandbox/index.ts ./sandbox/index.ts

EXPOSE 3000
CMD ["node", "sandbox/index.ts"]
