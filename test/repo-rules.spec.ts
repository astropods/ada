import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectRepoRules } from "../agent/agents/repo-rules.ts";

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
