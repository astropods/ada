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

import { resolveModel, sandboxEnv } from "../config/model.ts";
import { sandboxMode } from "../session/sandbox-mode.ts";
import { sandboxHost } from "../session/remote-sandbox.ts";
import type { RepoSpec } from "../session/repo.ts";

export interface SessionEnv {
  /** `useModel()` ref for this session, e.g. `astro-gateway/claude-opus-4-8`. */
  modelRef: string;
  /** Writable workspace that is the sandbox cwd (repo checkout lives inside). */
  cwd: string;
  /**
   * Set when execution is delegated OUT of this process. Absent means the
   * in-process `local()` sandbox, keyed on `cwd`.
   *
   * Tagged, because the two destinations need different things to reach them:
   * the container is an address this process calls, while an Astro sandbox is
   * a name the platform resolves. Keeping them in one optional field means
   * every "is execution remote?" test stays a truthiness check.
   *
   * `subdir` names a directory INSIDE the instance's workspace (a repo
   * checkout), or is absent for the workspace root. It is deliberately not a
   * cwd. For the container the absolute path is unknowable from here, so the
   * factory asks at sandbox creation; for Astro the image fixes it at
   * /workspace, so there is nothing to ask.
   */
  remote?:
    | { kind: "container"; baseUrl: string; token?: string; subdir?: string }
    | { kind: "astro"; subdir?: string };
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
  /**
   * Where this conversation is being read.
   *
   * The agent writes for a reader, and the two readers are not alike: the web
   * client renders a long answer as a scrollable transcript, while Slack renders
   * it as a wall of text in someone's sidebar. Same run, same events — only the
   * length that suits them differs, so the surface has to reach the prompt.
   */
  surface?: "browser" | "slack";
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
 * Always a directory name RELATIVE to the instance's workspace. It used to be
 * absolute in local mode and relative in remote mode, which is the kind of
 * asymmetry that eventually gets mixed up; now `checkout_repo` clones through
 * the agent's own sandbox in both modes and the runner resolves it per mode.
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

/**
 * Recovery-path context: no token, no repo — but still ISOLATED where isolation
 * exists.
 *
 * This used to return `cwd: process.cwd()` with no `remote`, which makes
 * `ada.ts` mount `local()` — the model's shell and file tools operating on the
 * CONTROL PLANE container, on its own source tree, with no per-conversation
 * workspace. That was reachable two ways: Flue's native `POST /agents/ada/:id`
 * (now refused in app.ts, since it bypasses the runner entirely) and the reason
 * this function exists at all — a recovery render, which runs before any of our
 * handlers touch the instance and therefore before the runner publishes
 * anything. Closing only the first door would have left the second.
 *
 * So when the platform deployed a sandbox, the fallback selects it. Scoping is
 * automatic and does not need the instance id here: `useSandbox(remote(...))`
 * builds the driver per instance, and the factory asks the container for that
 * instance's own absolute workspace path. A render with no published context is
 * now degraded in CAPABILITY — no GitHub token, no repo binding — rather than
 * in containment.
 *
 * With no sandbox deployed there is no isolation to select, and `process.cwd()`
 * is the intended posture for `node agent/index.ts` and `flue run` on a
 * developer's machine. `sandboxEnv()` rather than `{}` so the scrubbed
 * allowlist (proxy/TLS, cache paths, the worker-pool caps) still reaches
 * commands; it carries no credential, because none is resolved on this path.
 */
function fallbackEnv(): SessionEnv {
  const mode = sandboxMode();
  const baseUrl = sandboxHost();
  return {
    modelRef: resolveModel().ref,
    cwd: process.cwd(),
    remote:
      mode === "astro"
        ? { kind: "astro" }
        : mode === "container" && baseUrl
          ? { kind: "container", baseUrl, token: process.env.SANDBOX_TOKEN }
          : undefined,
    sandboxEnv: sandboxEnv(),
    githubConfigured: false,
    githubConnected: false,
  };
}
