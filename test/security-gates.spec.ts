import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  captureBaseline,
  runSecurityGates,
  clearGateState,
} from "../agent/agents/security/gates.ts";

/**
 * Security gate rules, exercised against real git repositories.
 *
 * These gates are the layer that ENFORCES Ada's secure-by-default behaviour
 * (agents/security/gates.ts), so both directions matter and both are asserted:
 *
 *   - a rule that stops firing is a control silently removed;
 *   - a rule that fires when it shouldn't is worse than useless, because a gate
 *     that cries wolf is one the model learns to argue past.
 *
 * Each case builds a throwaway repo, commits a baseline, applies a change, and
 * asserts the EXACT set of rules that fire. No model and no network involved —
 * the gates are pure functions of the diff.
 */

const exec = promisify(execFile);

/** Minimal stand-in for AgentFinishContext: a sandbox rooted at `cwd`. */
function fakeContext(cwd: string, appended: string[]) {
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
    append: (m: { type: string }) => appended.push(m.type.replace(/^security\./, "")),
    log: { info() {}, warn() {}, error() {} },
    response: { toolCalls: [], usage: {} },
    signal: new AbortController().signal,
  };
}

function write(dir: string, rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/**
 * `seed` establishes what the project ALREADY has before the turn — several
 * rules are deliberately conditional on the repo having tests or a spec at all.
 */
async function firedRules(
  seed: (dir: string) => void,
  change: (dir: string) => void,
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "ada-gate-"));
  const instanceId = `test_${Math.random().toString(36).slice(2)}`;
  try {
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "t"], { cwd: dir });
    write(dir, "src/seed.ts", "export const x = 1;\n");
    seed(dir);
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-qm", "base"], { cwd: dir });

    const appended: string[] = [];
    const ctx = fakeContext(dir, appended);
    await captureBaseline(instanceId, ctx as never);
    change(dir);
    await runSecurityGates(instanceId, ctx as never);
    return appended.sort();
  } finally {
    clearGateState(instanceId);
    rmSync(dir, { recursive: true, force: true });
  }
}

const withTests = (d: string) => write(d, "src/existing.test.ts", 'it("x", () => expect(1).toBe(1));\n');
const withSpec = (d: string) => {
  withTests(d);
  write(d, "openapi.yaml", "openapi: 3.0.0\n");
};
const noSeed = () => {};

test("flags a credential added in a new file", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "src/cfg.ts", `export const T = "ghp_${"A".repeat(36)}";\n`),
  );
  expect(rules).toEqual(["secret-in-diff"]);
});

test("flags a private key block", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "key.pem", "-----BEGIN RSA PRIVATE KEY-----\nabc\n"),
  );
  expect(rules).toEqual(["secret-in-diff"]);
});

test("does NOT flag placeholders in .env.example", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, ".env.example", "GITHUB_TOKEN=your-token-here\nAPI_KEY=\n"),
  );
  expect(rules).toEqual([]);
});

test("flags a test disabled with .skip", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "src/a.test.ts", 'it.skip("w", () => expect(1).toBe(1));\n'),
  );
  expect(rules).toEqual(["weakened-check"]);
});

test("flags a @ts-ignore suppression", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "src/b.ts", "// @ts-ignore\nconst y: number = 'no';\n"),
  );
  expect(rules).toEqual(["weakened-check"]);
});

test("flags a route change that touches no test", async () => {
  const rules = await firedRules(withTests, (d) =>
    write(d, "src/routes/users.ts", "export const g = (r) => db.find(r.params.id);\n"),
  );
  expect(rules).toEqual(["route-without-test"]);
});

test("stays quiet when the route change updates a test", async () => {
  const rules = await firedRules(withTests, (d) => {
    write(d, "src/routes/users.ts", "export const g = 1;\n");
    write(d, "src/routes/users.test.ts", 'it("404s for non-owner", () => expect(1).toBe(1));\n');
  });
  expect(rules).toEqual([]);
});

test("stays quiet about tests in a repo that has none", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "src/routes/users.ts", "export const g = 1;\n"),
  );
  expect(rules).toEqual([]);
});

