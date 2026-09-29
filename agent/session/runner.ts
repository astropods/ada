/**
 * Session runner — drives Flue agent instances and fans their events into the
 * AG-UI event log.
 *
 * This is the module that replaced the hand-rolled supervisor. The shape of a
 * "session" is much thinner than it was:
 *
 *   before: mint a bridge id -> spawn `claude -p` -> parse stream-json ->
 *           remember Claude's session_id -> pass `--resume` on the next turn
 *   now:    mint an instance id -> `init(Ada, { id })` -> `dispatch(prompt)`
 *
 * Flue owns conversation history durably against the instance id, so the old
 * `claudeSessionIds` resume map is gone — a follow-up turn is just another
 * dispatch to the same id, and it survives a process restart.
 *
 * Streaming comes from `observe()`, Flue's in-process live event feed, rather
 * than from `read()`'s durable chunk projection: `observe()` carries the
 * `text_delta` / `toolcall_delta` events the AG-UI wire contract needs for
 * incremental rendering. One global subscriber is installed at startup and
 * routes each event to the right session by `instanceId`.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { init, observe, type FlueEvent } from "@flue/runtime";
import { Ada } from "../agents/ada.ts";
import { clearSessionEnv, getCheckoutDir, setSessionEnv } from "../agents/session-env.ts";
import { clearGateState } from "../agents/security/gates.ts";
import { Translator } from "../translate/translator.ts";
import { SessionRegistry, type SessionMeta } from "./registry.ts";
import { createWorkspace, ensureWorkspace, removeWorkspace } from "./workspace.ts";
import { ensureRepo, type RepoSpec } from "./repo.ts";
import {
  ensureRepoInSandbox,
  remoteSandboxDriver,
  sandboxHost,
} from "./remote-sandbox.ts";
import {
  describeUploads,
  routeUploads,
  writeUploadsLocal,
  writeUploadsRemote,
  type UploadInput,
} from "./uploads.ts";
import { resolveModel, sandboxEnv } from "../config/model.ts";
import { githubConfigured } from "../auth/app-config.ts";
import { getValidToken } from "../auth/github-app.ts";
import { runLimiter } from "../concurrency.ts";
import {
  addTurnUsage,
  emptyUsage,
  toRunRecord,
  type ResultStore,
  type RunUsage,
} from "../persistence/results.ts";
import type { Store } from "../store/store.ts";
import type { AguiEvent } from "../types/agui.ts";
import type { SessionEnv } from "../agents/session-env.ts";

type SessionEnvRemote = NonNullable<SessionEnv["remote"]>;

export interface TurnOpts {
  prompt: string;
  /** Files the user attached to this turn, unrouted. */
  uploads?: UploadInput[];
  /** Key the GitHub token is stored under (resolved platform id, or bridge_uid). */
  userKey: string;
  /** Resolved platform id for tracing (undefined in local dev → "anonymous"). */
  userId?: string;
  /** Repo this session is bound to; checked out before the turn runs. */
  repo?: RepoSpec;
  /** Descriptive metadata for the conversation-review list. */
  meta?: SessionMeta;
  /**
   * Return as soon as the session exists, and run the turn in the background.
   *
   * For the BROWSER. Awaiting a whole turn meant `POST /sessions` did not answer
   * until the work was finished, so the client could not open the event stream
   * until there was nothing left to stream — it replayed a completed turn in one
   * block, and every incremental event the AG-UI contract exists for was wasted.
   * A long turn was also indistinguishable from a hung server, and a POST held
   * open for minutes is what a proxy kills at 60s even though the turn succeeded.
   *
   * NOT for messaging. Slack streams live through `onAguiEvent` and has to hold
   * the run to know when to close the thread, so it keeps awaiting. Opt-in
   * rather than the default precisely so the two callers cannot drift apart
   * silently.
   */
  background?: boolean;
}

/** Per-turn extras a caller can observe without subscribing to the registry. */
export interface TurnHooks {
  onAguiEvent?: (event: AguiEvent) => void;
  /** Aborts the turn durably (supersede / explicit stop). */
  signal?: AbortSignal;
}

interface LiveSession {
  translator: Translator;
  hooks?: TurnHooks;
  /** Usage accumulated across the turns of the CURRENT delivery. */
  usage: RunUsage;
  turns: number;
  model: string | null;
  startedAt: number;
}

export class SessionRunner {
  private readonly sessions = new Map<string, LiveSession>();
  /** instance id -> workspace cwd, reused across turns. */
  private readonly workspaces = new Map<string, string>();
  private unobserve: (() => void) | null = null;

