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

> Status: **usable, with SCAFFOLD edges.** Real: multi-turn conversations
> durable in Postgres, isolated execution in a secret-less sandbox container,
> GitHub per-user OAuth, the Astro AI Gateway path, Slack/web messaging,
> secure-by-default enforcement, and OTel tracing. Still `TODO`: AG-UI event-log
> GC, cookie signing, and token encryption-at-rest (grep the source, and see
> Limitations).

## Why Flue, and not the Claude Agent SDK

Ada used to run Claude Code headlessly: a `claude -p` child process whose
newline-delimited `stream-json` was parsed and re-emitted. That worked. The
reasons for moving are worth stating, because they are about the **harness**,
not about the model.

**What we gained, each of which is load-bearing somewhere in this repo:**

- **The toolset is closed by default.** The `claude_code` preset exposed its
  whole toolset and had to be pruned with a `DEFAULT_DISALLOWED_TOOLS` deny
  list — and `allowedTools` only auto-*approves*, it does not restrict. Flue
  mounts exactly what the render declares. That deny list is gone.
- **The render is dynamic, so capabilities are real.** Asking Ada to turn code
  review off genuinely unmounts the delegate on the next render
  (`usePersistentState` + a conditional `useSubagent`), rather than leaving a
  tool advertised to a model that must be told not to use it.
- **There are lifecycle seams.** `useAgentFinish` runs at every would-stop
  point and can send the model back to work. The security gates — "you changed
  a route and touched no test", "there is a credential in this diff" — have no
  clean equivalent when your integration point is a child process's stdout.
- **No unversioned wire contract.** A typed event union replaced `stream-json`,
  which was pin #1 in this document and forced the `claude` CLI version to be
  pinned in the image.
- **The sandbox is an interface.** Restoring out-of-process execution meant
  implementing nine methods; the agent loop, tools, gates, and reviewer were
  untouched. The pre-Flue version of that split needed a bespoke HTTP protocol
  and SSE forwarding of raw stream-json.
- **The model credential never reaches a child process.** The loop runs
  in-process, so nothing has to hand a key to a spawned binary.
- **Durable instances.** Conversation history is framework-owned and keyed by
  instance id, which deleted a resume-id map and a `--resume` flag.
- **An ecosystem to lean on.** `@flue/opentelemetry` and `@flue/postgres`
  removed ~440 lines of hand-written instrumentation and an entire persistence
  adapter (see the pin list — check the registry before you build).

**What we gave up, which is the honest other half:**

Claude Code's harness is heavily tuned for coding by people with far more
evaluation data than this repo has: its system prompt, tool descriptions,
compaction behaviour, and sub-agent patterns are the product of that tuning.
Flue hands you primitives instead, so **the quality of the coding loop is now
Ada's problem**. The `ROLE` prompt below is a few lines against something
iterated on at length. We have measured nothing: there is no benchmark here
comparing task success before and after, and the architectural wins above say
nothing about whether Ada writes better code than it did.

The defensible claim is narrow and, we think, correct for this project: **for
an agent that must be embedded, constrained, observed, and extended, Flue is
the better fit — and the coding quality that the Claude Code preset used to
provide for free is now a debt we owe.** The security layers, the reviewer, and
the repo-conventions injection are the beginning of paying it. If Ada's output
quality regresses against the old build, that is the first place to look, not
the framework.

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

**Only one of them starts turns.** `POST /agents/ada/:id` — Flue's prompt
dispatch — is refused with a 405. It renders the agent without going through
`SessionRunner`, and the per-session context that selects the sandbox is
published by the runner immediately before it dispatches. A render that skips
the runner found nothing and fell back to executing in the **control-plane
container at `process.cwd()`**: the model's shell and file tools on Ada's own
source tree, with no per-conversation workspace and none of the sandbox
isolation, even with a sandbox container deployed.

Refusing rather than wiring the setup into that path is deliberate. Publishing a
context there would fix the isolation and still leave native dispatch bypassing
the concurrency limiter, the translator and its registry mirroring (so no AG-UI
stream, no SSE, no conversation-review record) and the run records — a second,
half-instrumented way to run a turn, which is the kind of divergence that
produced the bug. One supported path, and it is the one that sets up isolation.
Reads, aborts and attachment fetches over the native router are untouched.

| Route | Purpose |
|---|---|
| `GET  /` | Built-in AG-UI test client (`public/index.html`) |
| `POST /sessions` `{prompt}` | Start a session → `{sessionId}`. Also accepts `multipart/form-data` (`prompt` + `files`) |
| `POST /sessions/:id/messages` `{prompt}` | Continue a session with a follow-up turn. Same two encodings |
| `DELETE /sessions/:id` | Drop a session (event log, workspace, Flue state) |
| `GET  /sessions/:id/events` | SSE AG-UI stream; honours `Last-Event-ID` replay |
| `GET  /conversations` | List handled conversations (admin-gated) |
| `GET  /api/whoami` | Resolved identity + admin + GitHub connection state |
| `GET  /auth/github/login` · `/callback` · `/status` | Per-user GitHub App OAuth |
| `GET  /api/setup/github/start` · `/callback` · `/api/setup/status` | Web-driven GitHub App provisioning |
| `GET  /agents/ada/:id` · `/abort` · `/attachments/:aid` | Flue's native agent routes (`@flue/sdk`) — admin-gated, **read/abort only** |
| `POST /agents/ada/:id` | **405** — native prompt dispatch is refused; use `POST /sessions` |

**Attachments split by MIME type, because Flue's delivery contract does.**
Both turn endpoints take `multipart/form-data` alongside JSON; JSON stays the
shape for a plain prompt, so the messaging adapter and external AG-UI clients
are untouched. Images (`png`/`jpeg`/`gif`/`webp`) ride as native Flue
attachments and the model *sees* them — that is the only attachment shape Flue
accepts today. Everything else is written into the session sandbox at
`uploads/<name>` and named in the prompt, which is both what Flue allows and
what is actually useful: a log or a heap dump is something the agent greps and
runs tools against, not something a model reads by looking at it. The path is
`uploads/<name>` in either sandbox mode, since local runs are rooted at the
workspace and remote runs at the workspace subdir.

