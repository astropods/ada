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
import { checkUploadLimits } from "../session/uploads.ts";
import type { Store } from "../store/store.ts";
import { githubConfigured } from "../auth/app-config.ts";
import { getServerSecret, buildConnectUrl, buildWatchUrl } from "../auth/connect.ts";
import { readAttachments } from "./attachments.ts";

const HINT_NS = "gh_connect_hint"; // conversationId -> "1" once the connect hint has been shown
const REPO_NS = "conv_repo"; // conversationId -> { owner, repo } bound to this thread
const THREAD_CTX_NS = "conv_thread_ctx"; // conversationId -> {done} | {attempts}

/**
 * How many times a conversation may look for thread context before giving up.
 *
 * Not a single one-shot flag, because the FIRST mention is frequently the one
 * that opens the thread — "Ada, can you look at this?" posted at top level has
 * nothing above it. Recording the read as spent there meant the very next
 * message, the one pasting the actual error, was never picked up: the flow this
 * feature exists for was the flow it failed on.
 *
 * So EVERY look costs an attempt, and only a look whose block reached a turn
 * that actually finished is terminal. The bound is what keeps a genuinely empty
 * thread — or one whose turns keep dying — from re-asking the platform on every
 * turn forever.
 */
const THREAD_CONTEXT_MAX_ATTEMPTS = 3;

/** Most thread messages to read in, oldest first. */
const THREAD_CONTEXT_MAX_MESSAGES = 40;
/** Ceiling on the rendered block, so a long thread cannot dominate the turn. */
const THREAD_CONTEXT_MAX_CHARS = 4000;
/** Any single message longer than this is clipped before the block budget applies. */
const THREAD_CONTEXT_MAX_MESSAGE_CHARS = 600;

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
 * Anything that could pass for the delimiter wrapping the thread block.
 *
 * Optional whitespace inside the tag and either slash position, because
 * `< / THREAD >` closes an XML-ish block for a reader as surely as `</thread>`
 * does. Deliberately NOT permissive about attributes — the block Ada emits is
 * exactly `<thread>`, and a looser pattern would start eating legitimate prose
 * that merely mentions a thread.
 */
const THREAD_TAG = /<\s*\/?\s*thread\s*>/gi;

/**
 * Neutralize a delimiter a thread participant typed, so it cannot close the
 * block early.
 *
 * The thread is UNTRUSTED text pasted into Ada's prompt. Someone who writes
 * `</thread>` mid-message would otherwise end the block where Ada's own framing
 * says the untrusted region stops, and everything after it reads as top-level
 * instruction — the classic delimiter escape. Escaping the angle brackets keeps
 * the message readable and says what the person actually typed, where dropping
 * the text would quietly rewrite them.
 *
 * This closes the DELIMITER hole specifically. It is not a defence against
 * instructions written in plain prose ("ignore the above and…") — nothing at
 * this layer can be, which is why the block tells the model what it is reading.
 */
function neutralizeThreadTags(text: string): string {
  return text.replace(THREAD_TAG, (tag) => `&lt;${tag.slice(1, -1)}&gt;`);
}

/**
 * Order two thread messages oldest-first by their platform timestamp.
 *
 * `ThreadMessage.timestamp` is a protobuf Timestamp (`{ seconds: string;
 * nanos: number }`), so seconds is an int64 AS A STRING and the two fields are
 * compared in turn — folding them into one number (`seconds * 1e9 + nanos`)
 * overflows 2^53 for any real epoch and silently loses the nanos.
 */
function compareByTimestamp(a: ThreadMessageLike, b: ThreadMessageLike): number {
  const sa = Number(a.timestamp?.seconds);
  const sb = Number(b.timestamp?.seconds);
  if (sa !== sb) return sa - sb;
  return (a.timestamp?.nanos ?? 0) - (b.timestamp?.nanos ?? 0);
}

/** A message we can order: both timestamp halves present and finite. */
function hasUsableTimestamp(m: ThreadMessageLike): boolean {
  return Number.isFinite(Number(m.timestamp?.seconds));
}

