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
import { init, observe, type FlueEvent } from "@flue/runtime";
import { Ada } from "../agents/ada.ts";
import { clearSessionEnv, setSessionEnv } from "../agents/session-env.ts";
import { clearGateState } from "../agents/security/gates.ts";
import { Translator } from "../translate/translator.ts";
import { SessionRegistry, type SessionMeta } from "./registry.ts";
import { createWorkspace, ensureWorkspace, removeWorkspace } from "./workspace.ts";
import { ensureRepo, type RepoSpec } from "./repo.ts";
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

export interface TurnOpts {
  prompt: string;
  /** Key the GitHub token is stored under (resolved platform id, or bridge_uid). */
  userKey: string;
  /** Resolved platform id for tracing (undefined in local dev → "anonymous"). */
  userId?: string;
  /** Repo this session is bound to; checked out before the turn runs. */
  repo?: RepoSpec;
  /** Descriptive metadata for the conversation-review list. */
  meta?: SessionMeta;
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

  /** Advance registry status and persist the run record. */
  private settleStatus(instanceId: string, event: FlueEvent): void {
    const terminal =
      event.type === "agent_end" ||
      (event.type === "submission_settled" && event.outcome !== "completed");
    if (!terminal) return;

    const isError = event.type !== "agent_end";
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
    await this.runTurn(instanceId, opts, hooks);
    return instanceId;
  }

  /**
   * Run a turn on an existing (or externally keyed, e.g. a Slack thread)
   * session. Creates the registry entry if the caller hasn't.
   */
  async continueSession(instanceId: string, opts: TurnOpts, hooks?: TurnHooks): Promise<void> {
    this.registry.ensure(instanceId);
    if (opts.meta) this.registry.setMeta(instanceId, opts.meta);
    await this.runTurn(instanceId, opts, hooks);
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

    const cwd = await this.workspaceFor(instanceId);
    const configured = githubConfigured();
    const githubToken = configured
      ? ((await getValidToken(this.store, opts.userKey)) ?? undefined)
      : undefined;

    // Clone the bound repo (if any) before the model sees the workspace, so the
    // checkout is simply "already there" rather than a first-turn tool call.
    let sandboxCwd = cwd;
    if (opts.repo) {
      sandboxCwd = (await ensureRepo(cwd, opts.repo, { githubToken })).dir;
    }

    setSessionEnv(instanceId, {
      modelRef: resolveModel().ref,
      cwd: sandboxCwd,
      sandboxEnv: sandboxEnv({ githubToken }),
      githubConfigured: configured,
      githubConnected: Boolean(githubToken),
      repo: opts.repo,
      userId: opts.userId,
    });

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

    // Hold a concurrency slot so N live threads don't run N agent loops and
    // exhaust the container; excess turns queue.
    await runLimiter.run(async () => {
      const handle = init(Ada, { id: instanceId });
      const onAbort = () => void handle.abort().catch(() => {});
      hooks?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const receipt = await handle.dispatch(opts.prompt);
        await handle.read(receipt, { signal: hooks?.signal });
      } catch (e) {
        // A local read cancellation (supersede) is not a failure: the durable
        // abort above is what stops the work, and the observer already emitted
        // the settlement. Anything else is a real error for the client.
        if (hooks?.signal?.aborted) return;
        this.registry.setStatus(instanceId, "errored");
        throw e;
      } finally {
        hooks?.signal?.removeEventListener("abort", onAbort);
      }
    });
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