The filename arrives from the browser, is joined onto a sandbox path, and is
interpolated into the prompt line naming the file — so it is reduced to a
`[A-Za-z0-9._-]` basename before any of that, and names that collide after
sanitizing are suffixed rather than allowed to overwrite each other. The MIME
type is browser-supplied too and shares that prompt line, so it is reduced the
same way. Limits (10
files, 5MB an image, 25MB a file, 50MB a message) are refused with a message
rather than silently trimmed: dropping the oversized attachment would have the
agent answer confidently about a file it never received. Those checks read
parsed bytes, so a `bodyLimit` of 58MB refuses on the request itself first —
above the real limit on purpose, so a batch that busts it still gets the
message naming the file to drop rather than a bare 413.

A follow-up turn CLAIMS the session's single turn slot before its body is read,
rather than probing `busy()` and dispatching afterwards — for a multipart turn
the read is long enough that two concurrent follow-ups would both pass a probe,
and neither would get the 409 the AG-UI client relies on. The slot is handed
back if the turn is abandoned before dispatch.

Only one turn runs at a time per session — an overlapping `POST .../messages`
returns `409 busy`. (Flue serializes concurrent deliveries to one instance
anyway; the 409 is kept because the AG-UI client relies on it to keep its own
turn state coherent.) When a deployment gates access, an unauthorized request
gets a themed `401` instead of the app shell.

### Who may touch which session

Being **authorized** and being the **owner** are different questions, and
conflating them was a real hole. `allowed` (the grants table) says whether
someone may use Ada at all; it says nothing about whose conversations they may
reach. A session id was the only thing between one authorized user and another's
repo checkout, GitHub identity, and private-repo content.

Every `/sessions/:id` route — read, drive, delete — now goes through one
predicate, `maySession()`:

