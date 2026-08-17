# Ada

[![Deploy on Astropods](assets/deploy-button.svg)](https://astropods.com/astropods/ada-your-personal-coding-agent)

**Ada** is a coding agent built on **[Flue 2.0](https://flueframework.com)**, the
open TypeScript agent framework. The agent loop runs **in-process**; its event
stream is re-emitted as **AG-UI** events over **SSE**, so any AG-UI-compatible
frontend (CopilotKit, custom dashboards) can consume it directly. You converse
with it over **Slack / web chat** (the Astro messaging sidecar) or the built-in
AG-UI frontend. It's an Astropods/K8s workload.

> **Why the name?** Named for **Ada Lovelace** (1815–1852), who wrote the first
> algorithm intended to be carried out by a machine and is widely regarded as the
> first computer programmer — a fitting namesake for an agent that writes and runs
> code for you. The Astropods blueprint deploys as
> **`ada-your-personal-coding-agent`** because a bare `ada` isn't a valid blueprint name.

> Status: **usable, with SCAFFOLD edges.** Multi-turn sessions, per-session
> sandbox workspaces, GitHub per-user OAuth, the Astro AI Gateway path, and
> Slack/web messaging are all real. Conversation durability across restarts,
> registry GC, cookie signing, and token encryption-at-rest are still `TODO`
> (grep the source, and see Limitations).

## The agent

The whole agent is a function. Flue's hooks decide what it can do, and the
decision is re-made on every render — which is why the GitHub guidance and the
`checkout_repo` tool appear the moment a user connects, mid-conversation, with
no restart:

```ts
// agent/agents/ada.ts
'use agent';

export function Ada({ id }: AgentProps) {
  const env = getSessionEnv(id);

  useModel(env.modelRef, { thinkingLevel: 'medium' });
  useSandbox(local({ cwd: env.cwd, env: env.sandboxEnv }), { cwd: env.cwd });
  useInstruction(githubPromptGuidance({ ... }));
  if (env.githubConnected) useTool(checkoutRepo(id));

  return ROLE; // the return value IS the system instructions
}
Ada.agentName = 'ada';
```

`useSandbox()` is what gives Ada `read`/`write`/`edit`/`bash`/`grep`/`glob` — the
coding toolset is a property of having an environment, not a list we maintain.

## Run it

Node ≥ 23 runs the TypeScript sources directly (type-stripping), so the default
path needs no build step. Locally the simplest credential is a personal Anthropic
key, which routes directly to Anthropic (bypassing the gateway):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node agent/index.ts                  # -> http://localhost:8080
```

Three entry points, all sharing `agent/agents/ada.ts`:

| Command | What it is |
|---|---|
| `node agent/index.ts` | No build step. Calls Flue's `start()` to configure the runtime, then serves `agent/app.ts`. |
| `vite build && node dist/server.mjs` | The Flue Node target. The generated entry configures the runtime itself. |
| `npx flue run agent/agents/ada.ts --message "…"` | One turn in the terminal, no HTTP. Quickest way to check a prompt or tool change. |

Open `http://localhost:8080/`, type a prompt (e.g. "read package.json and tell
me the version"), and watch the AG-UI stream render as chat. Keep replying to
continue the same session — follow-up turns resume the prior context in the same
workspace. The UI shows a per-session token/cost readout, a session-history
switcher (**＋ New session**), and a gear **Settings** panel (identity + GitHub
connect/setup).

**Debug inspector (`?debug`):** the built-in client is a clean single-column
chat by default. Append **`?debug`** (`http://localhost:8080/?debug`) to reveal
a right-hand panel with the raw AG-UI events and their sequence numbers, plus
**Disconnect** / **Reconnect (replay)** buttons that demonstrate lossless
catch-up via `Last-Event-ID`. Dev/inspection tool only — hidden by default.

The client is a single dependency-free file (`public/index.html`) served
same-origin (no CORS, no build). Each session runs in its own writable workspace
(see `agent/session/workspace.ts`), not the process CWD.

## HTTP API

Two front doors, deliberately. `/sessions/*` is Ada's own AG-UI-over-SSE
contract — what the built-in client, the messaging adapter, and external AG-UI
clients speak. `/agents/ada/*` is Flue's native router for `@flue/sdk` clients.
Both address the **same durable instances**, so a session started over one is
readable over the other.

| Route | Purpose |
|---|---|
| `GET  /` | Built-in AG-UI test client (`public/index.html`) |
| `POST /sessions` `{prompt}` | Start a session → `{sessionId}` |
| `POST /sessions/:id/messages` `{prompt}` | Continue a session with a follow-up turn |
| `DELETE /sessions/:id` | Drop a session (event log, workspace, Flue state) |
| `GET  /sessions/:id/events` | SSE AG-UI stream; honours `Last-Event-ID` replay |
| `GET  /conversations` | List handled conversations (admin-gated) |
| `GET  /api/whoami` | Resolved identity + admin + GitHub connection state |
| `GET  /auth/github/login` · `/callback` · `/status` | Per-user GitHub App OAuth |
| `GET  /api/setup/github/start` · `/callback` · `/api/setup/status` | Web-driven GitHub App provisioning |
| `ALL  /agents/ada/:id` | Flue's native agent routes (`@flue/sdk`) |

Only one turn runs at a time per session — an overlapping `POST .../messages`
returns `409 busy`. (Flue serializes concurrent deliveries to one instance
anyway; the 409 is kept because the AG-UI client relies on it to keep its own
turn state coherent.) When a deployment gates access, an unauthorized request
gets a themed `401` instead of the app shell.

## Run on the Astro platform (container, cloud)

The agent is packaged for Astropods (`astropods.yml` + `Dockerfile` + `AGENT.md`).

```bash
ast project start        # build + run the container locally (frontend on :80)
# then deploy via your platform flow (see `ast docs`)
```

Key facts:
- **`agent.interfaces.frontend: true`** → the container listens on **port 80**
  (`Dockerfile` sets `PORT=80`; runs as root to bind it). The built-in AG-UI
  client + SSE API are served there and exposed at `ASTRO_EXTERNAL_AGENT_URL`.
- **`agent.interfaces.messaging: true`** → the platform's messaging sidecar
  (web chat / Slack) is deployed. It normalizes each inbound message and streams
  it over gRPC (`GRPC_SERVER_ADDR`); `agent/messaging/adapter.ts` runs our side,
  so a Slack thread becomes one durable Flue instance. **No Slack tokens
  needed** — Slack is platform-managed.
- **`astro_ai_gateway: true`** → model calls route through the Astro AI Gateway
  (injects `ASTRO_GATEWAY_URL` + `ASTRO_GATEWAY_API_KEY`); no personal key baked
  in. See "Model routing & auth". Opt out per-deploy with the optional
  `ANTHROPIC_API_KEY` input (talks to Anthropic directly).
- **`knowledge.db: postgres`** → platform-managed Postgres (`POSTGRES_*`) stores
  per-user GitHub OAuth tokens, the GitHub App creds, repo bindings, and the
  server HMAC secret.
- **`PUBLIC_BASE_URL`** (optional env) → overrides the agent's public base URL,
  ahead of `ASTRO_EXTERNAL_AGENT_URL`. Needed only when the origin a browser
  reaches Ada on isn't loopback and isn't the platform URL (ngrok, a LAN IP).
  See "GitHub App callback URLs".
- **`ADMIN_EMAILS`** (optional input) → comma-separated admin emails allowed to
  provision the GitHub App from the web UI (matched against the ALB-verified
  identity). Unset ⇒ any signed-in user may do the *initial* setup, then it locks.
- **`GITHUB_APP_PUBLIC`** (optional input, default `false`) → provision the GitHub
  App **private** (single-tenant). Set `true` for **multi-tenant** so any
  teammate can install it on their own repos and connect via chat.
- The image bakes in **`git` + `gh`** — the toolchain the sandbox shells out to.
  There is no `claude` CLI to install and no `CLAUDE_CODE_VERSION` to pin.

`dev.command` (`node --watch agent/index.ts`) is the `ast dev` hot-reload path:
the container bind-mounts `agent/` so host edits reload live (this is why the
source lives in `agent/`). Local `ast dev` adapters are `[web, slack]`.

## Tests

End-to-end tests (Playwright) cover the SSE reconnect fix and session delete — no
model credential needed. A test-only `POST /test/seed` hook builds a replayable
session from a recorded fixture of Flue events, so the transport/registry
behaviour is exercised without a real model run.

```bash
npm install
npx playwright install --with-deps chromium   # one-time browser download
npm test                                       # or: npm run test:ui
```

- `test/server-sse.spec.ts` — the server prefers the `Last-Event-ID` header over a
  stale `?lastEventId=-1` query (reconnect *resumes*, not full-replays), plus
  `DELETE /sessions/:id` semantics (204 → 404; events 404 afterward).
- `test/client-reconnect.spec.ts` — mocks the SSE endpoint to force repeated
  full-buffer replays and asserts the client renders `✓ finished` exactly once.
- `test/client-delete.spec.ts` — the ✕ in the session menu issues `DELETE
  /sessions/:id` and removes the row.

`POST /test/seed` is exposed ONLY when `ADA_TEST_HOOKS=1` (set by
`playwright.config.ts`'s `webServer`); it's inert in production. CI runs the suite
on every push to `main` and every PR (`.github/workflows/e2e.yml`).

## Architecture

One internal pipeline, three sinks. Flue's event stream is the single source of
truth; the translator, telemetry, and persistence each subscribe independently,
so what the client sees can't drift from what's billed. The same pipeline feeds
both the SSE/AG-UI frontend and the messaging sidecar.

```
 HTTP (POST /sessions) ─┐
 Slack / web (sidecar) ─┴─▶ SessionRunner
                                │  setSessionEnv(id, …)   ← workspace, GH token, repo
                                │  init(Ada, {id}).dispatch(prompt)
                                ▼
                          Flue agent loop  (in-process; sandbox = local())
                                │  observe() — FlueEvent stream
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   Translator            Telemetry (OTel          ResultStore
        │                 spans/metrics)          (usage + cost)
        ▼
  SessionRegistry (per-session AG-UI log, seq'd)
        │
        └──▶ SSE emitter (Last-Event-ID replay)
```

| Module | Responsibility |
|---|---|
| `agent/agents/ada.ts` | **The agent.** A `'use agent'` function whose hooks declare model, sandbox, instructions, and tools per render. |
| `agent/agents/session-env.ts` | Per-instance context (workspace, GH token, repo) held **out of durable state** — see below. |
| `agent/agents/tools.ts` | Application tools (`checkout_repo`) — work needing a credential or a server-side decision. |
| `agent/config/model.ts` | **Isolated swap seam.** Model resolution, the custom Astro AI Gateway pi-ai provider, and the scrubbed sandbox env. |
| `agent/session/runner.ts` | Drives Flue instances (`init`/`dispatch`/`read`), fans `observe()` events into the registry, telemetry, and results. |
| `agent/translate/translator.ts` | Pure `FlueEvent` → AG-UI mapping. Stateful per session. |
| `agent/session/registry.ts` | Per-session AG-UI event log with monotonic seq → lossless reconnect. Decoupled from transport. |
| `agent/session/workspace.ts` | Per-session writable workspace (the sandbox cwd), reused across turns, TTL-GC'd. |
| `agent/db.ts` | Flue's durable conversation store (SQLite). Read by both server entries. |
| `agent/app.ts` | The Hono route map: AG-UI routes, Flue's native routes, auth, setup. |
| `agent/index.ts` | Standalone Node entry — `start()`s the runtime, then serves `app.ts`. |
| `agent/messaging/adapter.ts` | `AgentAdapter` for the Astro messaging sidecar (web/Slack); directives + delegation to the runner. |
| `agent/auth/*` | Per-user GitHub App OAuth, App-Manifest provisioning, signed chat connect links, ALB-identity resolution. |
| `agent/store/*` | Postgres-backed store (GitHub tokens, App creds, repo bindings, server secret); in-memory fallback. |
| `agent/transport/sse.ts` | AG-UI SSE framing + `Last-Event-ID` replay. |
| `agent/telemetry/*` | OTel GenAI-semconv traces + metrics; cost. No-op without `@opentelemetry/api`. |

### Keeping secrets out of durable state

Flue offers two ways to get data into a render — `useInitialData()` and
`useDelivery()` signal attributes — and **both are recorded in the instance's
durable conversation log.** That is exactly wrong for a GitHub token: it would
be persisted, replayed on recovery, and outlive its own expiry.

So Ada keeps the sensitive per-turn bits in a process-local table
(`agents/session-env.ts`). The runner resolves a fresh token and publishes the
context immediately **before** each dispatch; the render reads it synchronously
by instance id. Nothing there is durable — after a restart the runner
repopulates it on the next turn, which is the right lifetime for a credential.
A render with no published context (Flue recovering an interrupted submission
after a restart) degrades to a credential-free one rather than throwing
mid-recovery.

## Secure by default

Ada is opinionated about how code gets written. The opinions live in three
layers, and the layering is the design — each does something the others can't.

| Layer | Where | Cost | What it achieves |
|---|---|---|---|
| **Principles** | `security/principles.ts` → `useInstruction()` | every turn | Suggests. Five rules that apply to nearly every change |
| **Skills** | `security/skills.ts` → `useSkill()` | one catalog line until activated | Informs. Detailed playbooks, loaded only when relevant |
| **Gates** | `security/gates.ts` → `useAgentFinish()` | per stop-point | **Enforces.** Reads the real diff and sends the model back |

**Why not just a bigger system prompt?** Because a twenty-point security
checklist in the prompt does not make the agent twenty points safer — it makes
each point less likely to be noticed, and it bills you for the whole list on
every request. The principles file is deliberately five items long. Everything
detailed is a skill, which costs one catalog line until the model decides it's
relevant. Everything that must not be skipped is a gate, which is checked rather
than trusted.

### The skills

`secure-api-endpoint` · `safe-db-migration` · `injection-defence` ·
`maintain-api-docs` · `dependency-hygiene` · `secrets-handling` ·
`agent-integrity`

They're framework-agnostic — Ada works on whatever repo it's pointed at, so they
describe the shape of the correct answer rather than one library's API — and
each names its anti-patterns explicitly, since a labelled wrong example steers a
model better than an imperative.

### The gates

`useAgentFinish` runs at every would-stop point. Ada diffs against the commit
recorded at `useAgentStart`, so it sees committed work too — not just the
working tree — then applies:

| Rule | Kind | Fires when |
|---|---|---|
| `secret-in-diff` | blocking | A credential shape or a committed `.env` appears in added lines |
| `weakened-check` | blocking | A `.skip`, `@ts-ignore`, `eslint-disable`, `--no-verify`, or a net deletion of assertions |
| `route-without-test` | advisory | Request-handling code changed, no test touched *(only if the repo has tests)* |
| `api-change-without-spec` | advisory | Routes changed, spec didn't *(only if the repo has a spec)* |
| `migration-without-down` | advisory | A migration with no visible reversal |
| `dependency-without-lockfile` | advisory | A manifest changed without its lockfile |

Three properties worth knowing, all covered by `test/security-gates.spec.ts`:

- **Budgets.** A gate that can't be satisfied is an infinite loop billed to you.
  Advisory rules fire once per session; blocking rules get three attempts, then
  emit a terminal "stop and tell the user" signal. A blocking rule never goes
  quiet — a suppressed secret warning is worse than none.
- **Conditional on capability.** Rules that ask "you changed X but not Y" first
  check that Y is something the project does at all. A gate that cries wolf is
  one the model learns to argue past.
- **Arguable.** Every signal invites the model to explain why a rule doesn't
  apply rather than demanding compliance, because they're heuristics over paths
  and diff text and will sometimes misfire.

The Ada-specific one is `secrets-handling`. Ada's tool output is streamed to
Slack and retained in a replayable event log, and `GH_TOKEN` is in the sandbox
env — so a casual `env`, `cat .env`, or `curl -v` publishes a live credential to
everyone in the channel. The skill calls those commands out by name.

## Working on Slack (threads, repos, concurrency)

Ada is multi-threaded over Slack: the **conversation (thread) is the unit of
work and isolation**. The thread id *is* the Flue instance id, so each thread
gets its own durable conversation, its own workspace, and its own repo checkout
— different threads work on different repos at the same time without
interfering.

**One thread = one task = one repo.** In a thread, bind the repo once:

```
work on owner/repo        (or: /work owner/repo)
```

Ada clones it into that thread's workspace and reuses the checkout across turns
(your work-in-progress is kept between messages — it is *not* reset). To work on
a **different** repo, start a **new thread**. `whoami` shows the thread's bound
repo and your GitHub connection.

How it behaves under load:

- **Concurrent threads** run in parallel, bounded by `MAX_CONCURRENT_RUNS`
  (default 3) so a burst of threads can't exhaust the box — excess runs queue.
- **Rapid messages in one thread**: a new message supersedes the in-flight run.
  The sidecar aborts it and the runner calls `handle.abort()`, so the old turn is
  durably stopped rather than racing the new one in one workspace.
- **Idle workspaces** are reclaimed by a TTL sweep (`startWorkspaceGc`).

### Execution sandbox (isolation)

Ada uses Flue's **`local()`** sandbox: real filesystem, real processes, bound to
the session's workspace directory. `local()` scrubs the host env down to its own
allowlist (`PATH`/`HOME`/`SHELL`/`LANG`/`TMPDIR`/…), and `agent/config/model.ts`
layers on only the proxy/TLS vars, the build-cache tuning, and — when the user
has connected — their `GH_TOKEN`. So `bash → env` cannot read the container's
AWS/database/gateway secrets. The **model credential is no longer forwarded at
all**, because no child process needs it.

**This is a smaller isolation boundary than before.** Ada used to run Claude Code
in a separate, secret-less sandbox container reached over HTTP (`knowledge.sandbox`
+ `sandbox/`), so a rogue tool reached at most one thread's checkout in a process
that held no control-plane secrets. Flue runs the loop in-process, so that split
is gone and the model's shell shares the control plane's container. Flue's
sandbox interface makes restoring it a one-line change at the `useSandbox()`
call — swap `local()` for a remote adapter (E2B, Daytona, Modal) and provision
that provider.

### Tool policy

Under Claude Code, the toolset arrived via the `claude_code` preset and had to be
pruned with a `DEFAULT_DISALLOWED_TOOLS` deny list (`WebSearch`/`WebFetch` were
dead on the Bedrock gateway; `Task`/`Workflow` multiplied `claude` child
processes; a dozen harness tools were irrelevant to a coding turn). **That deny
list is gone.** Flue mounts only what the render declares, so the default is
closed:

- File + shell verbs from `useSandbox()`: `read`, `write`, `edit`, `bash`,
  `grep`, `glob`.
- `checkout_repo` from `useTool()`, only when the user has connected GitHub.

Nothing else is reachable. There is no skill discovery, no MCP server, no
subagent — add them explicitly with `useSkill()`, `useMcpConnection()`, and
`useSubagent()` if you want them.

Concurrency is bounded by `MAX_CONCURRENT_RUNS` (astropods input, default 3),
which both the browser and messaging paths route through.

## Flue events → AG-UI mapping

| Flue event | AG-UI event(s) |
|---|---|
| `agent_start` | `RUN_STARTED` (threadId = instance id) + `STATE_SNAPSHOT` |
| `message_start` | — (opens an assistant message id) |
| `text_delta` | `TEXT_MESSAGE_START` (lazily) + `TEXT_MESSAGE_CONTENT` |
| `message_end` | `TEXT_MESSAGE_END` for the open text message |
| `thinking_start` / `_delta` / `_end` | `REASONING_MESSAGE_*` — **off by default** (version-dependent) |
| `toolcall_delta` | `TOOL_CALL_START` (lazily) + `TOOL_CALL_ARGS` (`delta` = argument-text fragment, 1:1) |
| `tool_start` | `TOOL_CALL_START`/`ARGS` if no deltas arrived, then `TOOL_CALL_END` |
| `tool` | `TOOL_CALL_RESULT` (`toolCallId`, `content` string) |
| `turn` | `CUSTOM` `ada.usage` — per-turn tokens + cost |
| `log` | `CUSTOM` `ada.log` |
| `compaction` | `CUSTOM` `ada.compaction` |
| `agent_end` | `RUN_FINISHED` |
| `submission_settled` (failed/aborted) | `RUN_ERROR` (`message`, `code`) |

`turn_start` / `turn_request` / `turn_messages` / `operation*` / `task*` /
`submission_queued|running|recovery` / `idle` produce no AG-UI event
(telemetry-only).

**Ordering, because it's easy to get wrong.** `toolcall_delta` is a *live
preview* of arguments while the model is still emitting them; `tool_start` fires
later, when the call executes, carrying the complete `args`. A tool call may
arrive either way round. The translator opens the AG-UI tool call on whichever
comes first and closes it exactly once, on `tool_start` — never twice, and never
on a preview alone (a previewed call the runtime then drops must not leave the
client with a spinner that never resolves).

## AG-UI output for `read → edit → report`

`POST /test/seed` replays `fixtures/read-edit-report.flue.jsonl` through the
translator, producing 23 AG-UI events:

```
RUN_STARTED               threadId=fixture runId=run_1
STATE_SNAPSHOT            {sessionId, agentName, submissionId}
TEXT_MESSAGE_START        msg_1
TEXT_MESSAGE_CONTENT ×2   "I'll read " / "config.json first."
TEXT_MESSAGE_END          msg_1
TOOL_CALL_START           tc_read  read
TOOL_CALL_ARGS ×2         {"path":  +  "config.json"}
TOOL_CALL_END             tc_read
TOOL_CALL_RESULT          tc_read  -> file contents
TEXT_MESSAGE_START/…/END  msg_2  "Bumping retries to 5."
TOOL_CALL_START/ARGS/END  tc_edit  edit
TOOL_CALL_RESULT          tc_edit  "Applied 1 edit to config.json"
CUSTOM ada.usage          {inputTokens, outputTokens, cache*, costUsd}
TEXT_MESSAGE_START/…/END  msg_3  "Done — retries is now 5."
RUN_FINISHED
```

## GitHub App callback URLs

Three things have to agree on the agent's public base URL, and if any two
disagree the flow fails as a confusing **404**:

1. the App manifest's `callback_urls` / `redirect_url`, registered with GitHub
   **once, permanently**, at App-creation time;
2. the `redirect_uri` on the authorize redirect *and* on the code exchange —
   GitHub rejects the exchange if the two differ;
3. the connect link handed to a chat user.

`agent/auth/base-url.ts` is the single source of truth, resolving in order:

1. `PUBLIC_BASE_URL`, then `ASTRO_EXTERNAL_AGENT_URL` — explicit config wins.
2. The request's own `Host`, **but only for loopback hosts**.
3. `http://localhost:${PORT ?? 8080}`.

Step 2 is what makes local setup work. Under `ast project start` the container
sets `PORT=80` while the frontend is mapped to `8080` on your host, so deriving
the base from `PORT` registered `http://localhost:80/...` and GitHub sent the
browser to a port nothing was listening on.

**Why `Host` is only trusted for loopback:** it's a client-controlled header,
and building an OAuth `redirect_uri` from it is a known injection vector — an
attacker who can send a request with a poisoned `Host` could have a victim's
authorization code delivered to their own origin. Restricting it to
`localhost`/`127.0.0.1`/`[::1]` fixes exactly the broken case (your browser
talking to your own machine on a non-default port) and leaves every reachable
deployment on explicit config. For a non-loopback dev origin, set
`PUBLIC_BASE_URL`.

> **If you already provisioned an App with a bad callback**, this fix can't
> repair it — the URLs live on the GitHub App. Either edit them in the App's
> settings on GitHub, or delete the App and run setup again.

## Model routing & auth

All of "which model, which credentials, what does a token cost" lives in
`agent/config/model.ts`. Precedence:

1. **Explicit `ANTHROPIC_BASE_URL`** — always wins.
2. **`ANTHROPIC_API_KEY` (opt-out)** — direct to `api.anthropic.com` via pi-ai's
   built-in `anthropic` provider, bare model id. The simple local path.
3. **Astro AI Gateway (default in-cluster)** — `ASTRO_GATEWAY_URL/anthropic`
   (Bifrost's Anthropic ingress → Bedrock), registered as a **custom pi-ai
   provider** with `createProvider()` + `setProvider()`.

Two gateway quirks worth knowing, both load-bearing:

- **Auth goes in two headers.** Bifrost reads the virtual key only from
  `x-bf-vk`; it ignores `Authorization`/`x-api-key`. But pi-ai's
  anthropic-messages API refuses to send a request that has none of
  `authorization` / `x-api-key` / `cf-aig-authorization`, so we set
  `Authorization: Bearer` too. Bifrost ignores it; it exists to satisfy the
  client-side guard.
- **Model ids are `bedrock/`-prefixed.** Bifrost serves Claude as
  `bedrock/claude-opus-4-8` and the virtual key is scoped to those exact names.
  `Model.id` is *both* the wire id and the key Flue resolves a `useModel()` ref
  against, so the ref is `astro-gateway/bedrock/claude-opus-4-8` (Flue splits
  the specifier on the first slash). `ANTHROPIC_MODEL` stays prefix-agnostic —
  give it either form.

**Providers are registered at agent-module scope** (`agents/ada.ts`), not in a
server bootstrap, because `flue run` loads only the agent module. Registering in
`app.ts` left the CLI path resolving against a registry that had never heard of
the gateway.

Secrets are never logged; `describeAuth()` prints a redacted summary.

## Cost → money

Cost comes from **pi-ai's model catalog**, which prices each turn's usage
(`turn.response.usage.cost.total`) for both the direct and gateway paths. The
hand-maintained `PRICING` table the old build fell back to is gone, along with
the `reported`-vs-`computed` distinction it existed to resolve: there is no
upstream CLI reporting a `total_cost_usd` to prefer any more.

Per-turn figures are surfaced three ways from the same `turn` events: a
replayable `CUSTOM ada.usage` AG-UI event (so the client can sum a session total
that survives reconnect), OTel metrics + span attributes, and a `RunRecord` in
the `ResultStore`.

**Telemetry.** `telemetry/otel.ts` subscribes to the same Flue events and emits
GenAI-semconv spans (root `ada.run` + child `ada.tool`, with token/cost
attributes) plus counters and a cost histogram, via an in-process OTLP/proto
exporter.

> **Changed in the rewrite:** this used to be **opt-in** (`BRIDGE_SELF_TELEMETRY=1`)
> because the `claude` child emitted its own native Claude Code OTel and we
> didn't want to double-emit. There is no child now and no second source, so
> these are the only spans Ada produces — telemetry is **on by default**
> whenever an OTLP endpoint is set. Opt out with `ADA_SELF_TELEMETRY=0`.

| env | purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector (injected by the runner); unset ⇒ no export |
| `OTEL_SERVICE_NAME` | `service.name` (Dockerfile default `ada`) |
| `ADA_SELF_TELEMETRY` | `0` to disable spans even with an endpoint set |
| `OTEL_METRICS_ENABLED` | `1` to add OTLP metrics alongside traces |

OTel dep versions mirror the proven `0.217.0` train used across the other Astro
agents.

---

## Pin list — unstable / version-dependent, pin before production

### Flue (pin `@flue/runtime`, `@flue/cli`, `@flue/vite`)
1. **All three are pinned to an exact version (`2.0.3`), not a range.** Flue 2.0
   is a fresh stable release; the hooks API, the `FlueEvent` union, and the
   generated Node entry are all young surfaces. Treat a bump as a
   breaking-change review — especially of `agent/translate/translator.ts`, which
   pattern-matches the event union exhaustively.
2. **`FlueEvent` carries a format version (`v: 3`).** Branch on it if the shape
   changes rather than assuming.
3. **`@earendil-works/pi-ai` is pinned to `0.83.0`** — the exact version
   `@flue/runtime` resolves. It's a **direct** dependency because
   `config/model.ts` builds a custom provider with `createProvider()`; if the two
   drift apart, npm installs a second copy and the `Provider` types stop being
   assignable (`setProvider()` fails to typecheck). Bump them together.
4. **`toolcall_delta` is in-process only** — never persisted, never replayed. It
   drives live argument previews; `tool_start` remains the source of truth for
   complete arguments. A consumer reading durable history sees only the latter.

### AG-UI (pin `@ag-ui/core`)
5. **Reasoning events changed:** `THINKING_*` was removed in AG-UI **1.0.0** in
   favour of `REASONING_*`. We default reasoning OFF; if enabled, pin the core
   version so we emit the right names.
6. **`RUN_FINISHED.outcome`** is a newer optional field. We omit it for
   legacy-safety — revisit when we pin ≥ a version where it's expected.
7. **Validate against the canonical Zod schemas.** Local types in
   `agent/types/agui.ts` mirror `@ag-ui/core`; add a CI step that parses emitted
   events with the pinned package's schemas so drift fails the build.

### Gateway (Bifrost → Bedrock)
8. **`x-bf-vk` header + `bedrock/`-prefixed model ids** are how Bifrost reads the
   virtual key and resolves models; both were probed empirically and can change
   with the gateway. (The `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` workaround is
   gone with the CLI — pi-ai doesn't send Claude Code's first-party-only
   pre-release `anthropic-beta` flags.)

### Ada-specific extension (document for frontends)
9. **SSE `id:` line for reconnect.** AG-UI's own SSE encoder emits only
   `data: {json}\n\n` (no `event:`/`id:`). We add `id: <seq>` so the browser's
   `EventSource` sends `Last-Event-ID` and we replay the gap from the registry.
   Valid SSE, ignored by clients that don't use it — but it's *our* extension
   to the transport, not part of AG-UI.

## Limitations

- **Conversation history does not survive a restart or redeploy.** Flue's
  conversation database (`agent/db.ts`, SQLite) and the sandbox workspaces live
  on the container filesystem. An Astropods `volume:` can only attach to a
  knowledge *container*, and the out-of-process sandbox that used to provide one
  is gone — so a resumed Slack thread re-clones its repo and starts a fresh
  conversation. GitHub tokens and repo bindings are unaffected (Postgres). The
  durable fix is a Postgres-backed Flue `PersistenceAdapter`
  (`defineSqlConversationStreamStore` in `@flue/runtime/adapter`).
- The model's shell runs in the same container as the control plane — see
  "Execution sandbox" above.
- The AG-UI event log is in memory with no GC yet. (The OAuth CSRF state is no
  longer among these — it is a signed, self-contained token now.)

## Next steps
- **Postgres `PersistenceAdapter`** so conversations survive a restart — the
  single biggest gap, and the one that also restores "resume a Slack thread days
  later".
- Registry durability: cap/spool the event log, GC terminated sessions.
- Harden auth: sign the `bridge_uid` cookie, GC OAuth CSRF state, encrypt tokens
  at rest.
- Fix the two remaining `tsc` errors (`@types/pg`, OTel SDK `metricReader` types
  — both pre-date this rewrite) and add a CI typecheck + AG-UI schema validation
  alongside the e2e workflow.
- Consider a remote sandbox adapter to restore the out-of-process isolation
  boundary.