test("flags a route change that leaves the spec stale", async () => {
  const rules = await firedRules(withSpec, (d) => {
    write(d, "src/routes/users.ts", "export const g = 1;\n");
    write(d, "src/routes/users.test.ts", 'it("t", () => expect(1).toBe(1));\n');
  });
  expect(rules).toEqual(["api-change-without-spec"]);
});

test("stays quiet when route, test and spec all move together", async () => {
  const rules = await firedRules(withSpec, (d) => {
    write(d, "src/routes/users.ts", "export const g = 1;\n");
    write(d, "src/routes/users.test.ts", 'it("t", () => expect(1).toBe(1));\n');
    write(d, "openapi.yaml", "openapi: 3.0.0\npaths: {}\n");
  });
  expect(rules).toEqual([]);
});

test("flags a migration with no reversal", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "migrations/001.sql", "ALTER TABLE users ADD COLUMN e text;\n"),
  );
  expect(rules).toEqual(["migration-without-down"]);
});

test("stays quiet when the migration has a down", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "migrations/002.sql", "-- up\nADD;\n-- down\nDROP;\n"),
  );
  expect(rules).toEqual([]);
});

test("flags a dependency added without a lockfile", async () => {
  const rules = await firedRules(noSeed, (d) =>
    write(d, "package.json", '{"dependencies":{"left-pad":"^1.0.0"}}\n'),
  );
  expect(rules).toEqual(["dependency-without-lockfile"]);
});

test("stays quiet when the lockfile moves with the manifest", async () => {
  const rules = await firedRules(noSeed, (d) => {
    write(d, "package.json", '{"dependencies":{"left-pad":"^1.0.0"}}\n');
    write(d, "package-lock.json", '{"lockfileVersion":3}\n');
  });
  expect(rules).toEqual([]);
});

test("stays quiet on an ordinary change", async () => {
  const rules = await firedRules(withSpec, (d) =>
    write(d, "src/util.ts", "export const add = (a, b) => a + b;\n"),
  );
  expect(rules).toEqual([]);
});

test("stays quiet when nothing changed", async () => {
  expect(await firedRules(withSpec, () => {})).toEqual([]);
});

test("advisory rules fire once per session, not on every stop", async () => {
  // A gate that re-fires forever is an infinite loop billed to the user, so the
  // budget is part of the contract, not an implementation detail.
  const dir = mkdtempSync(join(tmpdir(), "ada-gate-"));
  const instanceId = `budget_${Math.random().toString(36).slice(2)}`;
  try {
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "t"], { cwd: dir });
    write(dir, "src/seed.ts", "export const x = 1;\n");
    withTests(dir);
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-qm", "base"], { cwd: dir });

    const appended: string[] = [];
    const ctx = fakeContext(dir, appended);
    await captureBaseline(instanceId, ctx as never);
    write(dir, "src/routes/users.ts", "export const g = 1;\n");

    await runSecurityGates(instanceId, ctx as never);
    await runSecurityGates(instanceId, ctx as never);
    await runSecurityGates(instanceId, ctx as never);

    expect(appended).toEqual(["route-without-test"]);
  } finally {
    clearGateState(instanceId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blocking rule escalates, then terminates instead of looping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ada-gate-"));
  const instanceId = `block_${Math.random().toString(36).slice(2)}`;
  try {
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    await exec("git", ["config", "user.name", "t"], { cwd: dir });
    write(dir, "src/seed.ts", "export const x = 1;\n");
    await exec("git", ["add", "-A"], { cwd: dir });
    await exec("git", ["commit", "-qm", "base"], { cwd: dir });

    const appended: string[] = [];
    const ctx = fakeContext(dir, appended);
    await captureBaseline(instanceId, ctx as never);
    write(dir, "src/cfg.ts", `export const T = "ghp_${"A".repeat(36)}";\n`);

    for (let i = 0; i < 6; i += 1) await runSecurityGates(instanceId, ctx as never);

    // Three attempts, then one terminal "stop and tell the user" signal — and
    // nothing after that, so an unfixable secret ends the turn loudly rather
    // than spinning forever or going quiet.
    expect(appended).toEqual([
      "secret-in-diff",
      "secret-in-diff",
      "secret-in-diff",
      "secret-in-diff.unresolved",
    ]);
  } finally {
    clearGateState(instanceId);
    rmSync(dir, { recursive: true, force: true });
  }
});
