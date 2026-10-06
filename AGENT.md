---
description: "Ada — a coding agent you talk to over Slack, web chat, or its own frontend."
tags: [ada, slack, github, coding-agent]
capabilities:
  - "Reads, writes, and tests code in your repositories from a chat conversation"
  - "Works on GitHub as you — clones, commits, and opens pull requests with your account"
  - "Follows your repository's own conventions (AGENTS.md, CLAUDE.md, and similar)"
  - "Checks its own work for security issues, weakened tests, and leaked secrets"
  - "Gets an independent code review on bigger changes before it finishes"
  - "Remembers the conversation, so you can keep replying with follow-ups"
  - "Accepts files and screenshots you attach in Slack or web chat"
  - "Runs every conversation in its own isolated sandbox"
  - "Shows its work live — every command, file edit, and result as it happens"
repository: github:astropods/ada
integrations: [GitHub, Slack]
---

## Overview

Small coding chores pile up: bump a config value, fix a failing test, rename a
field across a codebase, open the PR. Each one means cloning, poking around, and
remembering the project's rules. **Ada** does that legwork for you. Describe
what you want in plain language — in Slack, in web chat, or in Ada's own web app
— and Ada reads the code, makes the change, runs the checks, and reports back.

Ask it things like:

- *"Clone acme/billing and find out why the invoice tests are failing."*
- *"Read config.json and bump the retries to 5."*
- *"Add input validation to the signup endpoint and open a PR."*

> **Why the name?** Ada is named after **Ada Lovelace**, widely regarded as the
> first computer programmer. On Astropods it deploys as `ada`.

## What Ada does

- **Talks wherever you are** — message Ada in Slack or web chat, or open its web
  app. Keep replying in the same thread to build on what it already did.
- **Shows its work** — you watch it in real time: what it's thinking, which
  commands it runs, which files it edits, and the final result. The web app also
  shows how much each conversation costs, lets you switch between past
  conversations, and has a settings panel.
- **Works as you on GitHub** — once you connect your account, Ada clones, commits,
  and opens pull requests under your name, with your permissions. Nobody else's
  access is involved.
- **Respects your project's rules** — before it starts, Ada reads the repo's own
  guidance files (`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CONVENTIONS.md`) and
  follows them over its own defaults. If your project says "every PR needs a
  changelog entry," Ada adds one instead of finding out from CI.
- **Takes attachments** — drop a screenshot or file into Slack or web chat. Ada
  sees images directly and can open other files with its tools. If a batch is
  too large or has too many files, Ada tells you why it can't take them.

## Secure by default

Ada is opinionated about writing safe code, and it checks itself:

- **Built-in good habits** — a short set of principles Ada always follows, plus
  in-depth playbooks it pulls in when the task calls for them: access control,
  database migrations, injection attacks, dependencies, secrets, documentation,
  and AI agent safety.
- **Checks before it finishes** — Ada looks over its actual changes before saying
  it's done. It won't hand back work that contains a password or API key, or
  that "passes" only because a test was skipped or a check was switched off. It
  also flags softer issues, like a changed endpoint without tests or a new
  dependency without an updated lockfile.
- **A second pair of eyes** — for bigger changes, a separate reviewer reads the
  diff fresh, looking at test quality, error handling, API compatibility, and
  concurrency. Serious findings get fixed before Ada finishes. Small or
  docs-only changes skip the review, and you can turn it off at any time by
  asking Ada.
- **Kept in a sandbox** — the commands Ada runs execute in their own isolated
  space, one per conversation, with no access to the server's secrets or to
  other people's conversations.

## Usage

### Start a conversation

Message Ada in Slack or web chat, or open the agent's web app, and describe what
you want. Reply in the same thread to continue — Ada picks up where it left off,
with the same files and context.

### Connect GitHub

To let Ada work on your repositories, send **`connect github`** in a direct
message (or click **Connect GitHub** in the web app) and follow the link to
authorize. From then on Ada acts as you on GitHub; it never sees or handles your
password.

### First-time setup (admins)

Before anyone can connect, an admin sets up Ada's GitHub App once. Open the web
app and click **Set up GitHub App**: Ada walks you through GitHub's own setup in
a couple of clicks, with no keys or secrets to copy by hand.

- **Who counts as an admin** — list their email addresses in the `ADMIN_EMAILS`
  setting. If it's empty, the first signed-in user can do the initial setup,
  after which it locks. Setup only works from the web app, since chat doesn't
  verify email addresses.
- **Just you, or your team?** — by default the App is private: only you can
  install it. Set `GITHUB_APP_PUBLIC=true` to let teammates install it on their
  own repositories and connect too.

### Settings

| Setting | What it does |
| --- | --- |
| `ADMIN_EMAILS` | Who can perform the GitHub App setup. |
| `GITHUB_APP_PUBLIC` | Let other people install the GitHub App (default: off). |
| `ADA_REVIEWER_ENABLED` | Whether the independent code review runs by default (default: on). |
| `MAX_CONCURRENT_RUNS` | How many tasks can run at once (default: 3). Lower it if the agent runs short on memory. |
| `ANTHROPIC_API_KEY` | Use your own Anthropic key instead of the Astro AI Gateway (optional). |
| `PUBLIC_BASE_URL` | The address people use to reach Ada. Usually detected automatically; needed for GitHub links sent in chat. |

## For developers

Ada is built on [Flue 2.0](https://flueframework.com), an open-source TypeScript
agent framework, and streams its progress using the open
[AG-UI](https://docs.ag-ui.com) protocol, so any AG-UI-compatible frontend (e.g.
CopilotKit) can display a conversation. Model calls go through the Astro AI
Gateway by default, so no personal API key is needed.

You can also drive Ada over HTTP:

- **`POST /sessions`** `{prompt}` → `{sessionId}` starts a conversation
- **`POST /sessions/:id/messages`** `{prompt}` sends a follow-up
- **`GET /sessions/:id/events`** streams progress (Server-Sent Events, with
  replay on reconnect)

Flue's native routes (`/agents/ada/:id`) are available to admins for reading and
cancelling conversations; start new turns with `POST /sessions`. Each
conversation is only visible to the person who started it, so set
`ADMIN_EMAILS` in any shared deployment. See the README for the full access
rules.

Run it locally:

```bash
node agent/index.ts                                   # no build step
vite build && node dist/server.mjs                    # production build
npx flue run agent/agents/ada.ts --message "…"        # a single turn in the terminal
```

## Limitations

- **One request at a time per conversation** — if you send a new message while
  Ada is still working, it'll tell you it's busy. Wait for it to finish, or start
  a new conversation.
- **Local runs forget conversations** — without a database, history is kept in a
  local file and lost on restart. Deployed instances keep it in Postgres.
- **Sandboxes don't restrict network access** — Ada's sandbox isolates files and
  secrets, but commands can still reach the internet.
- **The live progress feed is kept in memory** — reconnecting to a conversation's
  live feed after the server restarts won't replay earlier progress.
