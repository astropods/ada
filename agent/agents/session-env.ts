/**
 * Per-instance runtime context for the Ada agent — the seam that keeps SECRETS
 * OUT OF DURABLE STATE.
 *
 * Flue offers two ways to get data into a render: `useInitialData()` and
 * `useDelivery()` signal attributes. Both are recorded in the instance's
 * durable conversation log, which is exactly wrong for a GitHub token: it would
 * be persisted, replayed on recovery, and outlive the token's own expiry.
 *
 * So Ada keeps the sensitive, per-turn bits in this process-local table instead.
 * The runner (`agent/session/runner.ts`) resolves a fresh token and writes the
 * context here immediately BEFORE each dispatch; the agent render reads it
 * synchronously by instance id. Nothing here is durable — after a restart the
 * runner simply repopulates it on the next turn, which is the correct lifetime
 * for a credential anyway.
 *
 * The DURABLE half of a session (conversation history) is owned by Flue and
 * addressed by the same instance id, so the two stay in step without the old
 * `claudeSessionIds` resume mapping.
 */

import { resolveModel } from "../config/model.ts";
import type { RepoSpec } from "../session/repo.ts";

export interface SessionEnv {
  /** `useModel()` ref for this session, e.g. `astro-gateway/claude-opus-4-8`. */
  modelRef: string;
  /** Writable workspace that is the sandbox cwd (repo checkout lives inside). */
  cwd: string;
  /**
   * Set when execution is delegated to the isolated sandbox container.
   *
   * `subdir` names a directory INSIDE the instance's workspace there (a repo
   * checkout), or is absent for the workspace root. It is deliberately not a
   * cwd: the control plane cannot see the container's filesystem layout, so
   * the absolute path is resolved by asking the container at sandbox creation.
   * Absent `remote` means the in-process `local()` sandbox, keyed on `cwd`.
   */
  remote?: { baseUrl: string; token?: string; subdir?: string };
  /** Scrubbed env for the local sandbox, incl. GH_TOKEN when connected. */
  sandboxEnv: Record<string, string | undefined>;
  /** Whether the GitHub App is provisioned on this deployment at all. */
  githubConfigured: boolean;
  /** Whether THIS user has connected their GitHub account. */
  githubConnected: boolean;
  /** The repo this thread is bound to, if any. */
  repo?: RepoSpec;
  /** Messaging/platform identity that owns the session (telemetry attribution). */
  userId?: string;
}

const contexts = new Map<string, SessionEnv>();

/**
 * Repo directories cloned DURING a turn, by instance.
 *
 * The sandbox cwd is fixed when a submission starts, so a repo the model clones
 * mid-turn cannot re-root the turn that cloned it. Recording it here lets the
 * runner root the NEXT turn at the checkout, which is what makes Flue's own
 * AGENTS.md/skills discovery work for repos that were not bound up front with
 * `work on`. Process-local and best-effort: losing it just means the next turn
 * starts at the workspace root again.
 */
const checkouts = new Map<string, string>();

/**
 * Record a checkout made mid-turn, so later turns start inside it.
 *
 * NB the stored value means different things per mode, matching what each
 * consumer needs: an ABSOLUTE control-plane path locally, and a path RELATIVE
 * to the instance's sandbox workspace when execution is remote (the control
 * plane cannot see that container's layout). Both come straight from the
 * `ensureRepo*` that produced them, so they cannot be mixed up in practice —
 * but read the runner's two call sites together before changing either.
 */
export function setCheckoutDir(instanceId: string, dir: string): void {
  checkouts.set(instanceId, dir);
}

/** The most recent mid-turn checkout for an instance, if any. */
export function getCheckoutDir(instanceId: string): string | undefined {
  return checkouts.get(instanceId);
}

/** Publish the context an instance's next render will read. Call before dispatch. */
export function setSessionEnv(instanceId: string, env: SessionEnv): void {
  contexts.set(instanceId, env);
}

/**
 * Read an instance's context during render.
 *
 * A render can legitimately happen without a preceding `setSessionEnv` — Flue
 * recovers interrupted submissions after a restart, and the recovered render
 * runs before any of our HTTP handlers touch the instance. Rather than throw
 * mid-recovery we degrade to a credential-free context: the agent still renders
 * (with GitHub reported as unavailable), and the next real turn restores it.
 */
export function getSessionEnv(instanceId: string): SessionEnv {
  return contexts.get(instanceId) ?? fallbackEnv();
}

export function clearSessionEnv(instanceId: string): void {
  contexts.delete(instanceId);
  checkouts.delete(instanceId);
}

/** Recovery-path context: no token, no repo, cwd is the process cwd. */
function fallbackEnv(): SessionEnv {
  return {
    modelRef: resolveModel().ref,
    cwd: process.cwd(),
    sandboxEnv: {},
    githubConfigured: false,
    githubConnected: false,
  };
}
