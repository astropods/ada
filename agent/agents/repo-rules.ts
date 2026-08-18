/**
 * Repository conventions — making sure Ada actually reads the rules.
 *
 * Flue discovers workspace context itself: `readAgentsMd` reads `AGENTS.md` and
 * `CLAUDE.md` from the session's working directory into the system prompt. That
 * works, but it missed real repositories in two ways we hit in production —
 * Ada opened a PR against a repo whose `agents.md` requires a changelog file,
 * without one, because it had never seen the rules.
 *
 *   1. THE WORKING DIRECTORY. Flue reads from the sandbox cwd. Ada only points
 *      that at the checkout when a thread is bound with `work on owner/repo`;
 *      when the model clones the repo itself mid-turn, cwd stays at the
 *      workspace ROOT and the checkout is a subdirectory. Verified: rules land
 *      in the prompt with cwd at the repo, and are silently absent with cwd one
 *      level up.
 *
 *   2. THE FILENAME. The lookup is two exact, case-sensitive literals. The repo
 *      that caught this ships lowercase `agents.md`; it only survived because
 *      `CLAUDE.md` happens to be a symlink to it. A repo with lowercase
 *      `agents.md` and no symlink gets nothing on Linux — and this is easy to
 *      miss locally, because macOS is case-insensitive and it appears to work.
 *
 * So this hook finds what Flue would have missed and injects it as a signal at
 * the start of the turn. It deliberately injects only the DIFFERENCE: if the
 * cwd already has an exactly-named file Flue reads, that copy is skipped rather
 * than sent twice.
 */

import type { AgentStartContext } from "@flue/runtime";

/** Run a shell command in the agent's sandbox and return stdout ("" on failure). */
export type Exec = (command: string) => Promise<string>;

/** Rule filenames worth reading, matched case-insensitively. */
const RULE_FILES = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CONVENTIONS.md"];

/** Exactly what Flue's own discovery reads, so we don't duplicate it. */
const FLUE_READS = ["AGENTS.md", "CLAUDE.md"];

/**
 * Total budget for injected rules. A rules file is usually a few KB; a runaway
 * one would crowd out the actual task, so cap it and say so rather than
 * silently truncating the project's own instructions.
 */
const MAX_RULES_BYTES = Number(process.env.ADA_MAX_RULES_BYTES ?? 24_000);

/** Adapt a Flue sandbox to the `Exec` shape, swallowing failures. */
export function sandboxExec(sandbox: { exec: AgentStartContext["harness"]["sandbox"]["exec"] }): Exec {
  return async (command) => {
    try {
      const r = await sandbox.exec(command, { timeoutMs: 10_000 });
      return r.exitCode === 0 ? r.stdout : "";
    } catch {
      return "";
    }
  };
}

/**
 * Candidate directories: the cwd, plus any immediate subdirectory that is a git
 * checkout. Depth 1 only — a session works on one repo, and walking deeper
 * turns a node_modules tree into a filesystem crawl.
 */
