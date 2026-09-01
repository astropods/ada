import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../agent/agents/shell.ts";
import { readRepoRules, sandboxExec } from "../agent/agents/repo-rules.ts";

/**
 * Shell quoting for values spliced into a command line.
 *
 * These commands run through `/bin/sh -c`, so an interpolated value is shell
 * SOURCE. The previous quoting was `JSON.stringify`, which produces a
 * DOUBLE-quoted word — and a double-quoted shell word still expands `$`,
 * backticks and `\`. JSON escaping and shell escaping are different languages
 * that happen to agree about `"`.
 *
 * These run in the isolated sandbox, where the model can already run `bash`, so
 * the stake is correctness rather than privilege: a file whose name contains a
 * `$` was silently unreadable, which for a SECURITY gate means its contents
 * were never scanned. A gate that quietly sees nothing is worse than no gate.
 *
 * The contract is asserted against the REAL shell rather than by comparing
 * strings, because the only thing that matters is what `sh` does with it.
 */

const exec = promisify(execFile);

/** What `sh` actually produces for a quoted value. */
async function throughShell(value: string): Promise<string> {
  const { stdout } = await exec("sh", ["-c", `printf %s ${shellQuote(value)}`]);
  return stdout;
}

const HOSTILE = [
  "plain.md",
  "with space.md",
  "$(id).md",
  "`id`.md",
  "$HOME.md",
  "${HOME}.md",
  "a\\b.md",
  "quote'inside.md",
  "two''quotes.md",
  'double"quote.md',
  "semi;colon.md",
  "pipe|bar.md",
  "amp&and.md",
  "glob*star?.md",
  "new\nline.md",
  "tab\there.md",
  "trailing$",
  "!bang.md",
  "(paren).md",
  "#hash.md",
];

test("survives the real shell verbatim, whatever the value contains", async () => {
  for (const value of HOSTILE) {
    expect(await throughShell(value), `must round-trip: ${JSON.stringify(value)}`).toBe(value);
  }
});

test("JSON.stringify does NOT survive it — the bug this replaces", async () => {
  // Pins WHY the helper exists. If someone reverts to JSON.stringify, the test
  // above starts failing and this one explains what changed.
  const { stdout } = await exec("sh", ["-c", `printf %s ${JSON.stringify("$(echo pwned).md")}`]);
  expect(stdout, "double quotes let sh run the substitution").toBe("pwned.md");
  // …while the single-quoted form is inert.
  expect(await throughShell("$(echo pwned).md")).toBe("$(echo pwned).md");
});

test("quotes a lone single quote and an empty value", async () => {
  expect(await throughShell("'")).toBe("'");
  expect(await throughShell("")).toBe("");
  expect(shellQuote("")).toBe("''"); // an empty word must still BE a word
});

/* ---------------- the call sites ---------------- */

/** An `Exec` rooted at `cwd`, running the genuine shell. */
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

test("finds and reads repo rules through a shell-hostile directory name", async () => {
  // A workspace path is not always tame — it carries a repo name, and the
  // `find` that discovers AGENTS.md interpolates the directory it searches.
  const parent = mkdtempSync(join(tmpdir(), "ada-quote-"));
  const dir = join(parent, "repo $(id) `id` 'x' $HOME");
  try {
    mkdirSync(dir, { recursive: true });
    // AGENT.md rather than AGENTS.md: the latter is skipped at the cwd on
    // purpose, because Flue's own discovery already read it.
    writeFileSync(join(dir, "AGENT.md"), "# House rules\n\nAlways add a changelog.\n");

    const rules = await readRepoRules(execIn(dir));
    expect(rules.map((r) => r.path.replace(/^.*\//, "")), "the file must be found").toEqual([
      "AGENT.md",
    ]);
    // Discovery is `find`; reading is `head`. Both interpolate, so assert the
    // BODY arrived, not just that the path was listed.
    expect(rules[0].body, "the file must also be readable").toContain("Always add a changelog.");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
