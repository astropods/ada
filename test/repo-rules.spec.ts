import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectRepoRules, readRepoRules, renderRules, sandboxExec } from "../agent/agents/repo-rules.ts";

/**
 * Repository conventions reaching the model.
 *
 * Written after Ada opened a PR against a repo whose `agents.md` requires a
 * changelog file, without one. Flue reads `AGENTS.md`/`CLAUDE.md` from the
 * sandbox cwd, and both of its assumptions failed on that repo: the checkout
 * was one directory BELOW the cwd, and the rules file is lowercase while the
 * lookup uses two exact case-sensitive literals.
 *
 * The casing half is easy to get falsely confident about — macOS is
 * case-insensitive, so a lowercase `agents.md` resolves locally and fails in
 * the Linux container. These cases exercise the finder directly, which is
 * case-insensitive by construction, so the result does not depend on the
 * filesystem the suite happens to run on.
 */

const exec = promisify(execFile);

/** Stand-in for AgentStartContext, rooted at `cwd`. */
function fakeContext(cwd: string, appended: string[], logged: string[] = []) {
  return {
    harness: {
      sandbox: {
        async exec(command: string) {
          try {
            const { stdout } = await exec("sh", ["-c", command], { cwd, maxBuffer: 1e7 });
            return { stdout, stderr: "", exitCode: 0 };
          } catch (e) {
            return { stdout: (e as { stdout?: string }).stdout ?? "", stderr: "", exitCode: 1 };
          }
        },
      },
    },
    append: (m: { body: string }) => appended.push(m.body),
    log: { info: (m: string) => logged.push(m), warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

const RULE = "Every PR must include a changelog file at docs/changelog/{branch-name}-YYYY-MM-DD.md";

async function gitInit(dir: string) {
  await exec("git", ["init", "-q"], { cwd: dir });
}

/** Returns the injected signal bodies for a workspace built by `setup`. */
async function injected(setup: (ws: string) => Promise<void> | void): Promise<string[]> {
  const ws = mkdtempSync(join(tmpdir(), "ada-rules-"));
  try {
    await setup(ws);
    const appended: string[] = [];
    await injectRepoRules(fakeContext(ws, appended) as never);
    return appended;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test("finds lowercase agents.md in a checkout below the cwd", async () => {
  // The production case exactly: cwd is the workspace, the repo is a subdir.
  const bodies = await injected(async (ws) => {
    const repo = join(ws, "astro");
    mkdirSync(repo, { recursive: true });
    await gitInit(repo);
    writeFileSync(join(repo, "agents.md"), `# Rules\n\n${RULE}\n`);
  });
  expect(bodies.length).toBe(1);
  expect(bodies[0]).toContain(RULE);
  expect(bodies[0], "flags that repo rules win over Ada's defaults").toContain("OVERRIDE");
});

test("does not send the same document twice when CLAUDE.md is a symlink", async () => {
  const bodies = await injected(async (ws) => {
    const repo = join(ws, "astro");
    mkdirSync(repo, { recursive: true });
    await gitInit(repo);
    writeFileSync(join(repo, "agents.md"), `# Rules\n\n${RULE}\n`);
    symlinkSync("agents.md", join(repo, "CLAUDE.md"));
  });
  expect(bodies.length).toBe(1);
  const occurrences = bodies[0].split(RULE).length - 1;
  expect(occurrences, "the same rules body injected once, not per filename").toBe(1);
});

test("skips files Flue already read from the cwd itself", async () => {
  // An exactly-named file in the cwd is in the system prompt already; sending
  // it again is pure waste.
  const bodies = await injected(async (ws) => {
    await gitInit(ws);
    writeFileSync(join(ws, "AGENTS.md"), `# Rules\n\n${RULE}\n`);
  });
  expect(bodies).toEqual([]);
});

test("still injects a cwd file whose casing Flue's lookup would miss", async () => {
  const bodies = await injected(async (ws) => {
    await gitInit(ws);
    writeFileSync(join(ws, "AGENT.md"), `# Rules\n\n${RULE}\n`);
  });
  expect(bodies.length).toBe(1);
  expect(bodies[0]).toContain(RULE);
});

test("stays silent when the repo has no conventions", async () => {
  const bodies = await injected(async (ws) => {
    const repo = join(ws, "plain");
    mkdirSync(repo, { recursive: true });
    await gitInit(repo);
    writeFileSync(join(repo, "README.md"), "# Just a readme\n");
  });
  expect(bodies).toEqual([]);
});

test("truncates a runaway rules file rather than crowding out the task", async () => {
  const bodies = await injected(async (ws) => {
    const repo = join(ws, "big");
    mkdirSync(repo, { recursive: true });
    await gitInit(repo);
    writeFileSync(join(repo, "agents.md"), "x".repeat(200_000));
  });
  expect(bodies.length).toBe(1);
  expect(bodies[0].length).toBeLessThan(60_000);
  expect(bodies[0], "says so instead of silently cutting the project's rules").toContain("truncated");
});

/* ---------------- rules for a repo cloned mid-turn ---------------- */

/**
 * The start-of-turn hook cannot help a repository that does not exist yet.
 *
 * On a first turn the workspace is empty; the agent clones mid-turn and then
 * branches, commits and opens a PR in that same turn. `useAgentStart` already
 * ran against an empty directory, and Flue's own AGENTS.md discovery reads at
 * submission start, so neither sees the rules. A PR shipped with no changelog
 * entry against a repo whose `agents.md` requires one, exactly this way.
 *
 * So `checkout_repo` reads the conventions itself and returns them with the
 * clone. These cover the reader it uses.
 */

/** A sandbox-shaped exec rooted at `cwd`, matching what the tool is handed. */
function execIn(cwd: string) {
  return sandboxExec({
    async exec(command: string) {
      try {
        const { stdout } = await exec("sh", ["-c", command], { cwd, maxBuffer: 1e7 });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (e) {
        return { stdout: (e as { stdout?: string }).stdout ?? "", stderr: "", exitCode: 1 };
      }
    },
  } as never);
}

test("an empty workspace yields nothing — the start-of-turn blind spot", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ada-rules-"));
  try {
    // This is the state useAgentStart actually sees on turn one.
    expect(await readRepoRules(execIn(ws))).toEqual([]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the same workspace yields the rules once the repo is cloned into it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ada-rules-"));
  try {
    // …and this is the state checkout_repo sees, moments later.
    const repo = join(ws, "astro");
    mkdirSync(repo, { recursive: true });
    await gitInit(repo);
    writeFileSync(join(repo, "agents.md"), `# Rules\n\n${RULE}\n`);

    const rules = await readRepoRules(execIn(ws));
    expect(rules.length).toBe(1);

    const rendered = renderRules(rules);
    expect(rendered).toContain(RULE);
    // The framing has to make clear these outrank Ada's own defaults, and name
    // the failure mode that actually happened.
    expect(rendered).toContain("OVERRIDE");
    expect(rendered).toContain("ADD FILES");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("renders nothing when the repo has no conventions", async () => {
  expect(renderRules([])).toBeUndefined();
});
