/**
 * Astro messaging AgentAdapter for Ada.
 *
 * Lets the platform's messaging sidecar (web / Slack / …) converse with Ada:
 * the sidecar hands us a normalized message per conversation; we run one agent
 * turn and stream the response back through the hooks.
 *
 * Concurrency model (Slack = multi-threaded):
 *  - The sidecar dispatches conversations concurrently, so different Slack
 *    threads run at once. Each thread (conversationId) IS a Flue instance id,
 *    so it has its own durable conversation, workspace, and repo checkout —
 *    the isolation unit is the thread.
 *  - A run holds a slot in `runLimiter` (MAX_CONCURRENT_RUNS) so N threads don't
 *    run N agent loops and OOM the box; excess threads queue. (Applied inside
 *    SessionRunner.)
 *  - A new message supersedes an in-flight one in the SAME thread: the sidecar
 *    aborts `options.signal`, which the runner forwards to `handle.abort()` so
 *    the old turn is durably stopped rather than racing the new one in one
 *    workspace.
 *
 * Repos: one repo per thread (one task). `work on <owner/repo>` binds it; the
 * runner clones it into the thread's workspace and reuses it across turns.
 *
 * What the Flue rewrite changed here: the adapter no longer constructs an agent
 * session, forwards a resume id, or owns a translator — it resolves the
 * directive-vs-prompt decision and delegates the turn to SessionRunner, reading
 * the AG-UI events the runner already produces. The `conv_claude_session`
 * resume namespace is gone; Flue keys history off the conversation id directly.
 */

import type { AgentAdapter, StreamHooks, StreamOptions } from "@astropods/adapter-core";
import { EventType } from "../types/agui.ts";
import { parseRepoSpec, type RepoSpec } from "../session/repo.ts";
import type { SessionRunner } from "../session/runner.ts";
import type { Store } from "../store/store.ts";
import { githubConfigured } from "../auth/app-config.ts";
import { getServerSecret, buildConnectUrl } from "../auth/connect.ts";

const HINT_NS = "gh_connect_hint"; // conversationId -> "1" once the connect hint has been shown
const REPO_NS = "conv_repo"; // conversationId -> { owner, repo } bound to this thread

/**
 * What the sidecar advertises about this agent. Mirrors what `useSandbox()`
 * mounts plus Ada's own `checkout_repo`; descriptive only — the agent's real
 * toolset is decided by the render in agents/ada.ts.
 */
const ADVERTISED_TOOLS = [
  { name: "read", title: "Read file", description: "Read a file from the workspace.", type: "function" },
  { name: "write", title: "Write file", description: "Create or overwrite a file in the workspace.", type: "function" },
  { name: "edit", title: "Edit file", description: "Apply a targeted edit to a file.", type: "function" },
  { name: "bash", title: "Run command", description: "Run a shell command in the workspace.", type: "function" },
  { name: "grep", title: "Search contents", description: "Search file contents by pattern.", type: "function" },
  { name: "glob", title: "Find files", description: "Find files by path pattern.", type: "function" },
  { name: "checkout_repo", title: "Check out repo", description: "Clone a GitHub repository into the workspace.", type: "function" },
];

type Directive =
  | { kind: "connect" }
  | { kind: "setup"; org?: string }
  | { kind: "whoami" }
  | { kind: "work"; spec: RepoSpec | null };