  // NB: explicit fields, not constructor parameter properties — Node's
  // strip-only TypeScript mode (how `node agent/index.ts` runs the sources)
  // rejects those.
  private readonly registry: SessionRegistry;
  private readonly store: Store;
  private readonly results: ResultStore;

  // NB: no telemetry here. Tracing is registered globally via
  // `installTelemetry()` (telemetry/otel.ts) rather than driven from this
  // observer, which returns early for instances it doesn't track — that
  // silently excluded every session started through Flue's native
  // `/agents/ada/:id` routes.
  constructor(registry: SessionRegistry, store: Store, results: ResultStore) {
    this.registry = registry;
    this.store = store;
    this.results = results;
  }

  /**
   * Install the global Flue event subscriber. Call once at startup, before any
   * dispatch. Subscribers run synchronously on the emit path, so this stays
   * cheap: translate, append, hand off.
   */
  start(): void {
    if (this.unobserve) return;
    this.unobserve = observe((event) => {
      const instanceId = event.instanceId;
      if (!instanceId) return;
      const live = this.sessions.get(instanceId);
      if (!live) return;
      try {
        const flueEvent = event as FlueEvent;
        this.accumulate(live, flueEvent);
        for (const agui of live.translator.handle(flueEvent)) {
          this.registry.append(instanceId, agui);
          live.hooks?.onAguiEvent?.(agui);
        }
        this.settleStatus(instanceId, flueEvent);
      } catch (e) {
        console.error(`[runner] event handling failed for ${instanceId}: ${(e as Error).message}`);
      }
    });
  }

  stop(): void {
    this.unobserve?.();
    this.unobserve = null;
  }

  /** Fold model-turn usage into the delivery's running total. */
  private accumulate(live: LiveSession, event: FlueEvent): void {
    if (event.type !== "turn") return;
    live.turns += 1;
    if (event.response?.responseModel) live.model = event.response.responseModel;
    if (event.response?.usage) addTurnUsage(live.usage, event.response.usage);
  }

  /**
   * Advance registry status and persist the run record.
   *
   * Keyed on `submission_settled`, NOT `agent_end`. A `useAgentFinish` gate
   * that sends the model back produces another agent segment in the same
   * delivery, so settling on `agent_end` marked the session finished — and
   * saved its run record — while it was still working.
   */
  private settleStatus(instanceId: string, event: FlueEvent): void {
    if (event.type !== "submission_settled") return;
    const isError = event.outcome !== "completed";
    this.registry.setStatus(instanceId, isError ? "errored" : "finished");

    const live = this.sessions.get(instanceId);
    if (live) {
      void this.results
        .save(
          toRunRecord(instanceId, live.model, live.usage, {
            numTurns: live.turns,
            durationMs: Date.now() - live.startedAt,
            isError,
          }),
        )
        .catch((e) => console.warn(`[runner] result save failed: ${(e as Error).message}`));
    }
  }

  /** Whether a turn is currently in flight for this session. */
  busy(instanceId: string): boolean {
    if (!this.registry.has(instanceId)) return false;
    const status = this.registry.status(instanceId);
    return status === "running" || status === "starting";
  }

  has(instanceId: string): boolean {
    return this.registry.has(instanceId);
  }

  /** Start a NEW session: mint an id, create its workspace, run turn 1. */
  async startSession(opts: TurnOpts, hooks?: TurnHooks): Promise<string> {
    const instanceId = `sess_${randomUUID()}`;
    this.registry.ensure(instanceId);
    this.registry.setMeta(instanceId, {
      kind: "browser",
      userId: opts.userKey,
      title: opts.prompt.slice(0, 80),
      ...opts.meta,
    });
    // Create the workspace BEFORE returning even in background mode. It is one
    // memoized store round-trip, and it keeps the likeliest startup failure
    // (no volume, store unreachable) a synchronous error the caller can answer
    // with a 5xx — rather than a session that exists, streams nothing, and has
    // to explain itself over SSE.
    await this.workspaceFor(instanceId);
    await this.dispatchTurn(instanceId, opts, hooks);
    return instanceId;
  }

  /**
   * Run a turn on an existing (or externally keyed, e.g. a Slack thread)
   * session. Creates the registry entry if the caller hasn't.
   */
  async continueSession(instanceId: string, opts: TurnOpts, hooks?: TurnHooks): Promise<void> {
    this.registry.ensure(instanceId);
    if (opts.meta) this.registry.setMeta(instanceId, opts.meta);
    await this.dispatchTurn(instanceId, opts, hooks);
  }

