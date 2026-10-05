# Node 24 runs the .ts sources natively via type-stripping (requires >= 23).
FROM node:24-slim

# --- toolchain --------------------------------------------------------------
# No Claude Code CLI: the agent loop runs in-process (agent/agents/ada.ts), so
# there is no `claude` binary to install and no stream-json contract to pin.
#
# `git` and `gh` are still here, but only for the FALLBACK path. When a sandbox
# container is deployed (knowledge.sandbox in astropods.yml) the model's
# commands run there instead and this image never shells out for the agent.
# They remain so `node agent/index.ts` works locally with no sandbox service.
# NOTE: no inline `#` comments inside this RUN — line continuations collapse to
# one shell line and a `#` would comment out the rest.
# `upgrade` before anything else: the base image is a snapshot, and a scan sees
# whatever Debian shipped the day it was cut. Without this, libexpat1,
# libpcre2 and tzdata stayed on the versions the snapshot froze even though
# patched ones were in the repository.
RUN apt-get update \
 && apt-get upgrade -y \
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
# WORKSPACE_ROOT holds the fallback local workspaces and Flue's conversation
# database (agent/db.ts). With a sandbox container deployed, checkouts live on
# ITS /data volume instead and only the database is written here — which is why
# conversation durability across restarts still wants attention (see README).
ENV NODE_ENV=production \
    PORT=80 \
    GIT_TERMINAL_PROMPT=0 \
    OTEL_SERVICE_NAME=ada \
    WORKSPACE_ROOT=/data

# Runtime deps now include the Flue runtime and its model layer, so this is no
# longer an "only @opentelemetry/api" install. devDeps (typescript, vite,
# playwright, @ag-ui/core) are still not needed at runtime.
# LOCKFILE-DRIVEN, so the image's dependency versions are the ones reviewed
# here. This previously ran `npm install` from package.json alone — bun.lock
# was never copied — so every build re-resolved and the deployed versions were
# whatever npm picked that day. A CVE scan could regress with no commit behind
# it, and the only way to know what shipped was to build and look inside.
#
# bun, because bun.lock is this repo's real lockfile; `--frozen-lockfile` fails
# the build rather than silently resolving if the two drift apart.
COPY package.json bun.lock ./
RUN npm install -g bun@1.3.9 --no-audit --no-fund \
 && bun install --frozen-lockfile --production \
 && rm -rf /root/.bun/install/cache \
 # npm and bun are BUILD-TIME tools: the entrypoint is `node agent/index.ts`,
 # and the model's commands run in the sandbox, not here. Removing them takes
 # their bundled dependencies out of the image too — npm's own brace-expansion
 # has advisories that no released npm has picked up, so upgrading cannot
 # reach them.
 #
 # The cost: a `local()` sandbox in this image can run neither. Production does
 # not use that path — it is the in-process fallback this project warns is not
 # an isolation boundary.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/bun /usr/local/bin/bun /usr/local/bin/bunx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /root/.npm /root/.bun

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
