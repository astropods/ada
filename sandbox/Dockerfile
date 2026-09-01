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

# --- project toolchain (configurable) ----------------------------------------
# THIS IS WHERE PROJECT TOOLCHAINS GO. The agent's commands run here, not in the
# control plane, so a tool this image lacks is a tool the agent cannot use — it
# will report "not verified locally" and open a PR without having run the
# project's checks.
#
# Both lists are BUILD ARGS so a deployment can change them without editing this
# file:
#
#   ast/docker build -f sandbox/Dockerfile \
#     --build-arg SANDBOX_NPM_PACKAGES="bun@1.3.9 pnpm" \
#     --build-arg SANDBOX_APT_PACKAGES="python3 python3-pip golang-go" .
#
# Build args rather than runtime env on purpose. Installing packages at boot
# would mean an apt/npm fetch on every cold start, a network dependency in the
# one container that must keep working when things are broken, and — worst —
# mutable tooling in the process that runs model-authored commands. Build time
# keeps the image reproducible and the layer cached.
#
# There is no way to make this image universal, so treat the list as deliberate
# and reviewed. Every addition is attack surface exactly where it matters most.
ARG SANDBOX_NPM_PACKAGES="bun@1.3.9"
ARG SANDBOX_APT_PACKAGES=""
RUN if [ -n "$SANDBOX_APT_PACKAGES" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends $SANDBOX_APT_PACKAGES \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
 && if [ -n "$SANDBOX_NPM_PACKAGES" ]; then npm install -g $SANDBOX_NPM_PACKAGES; fi \
 && echo "sandbox toolchain: apt=[$SANDBOX_APT_PACKAGES] npm=[$SANDBOX_NPM_PACKAGES]"

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
    GOMAXPROCS=1 \
    NODE_OPTIONS=--max-old-space-size=384 \
    UV_THREADPOOL_SIZE=2 \
    MAKEFLAGS=-j1 \
    JOBS=1 \
    npm_config_jobs=1 \
    CARGO_BUILD_JOBS=1 \
    VITEST_MAX_THREADS=1 \
    VITEST_MIN_THREADS=1 \
    VITEST_MAX_FORKS=1 \
    NX_PARALLEL=1 \
    TURBO_CONCURRENCY=1 \
    PYTHONDONTWRITEBYTECODE=1

# --- why the single-worker tuning above -------------------------------------
# A CPU quota is INVISIBLE to the usual ways a tool decides how parallel to be.
# Measured inside `--cpus=0.1 --memory=1g` on node:24-slim:
#
#   /sys/fs/cgroup/cpu.max  ->  10000 100000   (a tenth of a core)
#   nproc                   ->  12             (the HOST's cores)
#   getconf _NPROCESSORS_ONLN -> 12
#   os.cpus().length        ->  12
#   os.availableParallelism() -> 1             (the only quota-aware one)
#
# So a test runner or bundler sizing its pool from `nproc` or `os.cpus()` forks
# a dozen workers that the quota will never let run concurrently. Each idle Node
# worker is ~45MB resident before it does any work, so the fan-out alone can
# spend the entire memory limit on parallelism the CPU quota forbids — which is
# how this container hit both its limits at once while writing code.
#
# GOMAXPROCS/GOMEMLIMIT already covered the Go toolchain (and so esbuild, which
# is Go). These are the equivalents for everything else. They are forwarded to
# spawned commands by BASE_ENV_KEYS in sandbox/index.ts — setting them here and
# not there would tune only this service, which is not where builds run.
#
# NODE_OPTIONS caps a spawned Node's heap. It also applies to the service
# itself, which is why the CMD passes its own, lower `--max-old-space-size`:
# command-line flags are applied after NODE_OPTIONS and win.

# No dependencies: the service is node: built-ins only. Nothing to install, and
# nothing in node_modules for a compromised command to tamper with.
COPY sandbox/index.ts ./sandbox/index.ts

EXPOSE 3000
# The service is a thin HTTP shell around spawn() and the filesystem; it needs a
# small fraction of the container. Left alone, Node sizes its heap from the
# cgroup limit — measured at 560MB of a 1GiB container — and a heap it is
# ENTITLED to grow into is memory the builds cannot have. Capping it here keeps
# the rest of the budget for the commands this container exists to run.
CMD ["node", "--max-old-space-size=96", "sandbox/index.ts"]
