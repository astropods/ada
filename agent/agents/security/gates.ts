/**
 * Security gates — the enforcement layer.
 *
 * Instructions suggest and skills inform; NEITHER guarantees anything. A model
 * that is deep in a task, low on context, or simply in a hurry will skip a
 * checklist item and stop. `useAgentFinish` is Flue's control seam: it runs at
 * every would-stop point and can append a signal that sends the model back to
 * work. That is the difference between "Ada usually remembers to add an
 * ownership test" and "Ada does not finish without one".
 *
 * The gates read the ACTUAL diff from the sandbox rather than asking the model
 * what it did — self-report is exactly what we're trying not to depend on.
 * `useAgentStart` records the HEAD commit at the start of the delivery, so the
 * gate can diff against it and see everything the turn changed, including work
 * the agent already committed for a PR.
 *
 * ── Design constraints, learned the hard way ─────────────────────────────
 *
 * A gate that cannot be satisfied is an infinite loop that bills the user, so
 * every rule has a signal BUDGET. Advisory rules fire once per instance and
 * then stand down; blocking rules get a few attempts and then emit a final
 * "stop and tell the user" signal, which terminates while still surfacing the
 * problem. Never silently give up on a blocking rule — a suppressed secret
 * warning is worse than no warning.
 *
 * These are heuristics over file paths and diff text. They will occasionally
 * miss and occasionally misfire, so the wording of every signal invites the
 * model to explain why a rule doesn't apply rather than demanding compliance.
 * A gate that cannot be argued with turns into a gate the model games.
 */

import type { AgentFinishContext, AgentStartContext } from "@flue/runtime";

/* ------------------------------------------------------------ diff model */

interface Diff {
  /** Paths touched this turn (committed or not). */
  files: string[];
  /** Lines added, without the leading '+'. */
  added: string[];
  /** Lines removed, without the leading '-'. */
  removed: string[];
  /**
   * Whether the repo has an API spec / a test suite AT ALL.
   *
   * Rules that ask "you changed X but not Y" must first establish that Y is
   * something this project does. Telling a repo with no OpenAPI spec to update
   * its OpenAPI spec is noise, and a gate that cries wolf is a gate the model
   * learns to talk its way past.
   */
  repoHasSpec: boolean;
  repoHasTests: boolean;
}

/** Baseline commit per instance, captured at the start of each delivery. */
const baselines = new Map<string, string | null>();
/** Signals already spent, per instance, per rule. */
const spent = new Map<string, Map<string, number>>();

/** Drop a session's gate state. Called alongside clearSessionEnv. */
export function clearGateState(instanceId: string): void {
  baselines.delete(instanceId);
  spent.delete(instanceId);
}

async function sh(ctx: AgentStartContext | AgentFinishContext, command: string): Promise<string> {
  try {
    const r = await ctx.harness.sandbox.exec(command, { timeoutMs: 15_000 });
    return r.exitCode === 0 ? r.stdout : "";
  } catch {
    // No sandbox, no git, not a repo, command not found — all mean "cannot
    // inspect", which must never break the user's turn.
    return "";
  }
}

/**
 * Record the commit the turn started from. Without a baseline the gate can only
 * see uncommitted work, and would wave through anything the agent committed.
 */
export async function captureBaseline(instanceId: string, ctx: AgentStartContext): Promise<void> {
  const head = (await sh(ctx, "git rev-parse HEAD")).trim();
  baselines.set(instanceId, head || null);
}

async function readDiff(instanceId: string, ctx: AgentFinishContext): Promise<Diff | null> {
  const base = baselines.get(instanceId);
  // With a baseline, `git diff <base>` covers committed AND uncommitted work.
  // Without one (repo cloned mid-turn), fall back to the working tree.
  const range = base ? `${base}` : "HEAD";
  const names = await sh(ctx, `git diff --name-only ${range}`);
  const untracked = await sh(ctx, "git ls-files --others --exclude-standard");
  const patch = await sh(ctx, `git diff --unified=0 ${range}`);

  const files = [...names.split("\n"), ...untracked.split("\n")]
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0) return null;

  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  // An untracked file has no diff hunk, so its content would be invisible to
  // the content rules — read the new ones so a freshly-written `.env` or a
  // pasted key is still caught.
  for (const f of untracked.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 40)) {
    const body = await sh(ctx, `head -c 20000 -- ${JSON.stringify(f)}`);
    if (body) added.push(...body.split("\n"));
  }

  const tracked = (await sh(ctx, "git ls-files")).split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    files,
    added,
    removed,
    repoHasSpec: tracked.some(isSpec) || files.some(isSpec),
    repoHasTests: tracked.some(isTest) || files.some(isTest),
  };
}

/* ------------------------------------------------------------- matchers */