/** Parse a whole-message directive, or null if the message isn't one. */
function parseDirective(prompt: string): Directive | null {
  // Strip leading Slack mentions: addressing the bot in a channel prepends
  // `<@U123>` (or `<@U123|name>`), so `@Ada connect github` arrives as
  // `<@U123> connect github`. Without this the exact-match directives below
  // never fire in channels and fall through to a (slow, costly) LLM turn.
  const t = prompt.replace(/^\s*(?:<@[^>]+>\s*)+/, "").trim();
  const lower = t.toLowerCase().replace(/^\//, "");
  if (lower === "whoami") return { kind: "whoami" };
  if (lower === "connect-github" || lower === "connect github") return { kind: "connect" };
  const setup = t.match(/^\/?setup-github(?:\s+(\S+))?\s*$/i);
  if (setup) return { kind: "setup", org: setup[1] };
  // `work on <repo>` or `/work <repo>` — bind this thread to a repo.
  const work = t.match(/^\/?work(?:\s+on)?\s+(\S+)\s*$/i);
  if (work) return { kind: "work", spec: parseRepoSpec(work[1]) };
  if (/^\/?work(\s+on)?\s*$/i.test(t)) return { kind: "work", spec: null }; // usage
  return null;
}

/**
 * Whether the conversation is private: a Slack DM, or a non-platform web/
 * playground session (no platformContext, inherently 1:1). Connect links must
 * only be handed out here — in a shared channel anyone could click one within
 * its TTL and bind their own GitHub to this user's identity.
 */
function isPrivate(options: StreamOptions): boolean {
  const ctx = options.platformContext as { eventKind?: string } | undefined;
  return !ctx || ctx.eventKind === "EVENT_KIND_DM";
}

export class AdaMessagingAdapter implements AgentAdapter {
  readonly name = "Ada";

  // Explicit fields rather than constructor parameter properties: Node's
  // strip-only TypeScript mode rejects those.
  private readonly store: Store;
  private readonly runner: SessionRunner;

  constructor(store: Store, runner: SessionRunner) {
    this.store = store;
    this.runner = runner;
  }

  /**
   * What the sidecar advertises about this agent. The tool list mirrors what
   * `useSandbox()` mounts plus Ada's own `checkout_repo`; it is descriptive
   * only — the agent's real toolset is decided by the render in agents/ada.ts.
   */
  getConfig() {
    return { systemPrompt: "Ada — a coding agent built on Flue", tools: ADVERTISED_TOOLS };
  }

  private async boundRepo(conversationId: string): Promise<RepoSpec | undefined> {
    return ((await this.store.kvGet(REPO_NS, conversationId)) as RepoSpec | null) ?? undefined;
  }

  /** Handle a directive (whoami / connect / setup / work): validate, reply, no LLM run. */
  private async runDirective(
    directive: Directive,
    hooks: StreamHooks,
    options: StreamOptions,
  ): Promise<void> {
    const reply = (msg: string) => {
      hooks.onChunk(msg);
      hooks.onFinish();
    };

    if (directive.kind === "whoami") {
      const rec = githubConfigured() ? await this.store.getGithubToken(options.userId) : null;
      const bound = await this.boundRepo(options.conversationId);
      const gh = !githubConfigured()
        ? "not set up on this agent"
        : rec
          ? `connected as ${rec.githubLogin ?? "your account"}`
          : "not connected — send `connect github` to connect";
      reply(
        `Your messaging identity:\n` +
          `• userId: \`${options.userId}\`\n` +
          `• github: ${gh}\n` +
          `• this thread: ${bound ? `working on \`${bound.owner}/${bound.repo}\`` : "no repo yet — say `work on owner/repo`"}`,
      );
      return;
    }

    if (directive.kind === "setup") {
      reply(
        `GitHub App setup moved to the web UI. Open the app and click "Set up GitHub App". ` +
          `Chat can't run setup — it needs your signed-in web identity, which isn't available here.`,
      );
      return;
    }

    if (directive.kind === "work") {
      if (!directive.spec) {
        reply(
          "Tell me which repo to work on in this thread: `work on owner/repo`. " +
            "One repo per thread — start a new thread for a different repo/task.",
        );
        return;
      }
      const spec = directive.spec;
      const existing = await this.boundRepo(options.conversationId);
      if (existing && (existing.owner !== spec.owner || existing.repo !== spec.repo)) {
        reply(
          `This thread is already working on \`${existing.owner}/${existing.repo}\`. ` +
            `One repo per thread — start a **new** thread to work on \`${spec.owner}/${spec.repo}\`.`,
        );
        return;
      }
      // Record the binding; the runner clones it on the next turn (and reports
      // a clone failure there, where it can be surfaced with the turn).
      await this.store.kvPut(REPO_NS, options.conversationId, spec);
      reply(
        `This thread is now working on \`${spec.owner}/${spec.repo}\` — ` +
          `ask me to read code, make changes, or open a PR.`,
      );
      return;
    }

    // connect — DM-only: the link binds to your identity, so a channel would leak it.
    if (!isPrivate(options)) {
      reply("Please DM me to connect GitHub — a link posted in a channel would be visible to everyone here.");
      return;
    }
    if (!githubConfigured()) {
      reply(
        "GitHub isn't set up on this agent yet. An admin has to set up the GitHub App once — in the web app, " +
          'open Settings → "Set up GitHub App" (it needs your signed-in web identity, so it can\'t be done from ' +
          "chat). After that, send `connect github` here and I'll give you a link to connect your account.",
      );
      return;
    }
    const secret = await getServerSecret(this.store);
    reply(
      `Open this link to install me on the repositories you want me to work with — you pick the repos, and it ` +
        `connects your GitHub in the same step (expires in 10 min):\n${buildConnectUrl(options.userId, secret)}`,
    );
  }

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    // Already superseded/stopped before we began — nothing to do.
    if (options.signal?.aborted) {
      hooks.onFinish();
      return;
    }

    const directive = parseDirective(prompt);
    if (directive) {
      await this.runDirective(directive, hooks, options);
      return;
    }

    const repo = await this.boundRepo(options.conversationId);

    // GitHub is available but this user hasn't connected: show a one-time hint.
    let hintUrl: string | null = null;
    if (
      githubConfigured() &&
      !(await this.store.getGithubToken(options.userId)) &&
      !(await this.store.kvGet(HINT_NS, options.conversationId))
    ) {
      hintUrl = buildConnectUrl(options.userId, await getServerSecret(this.store));
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (hintUrl) {
        hooks.onChunk(
          `\n\n---\n💡 Tip: install me on your GitHub repos so I can read, push, and open PRs — ${hintUrl}`,
        );
        void this.store.kvPut(HINT_NS, options.conversationId, "1");
      }
      hooks.onFinish();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      hooks.onError(err);
    };

    try {
      await this.runner.continueSession(
        options.conversationId,
        {
          prompt,
          // The sidecar's userId is the key GitHub tokens are stored under and
          // the identity the run's trace is attributed to.
          userKey: options.userId,
          userId: options.userId,
          repo,
          meta: {
            kind: "slack",
            userId: options.userId,
            repo: repo ? `${repo.owner}/${repo.repo}` : undefined,
            title: prompt.slice(0, 80),
          },
        },
        {
          signal: options.signal,
          // The runner already mirrors the full AG-UI stream into the registry
          // for later review; hooks get only the subset Slack renders.
          onAguiEvent: (e) => {
            // Never write into a thread we have already finished. The run used
            // to be closed on `agent_end`, which fires per agent segment, so a
            // gate that sent the model back had Ada posting its reply and then
            // continuing to stream into the closed thread. The run boundary is
            // fixed now; this guard makes the failure mode impossible rather
            // than merely unlikely.
            if (settled) return;
            switch (e.type) {
              case EventType.TEXT_MESSAGE_CONTENT:
                hooks.onChunk(e.delta);
                break;
              case EventType.TOOL_CALL_START:
                hooks.onStatusUpdate?.({
                  status: "PROCESSING",
                  customMessage: `Using ${e.toolCallName}…`,
                  emoji: "🔧",
                });
                break;
              case EventType.RUN_FINISHED:
                finish();
                break;
              case EventType.RUN_ERROR:
                fail(new Error(e.message));
                break;
            }
          },
        },
      );
    } catch (e) {
      // A superseded turn settles SILENTLY — this turn was replaced, so emit no
      // error/finish (the sidecar drives the successor).
      if (options.signal?.aborted) {
        settled = true;
        return;
      }
      fail(e as Error);
      return;
    }
    // Defensive: settle even if the run produced no terminal AG-UI event.
    finish();
  }
}