  /**
   * Run a turn, awaiting it or not according to `opts.background`.
   *
   * The background path still reports every failure the awaited path does —
   * `runTurn` emits the terminal AG-UI event itself before rethrowing, so the
   * client learns of an error over the stream it is already watching. The catch
   * here only stops the rethrow becoming an unhandled rejection, which in
   * current Node would take the whole process down.
   *
   * `registry.ensure` has already set the status to "starting", and `busy()`
   * counts "starting", so a follow-up that races this still gets its 409.
   */
  private async dispatchTurn(instanceId: string, opts: TurnOpts, hooks?: TurnHooks): Promise<void> {
    if (!opts.background) return this.runTurn(instanceId, opts, hooks);
    void this.runTurn(instanceId, opts, hooks).catch((e) => {
      console.warn(`[runner] background turn failed for ${instanceId}: ${(e as Error).message}`);
    });
  }

  /**
   * Run ONE turn.
   *
   * Order matters: the session's context (workspace, freshly-resolved GitHub
   * token, repo binding) must be published BEFORE dispatch, because the agent
   * render reads it synchronously — see agents/session-env.ts.
   */
  private async runTurn(instanceId: string, opts: TurnOpts, hooks?: TurnHooks): Promise<void> {
    this.registry.setStatus(instanceId, "running");

    // BEFORE any of the work below, because this is what `failTurn` needs to
    // report a failure. Everything from here to `dispatch` — resolving a token,
    // cloning the repo — used to throw with no translator registered, so
    // `flushRun` found no session and emitted nothing at all. Awaited, that was
    // survivable (the caller got a 500); backgrounded it would strand the client
    // on a stream that never says anything.
    //
    // One translator per session (it carries the AG-UI run/message state across
    // turns); usage and turn counts reset per delivery, which is the unit the
    // run record describes.
    this.sessions.set(instanceId, {
      translator: this.sessions.get(instanceId)?.translator ?? new Translator({ includeRawEvent: false }),
      hooks,
      usage: emptyUsage(),
      turns: 0,
      model: null,
      startedAt: Date.now(),
    });

    try {
      await this.runTurnInner(instanceId, opts, hooks);
    } catch (e) {
      // A local read cancellation (supersede) is not a failure: the durable
      // abort is what stops the work and the observer already emitted the
      // settlement.
      if (hooks?.signal?.aborted) return;
      // Report ONCE, here, whatever stage failed — then rethrow so an awaiting
      // caller (messaging) still sees it. The background caller swallows it,
      // having already had it delivered over the stream.
      this.failTurn(instanceId, (e as Error).message);
      throw e;
    }
  }