async function candidateDirs(sh: Exec): Promise<string[]> {
  const cwd = (await sh("pwd")).trim();
  if (!cwd) return [];
  const nested = (await sh(`find . -maxdepth 2 -name .git -not -path './.git' 2>/dev/null | head -5`))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // ./repo/.git -> repo
    .map((l) => l.replace(/^\.\//, "").replace(/\/?\.git$/, ""))
    .filter(Boolean)
    .map((rel) => `${cwd}/${rel}`);
  return [cwd, ...nested];
}

export interface RulesFile {
  path: string;
  body: string;
  /** The file was longer than the read cap — the model is told, not left guessing. */
  truncated: boolean;
}

/**
 * Collect rule files Flue's own discovery would not have picked up.
 *
 * Dedupes on CONTENT, not path: `CLAUDE.md` is frequently a symlink to
 * `agents.md`, and injecting the same document twice is pure waste.
 */
export async function readRepoRules(sh: Exec): Promise<RulesFile[]> {
  const dirs = await candidateDirs(sh);
  if (dirs.length === 0) return [];
  const cwd = dirs[0];
  const out: RulesFile[] = [];

  for (const dir of dirs) {
    // Dedupe WITHIN a directory, not across them. The case this exists for is
    // `CLAUDE.md` symlinked to `agents.md` in one repo. Deduping globally would
    // silently drop a second repo whose rules merely open with the same
    // boilerplate — observed against a workspace of sibling repos that share a
    // house style, where one repo's conventions vanished entirely.
    const seen = new Set<string>();
    // `-iname` is the whole point: Flue's lookup is case-sensitive, and
    // lowercase `agents.md` is common.
    const names = RULE_FILES.map((n) => `-iname ${JSON.stringify(n)}`).join(" -o ");
    const found = (await sh(`find ${JSON.stringify(dir)} -maxdepth 1 \\( ${names} \\) 2>/dev/null`))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    for (const path of found) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      // Flue already read this one into the system prompt — skip it.
      if (dir === cwd && FLUE_READS.includes(base)) continue;
      // Read ONE byte past the cap, so a file that hits the limit is
      // distinguishable from one that merely happens to be exactly that long.
      // Without this the truncation is silent, which is the worst outcome: the
      // model reads half a rulebook and believes it read all of it.
      const raw = await sh(`head -c ${MAX_RULES_BYTES + 1} -- ${JSON.stringify(path)}`);
      const truncated = raw.length > MAX_RULES_BYTES;
      const body = (truncated ? raw.slice(0, MAX_RULES_BYTES) : raw).trim();
      if (!body) continue;
      const key = body.slice(0, 512);
      if (seen.has(key)) continue; // same document via a symlink
      seen.add(key);
      out.push({ path: path.startsWith(cwd) ? path.slice(cwd.length + 1) || base : path, body, truncated });
    }
  }
  return out;
}

/**
 * Inject repository conventions the framework's discovery missed.
 *
 * Registered as a `useAgentStart` hook so the rules are in front of the model
 * before it plans, not discovered halfway through. Silent when there is nothing
 * to add — which is the common case for a correctly-rooted session.
 */
export async function injectRepoRules(ctx: AgentStartContext): Promise<void> {
  let rules: RulesFile[];
  try {
    rules = await readRepoRules(sandboxExec(ctx.harness.sandbox));
  } catch (e) {
    ctx.log.warn(`repo rules: could not read conventions (${(e as Error).message})`);
    return;
  }
  if (rules.length === 0) return;

  let budget = MAX_RULES_BYTES;
  const sections: string[] = [];
  for (const r of rules) {
    if (budget <= 0) {
      sections.push(`\n[${r.path} omitted — rules budget exhausted. Read it yourself before making changes.]`);
      break;
    }
    const overBudget = r.body.length > budget;
    const kept = overBudget ? r.body.slice(0, budget) : r.body;
    budget -= kept.length;
    const note =
      overBudget || r.truncated
        ? `\n\n[…truncated — read ${r.path} yourself before making changes, the rest of its rules still apply]`
        : "";
    sections.push(`### ${r.path}\n\n${kept}${note}`);
  }

  ctx.append({ kind: "signal", type: "repo.conventions", body: formatRules(sections) });
  ctx.log.info(`repo rules: injected ${rules.map((r) => r.path).join(", ")}`);
}

/** The preamble that makes clear these rules outrank Ada's own defaults. */
export function formatRules(sections: string[]): string {
  return (
    `This repository ships its own conventions. They are the project's rules and they OVERRIDE ` +
    `your defaults wherever the two disagree — including any requirement to ADD FILES (a changelog ` +
    `entry, an ADR), follow a commit or branch naming format, or run particular checks before ` +
    `opening a pull request. Read them now and follow them. If you cannot, say so explicitly ` +
    `rather than ignoring them.\n\n` +
    sections.join("\n\n")
  );
}

/**
 * Rules formatted for a tool result, budgeted the same way as the signal.
 *
 * Used by `checkout_repo`, because the start-of-turn hook cannot help a repo
 * that does not exist yet: on the first turn the workspace is empty, the agent
 * clones mid-turn, and it would otherwise finish the whole task — branch,
 * commit, PR — without ever having seen the project's conventions. That is
 * exactly how a PR shipped with no changelog entry.
 */
export function renderRules(rules: RulesFile[]): string | undefined {
  if (rules.length === 0) return undefined;
  let budget = MAX_RULES_BYTES;
  const sections: string[] = [];
  for (const r of rules) {
    if (budget <= 0) break;
    const kept = r.body.length > budget ? r.body.slice(0, budget) : r.body;
    budget -= kept.length;
    const note =
      r.body.length > budget || r.truncated
        ? `\n\n[…truncated — read ${r.path} yourself before making changes]`
        : "";
    sections.push(`### ${r.path}\n\n${kept}${note}`);
  }
  return formatRules(sections);
}
