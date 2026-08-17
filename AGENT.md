---
description: "Ada — a coding agent (built on Flue 2.0) you talk to over Slack, web chat, or an AG-UI/SSE frontend."
tags: [ada, flue, ag-ui, sse, slack, github, coding-agent]
capabilities:
  - "Runs a Flue 2.0 agent loop in-process — no CLI child, no stream-json contract"
  - "Secure by default: always-on principles, on-demand security playbooks, and enforced diff gates"
  - "Holds multi-turn conversations; Flue keeps the history durably per instance id"
  - "Isolates each session in its own writable sandbox workspace"
  - "Scrubs the sandbox env so tools can't read host secrets (AWS/DB/gateway)"
  - "Translates Flue's event stream into AG-UI protocol events, one-to-one"
  - "Re-emits AG-UI events over SSE with lossless reconnect (Last-Event-ID replay)"
  - "Serves an AG-UI-compatible frontend; external AG-UI clients (e.g. CopilotKit) can consume the stream"
  - "Also exposes Flue's native agent routes for @flue/sdk clients"
  - "Connects each user's GitHub via per-user OAuth so git/gh act as them"
  - "Exports OTel traces/metrics via @flue/opentelemetry; content capture off by default"
repository: github:astropods/ada
integrations: [GitHub, Slack]
---

## Overview

**Ada** is a coding agent built on [Flue 2.0](https://flueframework.com), the
open TypeScript agent framework. The agent is a function — `Ada()` in
`agent/agents/ada.ts` — that declares what it needs through hooks: `useModel()`
for the LLM, `useSandbox()` for a filesystem and shell, `useInstruction()` for
guidance, `useTool()` for capabilities. Flue runs the loop in-process.

Converse with Ada over Slack / web chat (the platform messaging sidecar) or any
AG-UI frontend. Flue's event stream is translated into
[AG-UI](https://docs.ag-ui.com) protocol events and streamed to the browser over
Server-Sent Events, so any AG-UI-compatible frontend can render a run — a plain
chat UI or a richer dashboard — without backend changes.

Each session gets its own writable sandbox workspace as its working directory,
and the sandbox env is scrubbed: Flue's `local()` allowlist plus the proxy/TLS
and build-cache vars, and the user's GitHub token. So a command the model runs —
`bash` → `env` — can't read the container's host secrets (AWS, database, gateway
keys). The model credential is no longer forwarded at all, because no child
process needs it.

Model calls route through the Astro AI Gateway (`astro_ai_gateway: true`) via a
custom pi-ai provider, so the container needs no personal `ANTHROPIC_API_KEY`.
Supplying one as an input opts out of the gateway and talks to Anthropic
directly.

> **Why the name?** Named after **Ada Lovelace** — widely regarded as the first
> computer programmer — a fitting namesake for a coding agent. The Astropods
> blueprint deploys as `ada-your-personal-coding-agent` because a bare `ada`
> isn't a valid blueprint name.

## Usage

Message Ada over Slack / web chat, or open the agent's frontend URL and send a
prompt (e.g. *"read config.json and bump the retries"*). You'll see streaming
assistant text, tool-call cards with live arguments, tool results, and a final
result — as AG-UI events. Keep replying to continue the same session: follow-up
turns resume the prior context in the same workspace. The built-in UI shows a
per-session token/cost readout, a session-history switcher, and a settings panel
(GitHub status + connect/setup actions).

External clients can drive the same pipeline over HTTP:

- **`POST /sessions`** `{prompt}` → `{sessionId}` (starts a session)
- **`POST /sessions/:id/messages`** `{prompt}` → continue that session with a follow-up turn
- **`GET /sessions/:id/events`** → SSE AG-UI stream; honours `Last-Event-ID` for lossless replay

Flue's own routes are mounted alongside at **`/agents/ada/:id`** for `@flue/sdk`
clients. Both address the same durable instances, so a session started over one
is readable over the other.

Three ways to run it:

```bash
node agent/index.ts                                   # no build step (type-stripping)
vite build && node dist/server.mjs                    # the Flue Node target
npx flue run agent/agents/ada.ts --message "…"        # one turn, terminal only
```

## GitHub

Ada can act on GitHub as the individual user it's talking to — no static token
baked into the container.

- **Connect** — a user runs `connect github` in a DM (or clicks **Connect
  GitHub** in the web UI); Ada replies with a link to authorize. Their token is
  stored per-user and injected as `GH_TOKEN` into the sandbox env, so `git` and
  `gh` inside the session act as them. A connected user's render also gains the
  `checkout_repo` tool, which clones with that token server-side — the model
  names `owner/repo` and never handles a credential.
- **Set up** — an admin (whose verified email is listed in `ADMIN_EMAILS`) opens
  the web UI and clicks **Set up GitHub App** to provision the App through
  GitHub's App-Manifest flow. No manual App registration, no client id/secret to
  copy. The App is provisioned **private** by default (single-tenant); set
  `GITHUB_APP_PUBLIC=true` for multi-tenant so other users can install it on their
  own repos and connect. (Setup is web-only: admin is verified by email, which chat doesn't carry.
  If `ADMIN_EMAILS` is unset, any signed-in user can perform the *initial* setup;
  provisioning then locks.)

## Secure by default

Ada is opinionated about how code gets written, in three layers: a short set of
always-on principles, seven security playbooks loaded on demand as Flue skills
(API authorization, safe migrations, injection defence, docs, dependencies,
secrets, agent integrity), and enforcement gates that read the real diff at
every would-stop point and send the model back when a default was missed.

The gates block on credentials appearing in a diff and on controls being
weakened to reach green (a skipped test, a `@ts-ignore`, `--no-verify`), and
advise on endpoints changed without tests, stale API specs, migrations without a
reversal, and dependencies added without a lockfile. Advisory rules fire once
per session and blocking ones escalate three times then stop, so a gate can
never loop.

## Limitations

- Flue's conversation database and the sandbox workspaces live on the container
  filesystem, so **conversation history does not survive a restart or
  redeploy** — a resumed Slack thread re-clones its repo and starts fresh. A
  volume can only attach to a knowledge *container*, and the out-of-process
  sandbox that used to provide one is gone; the durable fix is a
  Postgres-backed Flue `PersistenceAdapter`. GitHub tokens and repo bindings
  are unaffected (those are in Postgres).
- The model's shell runs in the **same container as the control plane**. The
  env is scrubbed, but this is a smaller blast radius than the previous
  out-of-process sandbox. Swap `local()` in `agents/ada.ts` for a remote
  sandbox adapter (E2B, Daytona, Modal) to restore that split.
- The AG-UI event log is in memory with no GC yet. (The OAuth CSRF state is no
  longer among these — it is a signed, self-contained token now.)
- One turn runs at a time per session — an overlapping follow-up gets `409 busy`.