  private async runTurnInner(instanceId: string, opts: TurnOpts, hooks?: TurnHooks): Promise<void> {
    const cwd = await this.workspaceFor(instanceId);
    const configured = githubConfigured();
    const githubToken = configured
      ? ((await getValidToken(this.store, opts.userKey)) ?? undefined)
      : undefined;

    // Clone the bound repo (if any) before the model sees the workspace, so the
    // checkout is simply "already there" rather than a first-turn tool call.
    // Root the sandbox at the repo whenever we know one: bound up front with
    // `work on`, or cloned by the agent on an earlier turn. Rooting at the
    // workspace instead leaves the repo one level down, where Flue's workspace
    // discovery does not look — which is how a session ends up never seeing the
    // project's AGENTS.md.
    const baseUrl = sandboxHost();
    let sandboxCwd = cwd;
    let remote: SessionEnvRemote | undefined;

    // Routed here, not at the HTTP edge, because only the runner knows which
    // sandbox this session has — and a non-image upload has to be written
    // where the agent's tools will look for it, which the branches below
    // settle (local dir vs remote subdir).
    const routedUploads = opts.uploads?.length ? routeUploads(opts.uploads) : null;

    if (baseUrl) {
      // Isolated execution: the checkout lives in the sandbox container, and
      // every path the agent sees is relative to its own workspace there.
      const token = process.env.SANDBOX_TOKEN;
      let subdir: string | undefined;
      let driver: ReturnType<typeof remoteSandboxDriver> | undefined;
      if (opts.repo) {
        driver = remoteSandboxDriver({ baseUrl, id: instanceId, token, env: sandboxEnv({ githubToken }) });
        subdir = (await ensureRepoInSandbox(driver, opts.repo, { githubToken })).dir;
      } else {
        // A repo the agent cloned itself on an earlier turn, so the next turn
        // is rooted inside it and Flue's AGENTS.md discovery sees the project.
        subdir = getCheckoutDir(instanceId);
      }
      if (routedUploads?.files.length) {
        driver ??= remoteSandboxDriver({ baseUrl, id: instanceId, token, env: sandboxEnv({ githubToken }) });
        await writeUploadsRemote(driver, routedUploads.files, subdir);
      }
      remote = { baseUrl, token, subdir };
    } else if (opts.repo) {
      sandboxCwd = (await ensureRepo(cwd, opts.repo, { githubToken })).dir;
    } else {
      // Always relative to the workspace now — `checkout_repo` clones through
      // the agent's own sandbox, so it names a directory rather than a
      // control-plane path.
      const checkout = getCheckoutDir(instanceId);
      if (checkout) sandboxCwd = ensureWorkspace(join(cwd, checkout));
    }

    // After the local branches above have settled sandboxCwd, so the files land
    // in the directory the agent is actually rooted at (the checkout when there
    // is one, the workspace otherwise) and `uploads/<name>` resolves for it.
    if (!baseUrl && routedUploads?.files.length) {
      writeUploadsLocal(sandboxCwd, routedUploads.files);
    }

    setSessionEnv(instanceId, {
      modelRef: resolveModel().ref,
      // Read from the registry rather than from `opts.meta`, which a browser
      // FOLLOW-UP does not send — deriving it from the turn would make Ada
      // verbose again on every message after the first.
      surface: this.registry.kind(instanceId) ?? "browser",
      cwd: sandboxCwd,
      remote,
      sandboxEnv: sandboxEnv({ githubToken }),
      githubConfigured: configured,
      githubConnected: Boolean(githubToken),
      repo: opts.repo,
      userId: opts.userId,
    });

    // Hold a concurrency slot so N live threads don't run N agent loops and
    // exhaust the container; excess turns queue.
    await runLimiter.run(async () => {
      const handle = init(Ada, { id: instanceId });
      const onAbort = () => void handle.abort().catch(() => {});
      hooks?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // A bare string stays a bare string: Flue treats it as
        // `{ kind: 'user', body }`, and a turn with no attachments must produce
        // exactly the delivery it always did.
        const receipt = await handle.dispatch(
          routedUploads
            ? {
                message: {
                  kind: "user",
                  body: describeUploads(opts.prompt, routedUploads),
                  attachments: routedUploads.attachments,
                },
              }
            : opts.prompt,
        );
        await handle.read(receipt, { signal: hooks?.signal });
        // Belt and braces: if `submission_settled` never reached the observer,
        // close the AG-UI run here rather than leaving a client waiting on a
        // run that will never end.
        this.flushRun(instanceId, "completed");
      } finally {
        hooks?.signal?.removeEventListener("abort", onAbort);
      }
    });
  }

  /**
   * Report a failed turn to whoever is watching the stream.
   *
   * Uses `failRun` rather than `flush` because the two cover different cases:
   * `flush` closes a run that IS open, and does nothing otherwise, which is
   * exactly wrong for a turn that died before the model was reached. `failRun`
   * opens one so the client gets RUN_STARTED -> RUN_ERROR instead of silence.
   */
  private failTurn(instanceId: string, message: string): void {
    const live = this.sessions.get(instanceId);
    if (live) {
      for (const agui of live.translator.failRun(message)) {
        this.registry.append(instanceId, agui);
        live.hooks?.onAguiEvent?.(agui);
      }
    }
    this.registry.setStatus(instanceId, "errored");
  }

  /** Emit a terminal AG-UI event if the delivery did not produce one itself. */
  private flushRun(instanceId: string, outcome: "completed" | "failed", message?: string): void {
    const live = this.sessions.get(instanceId);
    if (!live) return;
    for (const agui of live.translator.flush(outcome, message)) {
      this.registry.append(instanceId, agui);
      live.hooks?.onAguiEvent?.(agui);
    }
  }

  /** The writable workspace for a session, reused across turns and self-healing. */
  private async workspaceFor(instanceId: string): Promise<string> {
    const cached = this.workspaces.get(instanceId);
    if (cached) return ensureWorkspace(cached);
    // A container restart loses the in-memory map but not necessarily the disk,
    // so consult the store before minting a fresh directory.
    const stored = (await this.store.kvGet(WS_NS, instanceId)) as string | null;
    const cwd = stored ? ensureWorkspace(stored) : createWorkspace();
    if (cwd !== stored) await this.store.kvPut(WS_NS, instanceId, cwd);
    this.workspaces.set(instanceId, cwd);
    return cwd;
  }

  /** Drop all server-side state for a session. Returns false if it was unknown. */
  async delete(instanceId: string): Promise<boolean> {
    const existed = this.registry.delete(instanceId);
    this.sessions.delete(instanceId);
    clearSessionEnv(instanceId);
    clearGateState(instanceId);
    removeWorkspace(this.workspaces.get(instanceId));
    this.workspaces.delete(instanceId);
    await this.store.kvDelete(WS_NS, instanceId);
    return existed;
  }
}

const WS_NS = "conv_workspace";