type ThreadMessageLike = { timestamp?: { seconds?: string | number; nanos?: number } };

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

  /**
   * Prepend the Slack thread Ada was pinged into, so a bare "Ada fix this"
   * resolves.
   *
   * The sidecar delivers only the message that triggered the turn. Someone
   * @-mentioning Ada halfway down a thread has usually said everything that
   * matters ABOVE the mention — the error, the link, the decision — and the
   * mention itself is a pronoun. Without the thread, Ada has to ask what "this"
   * is, which is exactly the friction the mention was meant to avoid.
   *
   * ONCE PER SETTLED TURN, recorded durably in the store like the connect hint
   * and the repo binding. A Slack thread IS a Flue instance, so once a turn
   * carrying the block has finished, the conversation history already has it;
   * re-reading it every turn would resend the same messages and spend the budget
   * twice. The trade is that humans talking to each other in the thread BETWEEN
   * Ada's turns are not picked up — Ada only receives messages addressed to it.
   * That is worth knowing and not worth the duplication to fix.
   *
   * SETTLED is the operative word. This reports whether it injected; `stream`
   * commits `done` only after the turn finishes. Writing `done` here instead
   * meant a turn that then threw, or was superseded by the next message, left
   * the conversation marked read with nothing in its history to show for it —
   * and the first-turn failure is exactly the case this feature exists for.
   *
   * Best-effort throughout. `getThreadHistory` is optional (an older sidecar, or
   * the web playground, simply does not have it), and a thread that cannot be
   * read must degrade to today's behaviour rather than fail the turn — the
   * message the user actually sent is still there.
   */
  private async withThreadContext(
    prompt: string,
    options: StreamOptions,
  ): Promise<{ prompt: string; injected: boolean }> {
    if (!options.getThreadHistory) return { prompt, injected: false };

    const raw = await this.store.kvGet(THREAD_CTX_NS, options.conversationId);
    // Legacy one-shot flag, written before this became a bounded counter. A
    // conversation that already had its context injected is done.
    if (raw === "1") return { prompt, injected: false };
    const state = (raw ?? {}) as { done?: boolean; attempts?: number };
    if (state.done) return { prompt, injected: false };
    const attempts = state.attempts ?? 0;
    if (attempts >= THREAD_CONTEXT_MAX_ATTEMPTS) return { prompt, injected: false };

    let messages: Awaited<ReturnType<NonNullable<StreamOptions["getThreadHistory"]>>>;
    try {
      messages = await options.getThreadHistory(THREAD_CONTEXT_MAX_MESSAGES);
    } catch {
      // The platform could not hydrate the thread. Costs an attempt so a
      // persistently failing platform is not re-asked every turn, and carries
      // on: the message the user actually sent is still there.
      await this.spendThreadAttempt(options.conversationId, attempts);
      return { prompt, injected: false };
    }

    // ORDER: sorted here, not assumed.
    //
    // Nothing in adapter-core 0.10 specifies one. `getThreadHistory` is typed
    // `(maxMessages?) => Promise<ThreadMessage[]>` with no ordering in its
    // contract, and the bridge hands back the sidecar's array untouched
    // (`fetchThreadHistory` -> `response.messages ?? []`), so the direction is
    // whatever the platform server chose and can change without a type change.
    // `ThreadMessage.timestamp` is required, so we can simply not depend on it.
    //
    // Only when EVERY message carries a usable timestamp: a comparator that
    // returns 0 for the missing ones is not transitive, and feeding that to
    // `sort` can reshuffle a partially-stamped array rather than leaving it
    // alone. All-or-nothing degrades cleanly instead — with no timestamps
    // (an older sidecar, or a test fake) we keep the platform's order.
    //
    // WHICH 40 we get is a separate question, and one we cannot answer here:
    // `maxMessages` bounds the count, but the slice direction isn't specified
    // either, and `ThreadHistoryResponse.isComplete` — the truncation flag —
    // is dropped by `getThreadHistory` before it reaches us. We assume the
    // platform returns the most recent N. If it ever returns the OLDEST N of a
    // long thread, the block below is still internally consistent (and still
    // trims to the newest it was given), but the newest messages in the thread
    // will be missing and nothing in this signature would tell us.
    const ordered = messages.every(hasUsableTimestamp)
      ? [...messages].sort(compareByTimestamp)
      : messages;

    const botUserId = options.platformContext?.botUserId;
    const triggerId = options.platformContext?.messageId;
    const lines: string[] = [];
    for (const m of ordered) {
      // Ada's own replies are already in the Flue conversation, and the
      // triggering message is the prompt — including either would just be the
      // model reading itself back.
      if (botUserId && m.user?.id === botUserId) continue;
      if (triggerId && m.messageId === triggerId) continue;
      if (m.isDeleted) continue;
      // Sanitized BEFORE the clip, so the budget counts the escaped form and a
      // truncation can never sever an escape back into a live delimiter.
      const text = neutralizeThreadTags((m.content ?? "").trim());
      if (!text) continue;
      // The display name is untrusted too — it lands on the same line, so a
      // delimiter typed into a Slack profile escapes exactly as one typed into
      // a message would.
      const who = neutralizeThreadTags(m.user?.username || m.user?.id || "someone");
      const clipped =
        text.length > THREAD_CONTEXT_MAX_MESSAGE_CHARS
          ? `${text.slice(0, THREAD_CONTEXT_MAX_MESSAGE_CHARS)}… [truncated]`
          : text;
      lines.push(`${who}: ${clipped}`);
    }
    if (lines.length === 0) {
      // Nothing usable YET — most often because this mention opened the thread.
      // Spend an attempt, not the budget, so the next message in the thread can
      // still be read.
      await this.spendThreadAttempt(options.conversationId, attempts);
      return { prompt, injected: false };
    }

    // Keep the NEWEST messages when trimming: the end of a thread is what a
    // mention usually refers back to, and the top is often stale setup.
    let block = lines.join("\n");
    if (block.length > THREAD_CONTEXT_MAX_CHARS) {
      while (lines.length > 1 && lines.join("\n").length > THREAD_CONTEXT_MAX_CHARS) lines.shift();
      block = `[…earlier messages omitted]\n${lines.join("\n")}`;
    }

    // An attempt, NOT `done`: the turn carrying this block has not run yet, and
    // if it dies the thread still needs reading. `stream` commits `done` once it
    // settles. Spending the attempt here is what bounds that retry — a
    // conversation whose turns keep failing stops re-fetching, rather than
    // re-reading the thread on every message forever.
    await this.spendThreadAttempt(options.conversationId, attempts);

    return {
      injected: true,
      prompt:
        "<thread>\n" +
        "You were mentioned partway through this conversation. It is the context for " +
        "the request below — a bare \"fix this\" or \"take a look\" almost certainly " +
        "refers to something in here. Oldest first; your own replies are omitted.\n\n" +
        `${block}\n` +
        "</thread>\n\n" +
        prompt,
    };
  }

  /** Record one unproductive look at the thread, best-effort. */
  private async spendThreadAttempt(conversationId: string, attempts: number): Promise<void> {
    await this.store
      .kvPut(THREAD_CTX_NS, conversationId, { attempts: attempts + 1 })
      // A store failure must not cost the user their turn; the worst case is
      // one more look at the thread next time.
      .catch(() => {});
  }

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    // Already superseded/stopped before we began — nothing to do.
    if (options.signal?.aborted) {
      hooks.onFinish();
      return;
    }

    // Validated before directive parsing so a file attached to this message
    // is checked the same way regardless of what the message text says. A
    // limit violation refuses the WHOLE turn (same tier as runDirective's
    // informational replies, not hooks.onError — that's for an actual failed
    // run) rather than silently dropping the offending file: an agent that
    // answered confidently about an attachment it never got is worse than a
    // turn that didn't run. A bare directive still validates its attachments,
    // but discards them if valid — directives never reach continueSession.
    const uploads = await readAttachments(options.attachments, options.images);
    const uploadError = checkUploadLimits(uploads);
    if (uploadError) {
      hooks.onChunk(uploadError);
      hooks.onFinish();
      return;
    }

    const directive = parseDirective(prompt);
    if (directive) {
      await this.runDirective(directive, hooks, options);
      return;
    }

    // "Ada fix this" only means something if Ada can see what "this" is.
    const { prompt: contextualPrompt, injected: threadContextInjected } =
      await this.withThreadContext(prompt, options);

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

    // The thread read is only spent once the turn it fed has actually settled;
    // awaited before `stream` returns so the next message in the thread sees it.
    let threadContextCommitted: Promise<void> | undefined;
    const commitThreadContext = () => {
      // A superseded turn has not delivered the block to anyone — the successor
      // the sidecar is already driving needs to read the thread in again.
      if (!threadContextInjected || threadContextCommitted || options.signal?.aborted) return;
      threadContextCommitted = this.store
        .kvPut(THREAD_CTX_NS, options.conversationId, { done: true })
        // A store failure must not cost the user their turn; the worst case is
        // one more look at the thread next time, and attempts still bound that.
        .catch(() => {});
    };

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      commitThreadContext();
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

    // Posted BEFORE the turn runs, and as a chunk rather than a status: a status
    // is edited in place by the next one, and a link that vanishes on the first
    // tool call is no use for following along.
    try {
      const watchUrl = buildWatchUrl(
        options.userId,
        options.conversationId,
        await getServerSecret(this.store),
      );
      hooks.onChunk(`\u{1F440} Follow along: ${watchUrl}\n\n`);
    } catch {
      // No base URL configured, so no link can be built. A turn must not fail
      // for want of a convenience.
    }

    try {
      await this.runner.continueSession(
        options.conversationId,
        {
          prompt: contextualPrompt,
          uploads,
          // The sidecar's userId is the key GitHub tokens are stored under and
          // the identity the run's trace is attributed to.
          userKey: options.userId,
          userId: options.userId,
          repo,
          meta: {
            kind: "slack",
            userId: options.userId,
            repo: repo ? `${repo.owner}/${repo.repo}` : undefined,
            // The user's own words, deliberately — titling a conversation with
            // the injected thread block would make every mention look alike in
            // the review list.
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
    } finally {
      // Defensive: settle even if the run produced no terminal AG-UI event. A
      // turn that failed or was superseded is already settled, so this is a
      // no-op there — and no `done` is committed for it.
      finish();
      // Don't let the `done` write race the sidecar's next message: reading it
      // is what stops the block being sent a second time.
      await threadContextCommitted;
    }
  }
}