| Session | Who may touch it |
|---|---|
| `kind: "slack"` | admins only (a chat conversation is someone else's by construction) |
| `kind: "browser"` with a recorded owner | that owner, or an admin |
| no recorded owner | admins only — treated as nobody's, not everybody's |
| unknown id | passes, so the route answers **404** rather than 403 |

That last row is deliberate: "no such session" has to stay distinguishable from
"not yours", or a user's own tooling cannot tell a stale id from a permissions
problem. The check also runs **before** the existence and `409 busy` tests, so
probing ids cannot reveal which exist or which are mid-turn.

`/agents/ada/*` is **admin-gated as a whole**. It was previously mounted with no
gate at all, which made it an unauthenticated route to the same durable
instances the AG-UI path protects. It is gated by admin rather than by
per-session ownership on purpose: the registry that would answer "who owns this
instance?" is **in-memory** while Flue's instances are **durable**, so after a
restart a live Slack conversation is absent from the registry and an ownership
check would read as "unknown, allow".

"Admin" means `ADMIN_EMAILS` matched against the ALB-verified email — and when
**no** admin list is configured, any authorized user passes. That is the
documented single-tenant/dev posture (the same one `/conversations` has), not an
oversight: **set `ADMIN_EMAILS` in any deployment with more than one user.**
Ownership is only as strong as the identity behind it; in a deployment that is
the ALB-verified platform id, while locally it falls back to the unsigned
`bridge_uid` cookie (see the `TODO` on `ensureUid`).

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
  It also governs cross-user session access (see "Who may touch which session"),
  so **set it in any multi-user deployment**: unset means every authorized user
  can read, drive and delete every other user's conversations.
- **`GITHUB_APP_PUBLIC`** (optional input, default `false`) → provision the GitHub
  App **private** (single-tenant). Set `true` for **multi-tenant** so any
  teammate can install it on their own repos and connect via chat.
- The image bakes in **`git` + `gh`** — the toolchain the sandbox shells out to.
  There is no `claude` CLI to install and no `CLAUDE_CODE_VERSION` to pin.

`dev.command` (`node --watch agent/index.ts`) is the `ast dev` hot-reload path:
the container bind-mounts `agent/` so host edits reload live (this is why the
source lives in `agent/`). Local `ast dev` adapters are `[web, slack]`.

## Tests

End-to-end tests (Playwright), none of which need a model credential or a
network — model turns run against pi-ai's faux provider, so the real Flue
runtime, interceptors, and hooks are exercised offline.

```bash
npm install
npx playwright install --with-deps chromium   # one-time browser download
npm test                                       # or: npm run test:ui
```

| Spec | Covers |
|---|---|
| `server-sse.spec.ts` | `Last-Event-ID` beats a stale `?lastEventId` query; `DELETE /sessions/:id` semantics |
| `session-authz.spec.ts` | Whose session an authorized user may read/drive/delete; `/agents/ada/*` is gated; 404-vs-403 |
| `github-connect.spec.ts` | `connect github` authorizes rather than opening a repo picker; guidance never asks users to grant repo access |
| `thread-context.spec.ts` | A Slack mention reads the thread in; an empty first read is retried (bounded), capped, and degrades when unavailable |
| `native-router.spec.ts` | Native prompt dispatch is refused; a context-less render still selects the sandbox |
| `background-turn.spec.ts` | `POST /sessions` returns before the turn settles; a pre-dispatch failure still reports |
| `chat-brevity.spec.ts` | Slack gets the brevity instruction, the browser does not, and it survives follow-ups |
| `shell-quote.spec.ts` | POSIX quoting survives the real shell; the `JSON.stringify` bug it replaces |
| `client-reconnect.spec.ts` | Repeated full-buffer replays render `✓ finished` exactly once |
| `client-delete.spec.ts` · `client-autoscroll.spec.ts` · `client-followup-delivery.spec.ts` | Built-in AG-UI client behaviour |
| `security-gates.spec.ts` | Every gate rule, in **both** directions, against real git repos |
| `reviewer-subagent.spec.ts` | Actually **invokes** the delegate via the `task` tool |
| `repo-rules.spec.ts` | Convention discovery: casing, nesting, symlinks, truncation |
| `remote-sandbox.spec.ts` | The isolation boundary — containment and env leakage — over real HTTP |
| `telemetry.spec.ts` | A real agent turn's trace: names, parenting, durations, no content capture |
| `persistence.spec.ts` | Backend selection always; a real restart when `ADA_TEST_POSTGRES_HOST` is set |

Two habits worth keeping, both learned the hard way here:

- **Assert both directions.** A gate that stops firing is a control silently
  removed; one that fires when it shouldn't gets argued past. Every rule asserts
  the exact set that fires.
- **Prove the test fails on the bug.** The reviewer delegate shipped broken
  because 32 tests were green — nothing had ever *invoked* it. Its regression
  test was confirmed to fail against the original bug before being kept. A
  regression test that never fails is a slower green tick.

`POST /test/seed` is exposed ONLY when `ADA_TEST_HOOKS=1` (set by
`playwright.config.ts`'s `webServer`); it's inert in production. CI runs the
suite on every push to `main` and every PR (`.github/workflows/e2e.yml`).

## Architecture

One internal pipeline. Flue's event stream is the single source of truth: the
translator and the result store consume it through the session runner, and
telemetry subscribes globally and independently (see "Cost → money" for why not
through the runner). The same pipeline feeds both the SSE/AG-UI frontend and the
messaging sidecar.

```
 HTTP (POST /sessions) ─┐
 Slack / web (sidecar) ─┴─▶ SessionRunner
                                │  setSessionEnv(id, …)   ← workspace, GH token, repo
                                │  init(Ada, {id}).dispatch(prompt)
                                ▼
                          Flue agent loop  (in-process)
                                │       └─ sandbox: remote container, or local()
                                │  observe() — FlueEvent stream
        ┌───────────────────────┴───────────┐
        ▼                                   ▼
   Translator                          ResultStore
        │                              (usage + cost)
        │        @flue/opentelemetry ──▶ OTel traces + metrics
        │        (registered globally, not via the runner)
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
| `agent/agents/security/*` | Secure-by-default: always-on principles, on-demand skills, enforced diff gates, and the reviewer delegate. |
| `agent/agents/repo-rules.ts` | Injects the project's own conventions that Flue's workspace discovery missed. |
| `agent/session/remote-sandbox.ts` | `SandboxDriver` over HTTP to the isolated execution container; selection by injection. |
| `agent/store/pg-config.ts` | One reading of the Postgres env, shared by Flue's adapter and Ada's Store. |
| `agent/config/model.ts` | **Isolated swap seam.** Model resolution, the custom Astro AI Gateway pi-ai provider, and the scrubbed sandbox env. |
| `agent/session/runner.ts` | Drives Flue instances (`init`/`dispatch`/`read`), fans `observe()` events into the registry, telemetry, and results. |
| `agent/translate/translator.ts` | Pure `FlueEvent` → AG-UI mapping. Stateful per session. |
| `agent/session/registry.ts` | Per-session AG-UI event log with monotonic seq → lossless reconnect. Decoupled from transport. |
| `agent/session/workspace.ts` | Per-session writable workspace (the sandbox cwd), reused across turns, TTL-GC'd. |
| `agent/db.ts` | Flue's durable conversation store: Postgres deployed, SQLite locally. Read by both server entries. |
| `agent/app.ts` | The Hono route map: AG-UI routes, Flue's native routes, auth, setup. |
| `agent/index.ts` | Standalone Node entry — `start()`s the runtime, then serves `app.ts`. |
| `agent/messaging/adapter.ts` | `AgentAdapter` for the Astro messaging sidecar (web/Slack); directives + delegation to the runner. |
| `agent/auth/*` | Per-user GitHub App OAuth, App-Manifest provisioning, signed chat connect links, ALB-identity resolution. |
| `agent/store/*` | Postgres-backed store (GitHub tokens, App creds, repo bindings, server secret); in-memory fallback. |
| `agent/transport/sse.ts` | AG-UI SSE framing + `Last-Event-ID` replay. |
| `agent/telemetry/*` | Installs `@flue/opentelemetry` (content capture off) plus Ada's cost metric. |

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

Ada is opinionated about how code gets written. The opinions live in five
layers, and the layering is the design — each does something the others can't.

| Layer | Where | Cost | What it achieves |
|---|---|---|---|
| **Principles** | `security/principles.ts` → `useInstruction()` | every turn | Suggests. Five rules that apply to nearly every change |
| **Skills** | `security/skills.ts` → `useSkill()` | one catalog line until activated | Informs. Detailed playbooks, loaded only when relevant |
| **Gates** | `security/gates.ts` → `useAgentFinish()` | per stop-point | **Enforces.** Reads the real diff and sends the model back |
| **Repo rules** | `repo-rules.ts` → `useAgentStart()` | per turn | The project's own conventions, which override Ada's defaults |
| **Reviewer** | `security/reviewer.ts` → `useSubagent()` | per substantive change | Independent judgement over content, with fresh context |

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

### Repository conventions

Ada reads the project's own rules before it plans. Flue does some of this
itself — `readAgentsMd` pulls `AGENTS.md` and `CLAUDE.md` from the sandbox cwd
into the system prompt — but two assumptions in that broke against a real repo,
and Ada opened a PR with no changelog because it had never seen the rule
requiring one:

- **The working directory.** Flue reads from the sandbox cwd. Ada only rooted
  that at the checkout when a thread was bound with `work on owner/repo`; when
  the model cloned the repo itself, cwd stayed at the workspace root with the
  checkout one level below, where discovery does not look. Fixed on both ends:
  `checkout_repo` now records the directory so the next turn is rooted inside
  it, **and** the rules are found regardless of depth.
- **The filename.** The lookup is two exact, case-sensitive literals. The repo
  in question ships lowercase `agents.md` and only survived because `CLAUDE.md`
  happens to be a symlink to it. Watch for this locally: macOS is
  case-insensitive, so a lowercase rules file resolves on a laptop and vanishes
  in the Linux container.

`agents/repo-rules.ts` runs at `useAgentStart`, searches the cwd and any git
checkout one level below it, matches `AGENTS.md`/`AGENT.md`/`CLAUDE.md`/
`CONVENTIONS.md` case-insensitively, and injects what Flue would have missed as
a signal stating that repo rules **override** Ada's defaults. It skips anything
already in the system prompt, dedupes a symlinked duplicate *within* a directory
(not across them — that silently dropped a sibling repo sharing a preamble), and
says so explicitly rather than truncating a long rulebook in silence.

### The reviewer (layer five)

Gates are heuristics over paths and diff text; they can tell you a route changed
with no test touched, but not that the test you added mocks the thing under test
and asserts nothing. That needs judgement, so a **`code-reviewer` subagent** runs
on substantive changes before Ada finishes.

Its analytical lenses are ported from
**[Cruise Line](https://github.com/astropods/cruise-line)**, the PR-review agent
shipped separately — specifically its four sharpest ones: *test quality* ("bad
tests are worse than no tests"), *error handling*, *API contract*, and
*concurrency & data integrity* (missing transactions, TOCTOU, uniqueness enforced
in app code). What did **not** come across is Cruise Line's output plumbing —
`::diff{}` render directives, PR line anchors, Mermaid diagrams, an
approve/request_changes verdict, and `fixPrompt` ("a prompt to paste into Claude
Code", meaningless when Ada *is* that agent). Ada needs findings it will fix
itself.

**Why a subagent and not another instruction:** Flue runs a delegate in isolation
from its parent — fresh context, none of the reasoning that produced the code. An
agent re-reading its own work in its own context is the weakest possible reviewer;
it has already convinced itself. That isolation is the whole point.

| | |
|---|---|
| **Trigger** | A substantive change: ≥1 code file and ≥20 changed lines (`ADA_REVIEW_MIN_LINES`). Docs-only and one-line fixes are skipped — the reviewer costs a full model pass, and firing it on trivia is how a useful control gets switched off |
| **Budget** | Keyed on a diff **fingerprint**, not the session. Asked once per change; asked again if the change grows afterwards |
| **Enforcement** | Critical/high findings send Ada back to fix them. Medium and below are reported in the summary and the PR's Security notes |
| **Default** | `ADA_REVIEWER_ENABLED` (astropods input, default `true`) |
| **Runtime toggle** | Ask Ada to turn review off and it calls `set_review_mode` — durable for the conversation, and it genuinely **unmounts the delegate** on the next render rather than just being told to ignore it. `set_review_mode` stays mounted so it can always be turned back on |

That toggle is the dynamic-agent property the hooks API exists for: the flag is
`usePersistentState`, and the render conditionally calls `useSubagent()`. Flue
narrates the resource change to the model, so it knows its capabilities shifted.

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

**Mention Ada mid-thread and it reads the thread.** The sidecar delivers only
the message that triggered the turn, so a bare *"Ada fix this"* used to arrive
with the pronoun and none of its referent — Ada had to ask what "this" was,
which is the friction the mention was meant to avoid. The first mention in a
conversation now pulls the thread in via `getThreadHistory()` (adapter-core
≥ 0.10) and prepends it as a `<thread>` block, oldest first, with Ada's own
replies and the triggering message left out.

Once per conversation, not per turn: a Slack thread *is* a Flue instance, so
after the first turn the conversation history already carries it. "Once" is
bounded-retry rather than one-shot, because the first mention is frequently the
one that *opens* the thread — "Ada, can you look at this?" has nothing above it,
and treating that empty read as spent meant the next message, the one pasting
the actual error, was never picked up. Every read costs an attempt (3), and only a read
whose block reached a turn that actually settled is terminal — a turn that dies
or is superseded before it lands must not leave the thread marked read, since a
first-turn failure is exactly the case this exists for. The trade is
that humans talking to each other in the thread *between* Ada's turns aren't
picked up — Ada only receives messages addressed to it. The block is capped
(40 messages, ~4KB, 600 chars per message) and trims the *oldest* first, since
the end of a thread is what a mention usually refers back to. If the platform
can't hydrate the thread, the turn runs on the user's message alone.

Thread text is untrusted, and treated that way. A participant who types
`</thread>` in a message (or in their display name) would otherwise close the
block early and have everything after it read as a top-level instruction, so
those delimiters are escaped rather than dropped — the message still says what
the person typed. Ordering is not assumed either: adapter-core specifies none
for `getThreadHistory`, so the messages are sorted oldest-first on the protobuf
`timestamp` they all carry, and fall back to the platform's order only when
none is supplied.

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

The model's commands run in a **separate container** that holds none of the
control plane's secrets — no database credentials, no GitHub App client secret,
no HMAC signing key, no model credential. A rogue `bash` therefore runs in a
process with nothing worth taking in it.

Reaching no **further than its own conversation** is a separate guarantee, and it
takes two different mechanisms, because a path and a program are not the same
kind of thing:

| | contained by | how |
|---|---|---|
| File endpoints (`/read`, `/write`, …) | path resolution | every caller-supplied path is resolved inside that instance's directory and rejected if it escapes |
| Shell commands (`/exec`) | the kernel | one unprivileged uid per instance, workspace `chmod 0700`, commands spawned as that uid |

The second row exists because the first cannot cover it. Path resolution checks
an *argument*; a shell command is a *program*, and `cat /data/<other>/secret` is
a perfectly valid one. That gap was real — the file endpoints refused a
cross-instance read while the shell performed it — and the fix is to stop
checking strings and let the filesystem enforce it on the inode.

Confining commands means dropping privileges, so it needs the service to run as
root (it does in this image — no `USER` line). Where it can't, `/health` reports
`confinement: "none"` and startup warns loudly, rather than quietly serving a
weaker guarantee than the docs promise; the file endpoints stay contained
regardless. A test asserts the report *matches reality* in whichever mode it is
in, because "unconfined while claiming otherwise" is the failure worth guarding.

**Path containment, and what it is trusted to do.** Paths are resolved
symlink-by-symlink with `lstat`/`readlink`, so a *dangling* link is still seen as
a link. That resolver has been wrong twice — once for a symlink to an existing
target, once for a dangling one, and the second let a root-privileged `/write`
create a file anywhere in the container — so it is no longer trusted alone:

- The actual open uses **`O_NOFOLLOW`**. The resolved path never legitimately
  ends in a symlink, so telling the kernel that turns a future resolver bug into
  an `ELOOP` error instead of a write outside the workspace. It also closes the
  final-component race, where a concurrent command swaps that component for a
  symlink between resolve and open.
- A **property test** generates symlink shapes — inside/outside,
  absolute/relative, dangling/existing, chained, via traversal — and asserts the
  *invariant* rather than the verdict: whatever the service decides, nothing may
  exist outside the workspace afterwards, and an accepted write must have landed
  inside. It catches both historical escapes at the first iteration without
  either being enumerated, which is the point — listing cases is the method that
  missed them twice. Seeded, so failures reproduce (`ADA_FUZZ_SEED`).

**Residual risk, stated rather than assumed.** An *intermediate* path component
can still in principle be swapped for a symlink between resolution and the open.
The kernel's answer is `openat2` with `RESOLVE_BENEATH`, which Node does not
expose; closing it would take a native addon, or running the file operations in a
process under the instance's uid — correct by the same mechanism as the shell, at
the cost of a process spawn per operation on a container limited to a tenth of a
core. Neither is done today. Also not covered: the **network**, which every
command shares, so this is filesystem isolation between conversations rather than
a general-purpose sandbox.

Build caches are per-instance rather than shared across conversations — partly
necessity (a dropped-privilege command can't write root's cache dirs) and partly
the point, since a shared *mutable* cache is a channel between conversations that
a uid split alone wouldn't close. Caching within a conversation is unchanged.

The two halves also have to agree about **who owns the workspace**. File
endpoints run in the service process (root); commands run as the instance's uid.
Left unreconciled, everything `/write` and `/mkdir` produced was root-owned, so
the shell could read it and not touch it — which breaks the agent's core loop,
not an edge case: write a file, then run the formatter, the codegen, the test
that rewrites a snapshot, the `git checkout` that touches it. New entries are
therefore handed to the instance's uid, using the topmost directory
`mkdir(recursive)` reports having created so nothing pre-existing is disturbed.
Confinement that costs the agent the ability to do its work is not a good trade,
so the tests assert both directions: the boundary holds *and* the workspace
stays usable.

The switch is automatic. The platform injects `KNOWLEDGE_SANDBOX_HOST` when
`knowledge.sandbox` is deployed, and `agent/session/remote-sandbox.ts` routes
execution there; with no sandbox service, Ada falls back to Flue's in-process
`local()` sandbox, which is how `node agent/index.ts` and `flue run` work.

**Three modes, while the platform sandbox is being proven.** `ADA_SANDBOX` is a
declared input, so it is settable per deployment without a code change:
`astro` for a platform MicroVM per conversation
(`agent/session/astro-sandbox.ts`), `container` for the service above, `local`
for in-process. It defaults to `auto`, which is the behaviour every deployment
had before there was a choice — container when the platform injected one, local
otherwise. So a deployment moves onto the MicroVM and back off again by
changing one value, and startup prints which boundary is live, marking it
`(auto)` when it was inferred (`[ada] sandbox: …`).

**Local runs are admin.** `isAdmin` matches a verified email, and only the ALB
in front of a deployment supplies one — so off a deployment the email is always
empty and `ADMIN_EMAILS` can only ever *deny*. Setting it to grant yourself
admin locally did the opposite: it flipped `mayViewOthers` from "no list, so
open" to "a list, and nothing can match it", hiding the Slack conversations it
was meant to reveal. Nothing is widened by this default — with no deploy token
there is no identity to check and web access is not gated either, so the admin
surface now agrees with the authorization surface instead of being stricter
than a boundary that is already absent. `ADA_LOCAL_ADMIN=0` declines it, which
is how `test/session-authz.spec.ts` exercises a deployment's rules.

`ADA_SANDBOX=astro` with no `ASTRO_AUTHZ_TOKEN` does **not** fall back. Falling
back would run the model's commands in the control-plane process, which holds
the database credentials, the GitHub App secret and the HMAC signing key — a
misconfiguration must not be able to turn the boundary off, so the turn fails
instead. `ADA_SANDBOX=container` with no host injected refuses for the same
reason.

**What Flue changed about this.** The pre-rewrite version of the split was a
Claude Code runner: it took a prompt, spawned `claude -p`, and streamed raw
stream-json back over SSE — so it had to know about models, credentials, resume
ids, and tool policy, and it shared source with the control plane. It is now a
dumb filesystem-and-shell server implementing exactly Flue's `SandboxDriver`:

```ts
interface SandboxDriver {
  readFile, readFileBuffer, writeFile, stat, readdir, exists, mkdir, rm,
  exec(command, { cwd, env, timeoutMs, signal }): Promise<ShellResult>
}
```

Nine operations, no agent concepts at all. The agent loop, the built-in
file/shell tools, the security gates, the reviewer subagent, and `AGENTS.md`
discovery all talk to the `Sandbox` interface and neither know nor care that
execution is a network hop away. Swapping in E2B, Daytona, or Modal instead is
the same one-line change at `useSandbox()`.

Two properties make the isolation real, and `test/remote-sandbox.spec.ts`
asserts both against the service over real HTTP:

- **Workspace containment.** Every path is resolved inside the requesting
  instance's own directory and rejected if it escapes. The check is
  **symlink-aware**: it resolves lexically, then resolves symlinks on the
  deepest existing part of the path and compares that against the real base.
  A purely lexical check defeats `../` and absolute paths but not a symlink —
  the model can `ln -s /etc/passwd link` inside its own workspace and
  `readFile` will follow it out. That shipped, and is now covered both ways
  (a symlink leaving the workspace is rejected; one staying inside still works).
- **Environment.** The service builds each command's env from an allowlist
  rather than inheriting its own, so a variable an operator adds to the
  container never reaches a command the model runs. The user's `GH_TOKEN` is
  sent **per request** and never persisted, so it exists there only for the
  duration of the command using it.

`SANDBOX_TOKEN`, when set on both sides, requires a shared secret on every
call. Unset, the service trusts its network — acceptable only because the
platform does not route to a knowledge container externally, and it warns
loudly at startup.

`/data` is the sandbox's volume: one directory per conversation (TTL-swept) plus
build caches, so a repeat build doesn't re-download a toolchain.

**The sandbox image is where project toolchains go.** The agent's commands run
there, not in the control plane, so a tool the image lacks is a tool Ada cannot
use — it will report "not verified locally" and open a PR without having run
the checks. The image ships `git`, `gh` and `bun`; extend it with build args:

```bash
--build-arg SANDBOX_NPM_PACKAGES="bun@1.3.9 pnpm"
--build-arg SANDBOX_APT_PACKAGES="python3 golang-go"
```

Build args rather than runtime env deliberately: installing at boot would mean
a package fetch on every cold start, a network dependency in the container that
must keep working when things are broken, and mutable tooling in the one
process that runs model-authored commands. There is no way to make the image
universal, so treat the list as deliberate and reviewed — every addition is
attack surface exactly where it matters most.

> **Two things this got wrong on the first deploy**, both worth knowing if you
> touch this code. The sandbox cwd handed to `sandboxFromDriver` **must be
> absolute** — Flue resolves tool paths as `p.startsWith("/") ? p : cwd + "/" + p`,
> so a relative cwd makes `resolvePath(".")` normalise to `/`, and then every
> `bash`/`read`/`grep`/`glob` call is rejected as escaping the workspace. The
> factory therefore asks the container for its own workspace path rather than
> guessing a layout the control plane cannot see. And `checkout_repo` must
> clone **where execution happens**: cloning locally in a deployment running the
> sandbox reported success at a path the agent's own shell could never reach.

#### Staying inside the container's memory budget

The sandbox is a **small, fixed** container — measured at a 1GiB memory limit and
a CPU quota of a tenth of a core — and the platform does not let it be resized.
Every build the agent runs has to fit in that, so the service treats memory as a
hard budget rather than an afterthought.

**A CPU quota is invisible to the usual ways a tool picks its parallelism.**
Measured inside `--cpus=0.1 --memory=1g` on `node:24-slim`:

| what a tool asks | what it gets |
|---|---|
| `/sys/fs/cgroup/cpu.max` | `10000 100000` — a tenth of a core |
| `nproc`, `getconf _NPROCESSORS_ONLN` | **12** (the *host's* cores) |
| `os.cpus().length` | **12** |
| `os.availableParallelism()` | 1 — the only quota-aware one |

So a test runner or bundler sizing its pool from `nproc` or `os.cpus()` forks a
dozen workers the quota will never run concurrently, and an idle Node worker is
~45MB resident before it does any work. The fan-out alone can spend the whole
memory limit on parallelism the CPU quota forbids. `GOMAXPROCS`/`GOMEMLIMIT`
already covered the Go toolchain (and so esbuild, which is Go); `sandbox/Dockerfile`
sets the equivalents for everything else (`MAKEFLAGS`, `npm_config_jobs`,
`VITEST_MAX_THREADS`, `NX_PARALLEL`, `TURBO_CONCURRENCY`, `CARGO_BUILD_JOBS`,
`UV_THREADPOOL_SIZE`, `NODE_OPTIONS`), and `BASE_ENV_KEYS` in `sandbox/index.ts`
forwards them — setting them in the image without forwarding them would tune only
the service, which is not where builds run.

**Captured output is bounded at both ends.** Retaining more than the caller can
consume is pure cost, and the caller's limit is set by Flue: `bash` truncates to
the last 2000 lines or 50KB. The previous version asked `execFile` for 16MB *per
stream* with the default utf8 encoding, which is worse than it looks — Node
decodes each chunk to UTF-16 (2×), joins them (2× again), then `JSON.stringify`
escapes it and `res.end` re-encodes. One 16MB command cost **+152MB RSS**, and
~320× of what was buffered and sent was discarded on arrival. The service now
keeps a bounded **head** and **tail** window and elides the middle in-band.

Both ends, because the consumers disagree about which one they want: `bash` keeps
the tail (`truncateTail`), while `grep` takes the **first** 100 matching lines.
Keeping only one end would silently change which matches a search reports — so
the tests assert the two derived views byte-for-byte against the output as if
nothing had been elided. Measured after: the same command costs **+21MB**, and
four concurrent 20MB commands peak at **56MiB of the 1GiB limit**.

A side benefit: `execFile`'s `maxBuffer` *killed* the child when exceeded, so a
verbose but perfectly successful build came back as a failure with partial
output. Bounding the capture ourselves decouples "how much we keep" from
"whether the command may finish".

**A timeout kills the whole process tree.** This was a leak, not a tidiness
point. `execFile`'s timeout signals the direct child — `/bin/sh` — and leaves its
descendants orphaned and *running*; a `bun install` or `tsc` that timed out kept
its memory for as long as it liked, and the next command started on top of it.
Commands now run `detached` in their own process group so the timeout can reap
the group. (Verified against the old implementation, where the grandchild
survived.)

**Other bounds**, all overridable by env without a rebuild:

| knob | default | why |
|---|---|---|
| `SANDBOX_MAX_HEAD_BYTES` / `SANDBOX_MAX_TAIL_BYTES` | 256KB each | ≫ the 50KB any caller can consume |
| `SANDBOX_MAX_CONCURRENT_EXEC` | 2 | bounds *commands*, where `MAX_CONCURRENT_RUNS` bounds *runs* — one run issues many tool calls, and a reviewer delegate issues its own. Under a fractional CPU quota extra parallelism buys no wall-clock, only peak memory. |
| `SANDBOX_MAX_READ_FILE_BYTES` | 16MB | a read is amplified on the way out (bytes → base64 → UTF-16 → JSON). Oversized reads are **refused with a message naming the way out**, not truncated: the model *edits* these files, and a partial read it believes is whole is how a truncated file gets written back. |

The service's own heap is capped on the `CMD` line (`--max-old-space-size=96`).
Left alone, Node sizes its heap from the cgroup limit — measured at 560MB of a
1GiB container — and a heap it is *entitled* to grow into is memory the builds
cannot have. It idles at ~38MiB. The workspace TTL sweep is also asynchronous;
the synchronous version blocked the event loop for as long as it took to delete
a monorepo tree, which at a tenth of a core is long enough to look hung.

Finally, clones pass `-c pack.threads=1`. That is a memory control: `git
index-pack` runs one delta-resolution thread per detected CPU (capped at 3) and
its own docs note the delta-window memory is *multiplied* by the thread count.

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

## GitHub access: two grants, not one

Worth stating plainly, because conflating them cost a user an afternoon.

| | who does it | what it decides |
|---|---|---|
| **Installation** | an org owner, once per org | *which repositories* the App may touch |
| **Authorization** | every person, once each | *who Ada acts as* — a user-to-server token |

A user token reaches the **intersection**: repos the installation covers and the
user can see. So someone joining an org where the App is already installed needs
only to authorize — `connect github` — and should never be shown a repo picker.

`/auth/github/login` therefore goes to GitHub's **user-authorization** endpoint
by default. `?install=1` reaches the installation screen, for the cases that
genuinely need it: the first install in an org, or adding personal repos.

It used to be the other way round, on the reasoning that
`request_oauth_on_install` makes an install authorize too. It does — but it
asked every user to configure an installation, which most cannot do and none
need. In an org where IT had already installed the App, the picker offered an
installation the user had no rights to change and GitHub refused with **access
denied**, on a step that was never necessary; choosing their personal account
instead produced a token with no access to the org's repos, so the clone failed
and Ada reported being unauthenticated. A loop with no exit for the person in it.

Two smaller things fell out of the same report. A `403` on push is an **org
owner's** problem, not the user's, so the prompt guidance now says that instead
of telling them to reconnect and grant repo access — advice that sends them
back into the picker they cannot use. And a chat-initiated connect no longer
redirects to `/` on success: a Slack user has no reason to be authorized for the
web UI, and bouncing them there served the themed 401 *after* the token was
already stored, so a successful connection ended on a page saying access denied.
They get their own confirmation page now.

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

## Durable conversations

Flue keys an instance's message history, submission log, and settled replies off
the instance id, which is what makes a follow-up turn work at all — it replaced
the old `claudeSessionIds` map and the `--resume` flag it fed.

`agent/db.ts` picks the backend:

| | |
|---|---|
| **Deployed** | **Postgres**, via `@flue/postgres` — conversations survive a restart or redeploy |
| **Local** | SQLite under `WORKSPACE_ROOT` (or `ADA_DB_PATH`), so `flue run` and `node agent/index.ts` need no database |

The adapter owns its schema: seven `flue_`-prefixed tables created and
version-checked by `migrate()`, which the runtime calls at startup. Nothing in
this repo writes DDL for it. They share the platform Postgres with Ada's own
`github_tokens` and `kv` tables — the prefixes don't collide, and both read
their connection settings from `agent/store/pg-config.ts` so a deployment can't
end up with one connected and the other silently on a fallback.

The driver is ours on purpose: `@flue/postgres` takes a runner rather than
bundling a client, so pooling, TLS, and timeouts stay under this project's
control. The runner's `transaction` runs on a single pooled connection, because
the adapter's fence algorithm depends on row locks that don't hold across
connections.

> **Startup tells you which you got.** `[ada] conversations: postgres … —
> durable across restarts`, or an explicit warning that SQLite is not. Choosing
> SQLite when a database was injected is silent data loss, so it is asserted in
> `test/persistence.spec.ts` and logged at boot.

The restart itself is tested against a real Postgres — a mocked driver would
only prove the mock works. That test is opt-in (`ADA_TEST_POSTGRES_HOST`) with
the docker one-liner in the file; it dispatches a turn, throws the runtime and
adapter away, starts fresh, and asserts the earlier turn is replayed to the
model.

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

**Telemetry.** Tracing and the standard GenAI metrics come from
**`@flue/opentelemetry`**, the framework's own instrumentation, installed in
`telemetry/otel.ts`:

```ts
instrument(createOpenTelemetryInstrumentation({ content: false }))
```

> This replaced ~440 lines that reimplemented Flue's Cloudflare tracing backend
> for Node. The official package was missed because it is a **sibling package**,
> not re-exported from `@flue/runtime` — the only tracing symbol visible there is
> `createCloudflareTracing`, which imports `cloudflare:workers` and so reads as
> Cloudflare-only. If you need a Flue integration, check the registry for a
> `@flue/*` sibling before writing one.

A real turn produces one correlated trace, with spans that WRAP the work — so
durations are real and nested instrumentation parents correctly:

```
invoke_agent ada          39ms   ROOT
├─ chat claude-opus-4-8    2ms   gen_ai.provider.name, request.model, usage.*
├─ execute_tool bash      27ms   gen_ai.tool.name, tool.call.id, flue.tool.origin
└─ chat claude-opus-4-8    1ms
```

Span names follow the GenAI semconv (`invoke_agent` / `chat` / `execute_tool`)
and `gen_ai.usage.input_tokens` is the semconv **total sent** — non-cached +
cache read + cache write.

Two things are ours rather than the framework's, both deliberate:

- **`content: false`.** Prompts, completions, and tool payloads never become
  span attributes. Ada works on private repositories and attributes are retained
  by the collector. If content is ever wanted, use the package's `transform`
  hook to redact in place rather than flipping this on.
- **A cost histogram** (`gen_ai.usage.cost_usd`). Cost is absent from the GenAI
  semconv and from Flue's instrumentation — it's provider- and pricing-specific
  — but pi-ai computes it per turn, and "tool usage + token usage → money" is a
  question this deployment has to answer.

Instrumentation is registered **globally at boot**, not from the session runner:
the runner's observer returns early for instances it doesn't track, so driving
telemetry from there silently excluded every session started through Flue's
native `/agents/ada/:id` routes.

`test/telemetry.spec.ts` drives a real agent turn against a faux model provider
(no network, no credential) and asserts span names, parenting, a single trace,
non-zero durations, the cost metric, and the absence of content attributes.

| env | purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector (injected by the runner); unset ⇒ instrumentation still registers, but spans are discarded |
| `OTEL_SERVICE_NAME` | `service.name` (Dockerfile default `ada`) |
| `ADA_SELF_TELEMETRY` | `0` to skip starting the OTLP exporter even with an endpoint set |
| `OTEL_METRICS_ENABLED` | `1` to export OTLP metrics alongside traces |

OTel dep versions mirror the proven `0.217.0` train used across the other Astro
agents.

---

## Pin list — unstable / version-dependent, pin before production

### Flue (pin `@flue/runtime`, `@flue/cli`, `@flue/vite`, `@flue/opentelemetry`, `@flue/postgres`)
1. **All are pinned to an exact version (`2.0.3`), not a range.** Flue 2.0
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

5. **The `@flue/*` scope is bigger than `@flue/runtime`.** `@flue/opentelemetry`
   and `@flue/postgres` are pinned here too, in lockstep at `2.0.3`. Both were
   initially missed — neither is re-exported from `@flue/runtime`, and the only
   tracing symbol visible there is the Cloudflare one. Roughly 440 lines of
   hand-written instrumentation were written and then deleted as a result.
   **Check the registry for a `@flue/*` sibling before building an
   integration.** Also published and not currently used: `@flue/github` (webhook
   ingress, not OAuth — it replaces none of `agent/auth/`), `@flue/slack`,
   `@flue/react`, `@flue/linear`, `@flue/telegram`.

### AG-UI (pin `@ag-ui/core`)
6. **Reasoning events changed:** `THINKING_*` was removed in AG-UI **1.0.0** in
   favour of `REASONING_*`. We default reasoning OFF; if enabled, pin the core
   version so we emit the right names.
7. **`RUN_FINISHED.outcome`** is a newer optional field. We omit it for
   legacy-safety — revisit when we pin ≥ a version where it's expected.
8. **Validate against the canonical Zod schemas.** Local types in
   `agent/types/agui.ts` mirror `@ag-ui/core`; add a CI step that parses emitted
   events with the pinned package's schemas so drift fails the build.

### Gateway (Bifrost → Bedrock)
9. **`x-bf-vk` header + `bedrock/`-prefixed model ids** are how Bifrost reads the
   virtual key and resolves models; both were probed empirically and can change
   with the gateway. (The `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` workaround is
   gone with the CLI — pi-ai doesn't send Claude Code's first-party-only
   pre-release `anthropic-beta` flags.)

### Ada-specific extension (document for frontends)
10. **SSE `id:` line for reconnect.** AG-UI's own SSE encoder emits only
   `data: {json}\n\n` (no `event:`/`id:`). We add `id: <seq>` so the browser's
   `EventSource` sends `Last-Event-ID` and we replay the gap from the registry.
   Valid SSE, ignored by clients that don't use it — but it's *our* extension
   to the transport, not part of AG-UI.

## Limitations

- Running locally without a database, conversations live in SQLite under
  `WORKSPACE_ROOT` and do not survive a restart. Deployed, they are in Postgres
  and do (see "Durable conversations").
- The AG-UI event log is in memory with no GC yet. (The OAuth CSRF state is no
  longer among these — it is a signed, self-contained token now.)

## Next steps
- Registry durability: cap/spool the event log, GC terminated sessions.
- Harden auth: sign the `bridge_uid` cookie and encrypt GitHub tokens at rest.
- Add a CI typecheck step (`tsc --noEmit` is clean as of the telemetry work) and
  AG-UI schema validation alongside the e2e workflow.
- Consider a managed sandbox provider (E2B, Daytona, Modal) as an alternative
  to self-hosting the execution container — same one-line `useSandbox()` swap.
- **Measure the coding loop.** Nothing here compares task success against the
  old Claude Code build. See "Why Flue" — the harness improved, the prompt
  tuning that came free with the preset did not, and only a benchmark
  distinguishes the two.
- `@flue/github` for webhook ingress, so a PR mention can trigger a run. It is
  additive, not a replacement for `agent/auth/` — see the pin list.
