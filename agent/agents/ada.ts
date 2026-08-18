/**
 * Ada — the coding agent, as a native Flue agent.
 *
 * This replaces the old `ClaudeAgentSession`/`ClaudeSupervisor` pair, which
 * spawned the `claude` binary and parsed its newline-delimited `stream-json`.
 * Flue runs the agent loop in-process, so:
 *
 *   - the `stream-json` contract (and the pinned CLI version) is gone;
 *   - the coding toolset (`read`/`write`/`edit`/`bash`/`grep`/`glob`) comes
 *     from `useSandbox()` rather than from a preset we had to prune with a
 *     `DEFAULT_DISALLOWED_TOOLS` deny list — Flue mounts only what we declare,
 *     so the default is closed;
 *   - the model credential never reaches a child process.
 *
 * The render is DYNAMIC, which is the point of the hooks API: the GitHub
 * guidance text and the `checkout_repo` tool appear or disappear based on
 * whether the App is provisioned and this user has connected. The model is told
 * about the change as a signal, so a mid-conversation `connect github` upgrades
 * the agent's capabilities without restarting the session.
 *
 * Per-instance context (workspace cwd, sandbox env, GitHub state) is read from
 * the process-local table in session-env.ts — deliberately NOT `useInitialData`
 * or delivery attributes, which are durable. See that module for why.
 */

"use agent";

import {
  useAgentFinish,
  useAgentStart,
  useInstruction,
  useModel,
  usePersistentState,
  useSandbox,
  useSkill,
  useSubagent,
  useTool,
} from "@flue/runtime";
import { local } from "@flue/runtime/node";
import type { AgentProps } from "@flue/runtime";
import { getSessionEnv } from "./session-env.ts";
import { checkoutRepo } from "./tools.ts";
import { registerProviders } from "../config/model.ts";
import { githubPromptGuidance } from "../github-guidance.ts";
import { SECURITY_PRINCIPLES } from "./security/principles.ts";
import { SECURITY_SKILLS } from "./security/skills.ts";
import { captureBaseline, runSecurityGates } from "./security/gates.ts";
import { codeReviewer, reviewerDefault, setReviewMode } from "./security/reviewer.ts";

// Register the Astro AI Gateway provider HERE, at agent-module scope, rather
// than in a server bootstrap. Every entry point loads this module — the Hono
// app, the generated Node server, and `flue run` — but only the servers load
// `app.ts`. Registering there left `flue run` resolving
// `astro-gateway/claude-opus-4-8` against a registry that had never heard of
// the provider. Idempotent, and a no-op in direct mode.
registerProviders();

/** Ada's role — the return value becomes the system instructions. */
const ROLE = `You are Ada, a coding agent. You work inside a writable sandbox
workspace: read and edit files, run shell commands, run tests, and use git.

Work like an experienced engineer on someone else's codebase:
- Read before you write. Match the surrounding style, naming, and structure.
- Make the change that was asked for — don't widen or narrow the scope.
- Verify your work by running the project's own tests or build where one exists,
  and say plainly what passed, what failed, and what you skipped.
- Keep replies short. Show the diff or the command output that matters, not a
  narration of every step.`;

export function Ada({ id }: AgentProps) {
  const env = getSessionEnv(id);

  useModel(env.modelRef, { thinkingLevel: "medium" });

  // The local sandbox binds the session's own workspace directory. Flue's
  // `local()` scrubs the host env down to its own allowlist (PATH/HOME/…), and
  // we layer on the proxy/TLS and build-cache vars plus — only when the user has
  // connected — their GH_TOKEN. A command the model runs (`bash` → `env`) still
  // cannot read the container's AWS/database/gateway secrets.
  useSandbox(local({ cwd: env.cwd, env: env.sandboxEnv }), { cwd: env.cwd });

  // Tell the model how GitHub auth works here, so that asked to "auth to
  // github" it guides the user through Ada's App flow instead of improvising
  // `gh auth login` or asking for a pasted PAT.
  useInstruction(
    githubPromptGuidance({
      configured: env.githubConfigured,
      connected: env.githubConnected,
    }),
  );

  if (env.repo) {
    useInstruction(
      `This session is bound to the repository ${env.repo.owner}/${env.repo.repo}, ` +
        `already checked out in your working directory. One repo per session — if the ` +
        `user asks about a different repository, tell them to start a new session.`,
    );
  }

  // Authenticated cloning is a tool rather than a bare `git clone` so the token
  // is applied server-side: the model names a repo, it never handles a
  // credential and cannot redirect one to an arbitrary host.
  if (env.githubConnected) useTool(checkoutRepo(id));

  /* ---------------- secure-by-default, in three layers ----------------
   *
   * The layering is the point. Each does something the others can't:
   *
   *   principles  always in the prompt — a handful of rules that apply to
   *               nearly every change. Kept short on purpose; a long checklist
   *               here costs tokens on every turn and dilutes itself.
   *   skills      one catalog line each until the model activates them, so the
   *               detailed playbooks are effectively free when not relevant.
   *   gates       read the real diff at every would-stop point and send the
   *               model back. The only layer that actually ENFORCES anything.
   */

  useInstruction(SECURITY_PRINCIPLES);

  for (const skill of SECURITY_SKILLS) useSkill(skill);

  /* ---------------- the independent reviewer ----------------
   *
   * Durable per-conversation state, seeded from ADA_REVIEWER_ENABLED. Because
   * the render re-runs each turn, flipping this genuinely changes the agent:
   * the delegate stops being mounted, and Flue narrates the capability change
   * to the model. That is the dynamic-agent property the hooks API exists for —
   * the alternative, a flag consulted inside a static tool, would leave the
   * reviewer advertised to a model that must then be told not to use it.
   *
   * `set_review_mode` stays mounted either way, so a conversation that turned
   * review off can always turn it back on.
   */
  const [reviewEnabled, setReviewEnabled] = usePersistentState("securityReview", reviewerDefault());
  if (reviewEnabled) useSubagent(codeReviewer);
  useTool(setReviewMode(setReviewEnabled));

  // Record the commit the turn starts from, so the gate can diff against it and
  // see work the agent has already committed — not just the working tree.
  useAgentStart(async (ctx) => {
    await captureBaseline(id, ctx);
  });

  // The gate closes over the CURRENT render's flag, so turning review off takes
  // effect on the next turn without the gate needing to read state itself.
  useAgentFinish(async (ctx) => {
    await runSecurityGates(id, ctx, { reviewEnabled });
  });

  return ROLE;
}

// Durable identity — keys Flue's conversation storage. Must be a string literal
// in a `'use agent'` module.
Ada.agentName = "ada";

// A coding turn can legitimately run long (clone, install, test). Give recovery
// a wide window rather than settling a slow-but-healthy run as failed.
Ada.durability = {
  maxAttempts: Number(process.env.ADA_MAX_ATTEMPTS ?? 3),
  timeoutMs: Number(process.env.ADA_TURN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000),
};
