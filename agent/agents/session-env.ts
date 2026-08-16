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