const isTest = (p: string) => /(^|\/)(tests?|specs?|__tests__)\//i.test(p) || /\.(test|spec)\.[jt]sx?$/i.test(p) || /(^|\/)test_[^/]+\.py$/i.test(p) || /_test\.(go|py|rb)$/i.test(p);

const isRoute = (p: string) =>
  !isTest(p) &&
  (/(^|\/)(routes?|controllers?|handlers?|endpoints?|api|resolvers?)\//i.test(p) ||
    /\.(route|controller|handler|resolver)\.[jt]s$/i.test(p));

const isMigration = (p: string) =>
  /(^|\/)(migrations?|migrate|alembic\/versions)\//i.test(p) || /(^|\/)db\/migrate\//i.test(p);

const isSpec = (p: string) => /(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(p);

const isDependencyManifest = (p: string) =>
  /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Gemfile|Cargo\.toml)$/i.test(p);

const isLockfile = (p: string) =>
  /(^|\/)(package-lock\.json|bun\.lock[b]?|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|go\.sum|Gemfile\.lock|Cargo\.lock)$/i.test(p);

/** High-confidence credential shapes. Deliberately narrow — precision over recall. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/\bsk-[A-Za-z0-9]{32,}/, "an OpenAI-style API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, "a JWT"],
];

/** Obvious non-secrets, so a placeholder in `.env.example` doesn't trip the gate. */
const PLACEHOLDER = /(example|placeholder|changeme|your[_-]?|dummy|fake|test|xxx+|\.\.\.|<[^>]+>|\$\{|process\.env|os\.environ)/i;

/** Suppressions and skips introduced by this turn. */
const WEAKENERS: Array<[RegExp, string]> = [
  [/\b(?:it|test|describe|context)\.skip\s*\(/, "a skipped test"],
  [/\b(?:xit|xdescribe|xtest)\s*\(/, "a skipped test"],
  [/@(?:pytest\.mark\.)?skip|pytest\.mark\.skip/, "a skipped test"],
  [/\bt\.Skip\s*\(/, "a skipped test"],
  [/\b(?:it|test|describe)\.only\s*\(/, "an `.only` that disables the rest of the suite"],
  [/eslint-disable(?!-next-line\s+no-console)/, "an eslint suppression"],
  [/@ts-(?:ignore|nocheck)/, "a TypeScript suppression"],
  [/#\s*type:\s*ignore|#\s*noqa/, "a type/lint suppression"],
  [/@SuppressWarnings/, "a warning suppression"],
  [/--no-verify/, "a bypassed git hook"],
];

/* ---------------------------------------------------------------- rules */

interface Finding {
  rule: string;
  /** Blocking rules keep signalling; advisory ones fire once. */
  blocking: boolean;
  body: string;
}

function scanRules(diff: Diff): Finding[] {
  const found: Finding[] = [];
  const changed = diff.files;

  // 1. Credentials in the diff. Blocking: this is the one where being wrong is
  //    unrecoverable, because a pushed secret is a compromised secret.
  const leaks = new Set<string>();
  for (const line of diff.added) {
    if (PLACEHOLDER.test(line)) continue;
    for (const [re, what] of SECRET_PATTERNS) if (re.test(line)) leaks.add(what);
  }
  if (changed.some((f) => /(^|\/)\.env$/.test(f))) leaks.add("a committed .env file");
  if (leaks.size > 0) {
    found.push({
      rule: "secret-in-diff",
      blocking: true,
      body:
        `STOP. Your changes appear to introduce ${[...leaks].join(", ")}. ` +
        `Remove it from the working tree before going any further, and put the value in ` +
        `an environment variable or the platform's secret store instead. ` +
        `If it was already committed, do NOT rewrite history to hide it — tell the user ` +
        `plainly that the credential must be rotated. ` +
        `If this is a false positive (a placeholder, a fixture, a public sample), say so ` +
        `explicitly in your reply and continue.`,
    });
  }

  // 2. Controls weakened to reach green.
  const weakened = new Set<string>();
  for (const line of diff.added) {
    for (const [re, what] of WEAKENERS) if (re.test(line)) weakened.add(what);
  }
  const deletedTests = diff.removed.filter((l) => /\b(?:it|test|describe)\s*\(|\bexpect\s*\(|\bassert\b/.test(l)).length;
  const addedTests = diff.added.filter((l) => /\b(?:it|test|describe)\s*\(|\bexpect\s*\(|\bassert\b/.test(l)).length;
  if (deletedTests >= 3 && addedTests < deletedTests / 2) {
    weakened.add(`${deletedTests} removed test/assertion lines with little added back`);
  }
  if (weakened.size > 0) {
    found.push({
      rule: "weakened-check",
      blocking: true,
      body:
        `Your changes introduce ${[...weakened].join(", ")}. ` +
        `Never make a check pass by removing the check — see the \`agent-integrity\` skill. ` +
        `Either fix the underlying cause, or, if the check is genuinely wrong and the user ` +
        `asked for this behaviour change, keep it and state clearly in your summary what you ` +
        `disabled and why. Do not leave it unexplained.`,
    });
  }

  // 3. Endpoint changed with no test touched. The ownership test is the single
  //    highest-value thing missing here, so the signal asks for that by name.
  if (diff.repoHasTests && changed.some(isRoute) && !changed.some(isTest)) {
    found.push({
      rule: "route-without-test",
      blocking: false,
      body:
        `You changed request-handling code (${changed.filter(isRoute).slice(0, 3).join(", ")}) ` +
        `without touching any test. Before finishing, add coverage for the authorization path ` +
        `specifically: that a caller who does NOT own the object gets a 404. See the ` +
        `\`secure-api-endpoint\` skill. If these files aren't really endpoints, say so and ` +
        `carry on.`,
    });
  }

  // 4. Migration with no reversal.
  const migrations = changed.filter(isMigration);
  if (migrations.length > 0) {
    const hasDown = diff.added.some((l) => /\b(down|downgrade|revert|rollback)\b/i.test(l));
    if (!hasDown) {
      found.push({
        rule: "migration-without-down",
        blocking: false,
        body:
          `You added or changed a migration (${migrations.slice(0, 3).join(", ")}) with no visible ` +
          `down/rollback. Add a working reversal, and check the change for locking behaviour on a ` +
          `large table — see the \`safe-db-migration\` skill. If the change is genuinely ` +
          `irreversible (a column drop), say so explicitly in your summary instead.`,
      });
    }
  }

  // 5. Public API changed but the spec that documents it didn't.
  if (diff.repoHasSpec && changed.some(isRoute) && !changed.some(isSpec)) {
    found.push({
      rule: "api-change-without-spec",
      blocking: false,
      body:
        `You changed request-handling code but not this repo's API spec. Update it in the same ` +
        `change — including the security scheme and every response status you can return. If the ` +
        `spec is generated from code, re-run the generator rather than hand-editing it. See the ` +
        `\`maintain-api-docs\` skill.`,
    });
  }

  // 6. Dependency added without the lockfile that pins it.
  if (changed.some(isDependencyManifest) && !changed.some(isLockfile)) {
    found.push({
      rule: "dependency-without-lockfile",
      blocking: false,
      body:
        `You changed a dependency manifest without updating a lockfile. Run the package ` +
        `manager's install so the lockfile is regenerated and committed — otherwise the build ` +
        `is not reproducible and the actual resolved version is invisible in review. Check for ` +
        `known advisories while you're there. See the \`dependency-hygiene\` skill.`,
    });
  }

  return found;
}

/* ----------------------------------------------------------- the gates */

/** Advisory rules nudge once; blocking rules get this many before standing down. */
const BLOCKING_BUDGET = 3;

/**
 * Inspect what the turn actually changed and, where a default was missed, send
 * the model back with a specific instruction. Returns silently when there is
 * nothing to say — the overwhelmingly common case.
 */
export async function runSecurityGates(instanceId: string, ctx: AgentFinishContext): Promise<void> {
  let diff: Diff | null;
  try {
    diff = await readDiff(instanceId, ctx);
  } catch (e) {
    ctx.log.warn(`security gates: could not read diff (${(e as Error).message})`);
    return;
  }
  if (!diff) return;

  const used = spent.get(instanceId) ?? new Map<string, number>();
  spent.set(instanceId, used);

  for (const finding of scanRules(diff)) {
    const count = used.get(finding.rule) ?? 0;
    const budget = finding.blocking ? BLOCKING_BUDGET : 1;

    if (count < budget) {
      used.set(finding.rule, count + 1);
      ctx.append({ kind: "signal", type: `security.${finding.rule}`, body: finding.body });
      ctx.log.info(`security gate fired: ${finding.rule} (${count + 1}/${budget})`);
      continue;
    }

    // Budget exhausted. For an advisory rule that's the end of it. For a
    // blocking one, terminate the loop but make sure the user hears about it —
    // going quiet here would hide exactly the problems that matter most.
    if (finding.blocking && count === budget) {
      used.set(finding.rule, count + 1);
      ctx.append({
        kind: "signal",
        type: `security.${finding.rule}.unresolved`,
        body:
          `This is unresolved after ${budget} attempts, so stop working on it now. ` +
          `Do NOT keep retrying. End your turn by telling the user plainly that it is ` +
          `outstanding, what you tried, and what you need from them. Original issue: ` +
          finding.body,
      });
      ctx.log.warn(`security gate unresolved after ${budget} attempts: ${finding.rule}`);
    }
  }
}
