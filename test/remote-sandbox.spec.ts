import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { remoteSandboxDriver, ensureRepoInSandbox, sandboxHost, sandboxEnabled } from "../agent/session/remote-sandbox.ts";

/**
 * The isolated execution sandbox, exercised over real HTTP.
 *
 * The point of the split is that the model's shell runs somewhere holding none
 * of the control plane's secrets. Two properties make that true, and both are
 * asserted here rather than assumed:
 *
 *   1. WORKSPACE CONTAINMENT — one conversation cannot reach another's
 *      checkout, or anything outside the workspace root, however it spells the
 *      path. This is the security boundary; a regression here quietly removes
 *      the isolation the container exists to provide.
 *   2. ENVIRONMENT — a command sees only what was sent with it. The service
 *      builds command env from an allowlist rather than inheriting its own, so
 *      an operator adding a variable does not hand it to the model.
 *
 * The service is started in-process on an ephemeral port, so this runs the
 * genuine HTTP path — serialisation, status codes, error mapping — without
 * needing the container.
 */

let baseUrl: string;
let root: string;
let server: ReturnType<typeof import("../sandbox/index.ts")["createSandboxServer"]>;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ada-sandbox-"));
  process.env.WORKSPACE_ROOT = root;
  const { createSandboxServer } = await import("../sandbox/index.ts");
  server = createSandboxServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const driverFor = (id: string, env?: Record<string, string>) =>
  remoteSandboxDriver({ baseUrl, id, env });

test("round-trips the whole SandboxDriver surface", async () => {
  const d = driverFor("inst-a");

  await d.mkdir("nested/dir", { recursive: true });
  await d.writeFile("nested/dir/hello.txt", "hello sandbox");
  expect(await d.readFile("nested/dir/hello.txt")).toBe("hello sandbox");
  expect(await d.exists("nested/dir/hello.txt")).toBe(true);
  expect(await d.exists("nope.txt")).toBe(false);

  const s = await d.stat("nested/dir/hello.txt");
  expect(s.isFile).toBe(true);
  expect(s.isDirectory).toBe(false);
  expect(s.size).toBe("hello sandbox".length);

  expect(await d.readdir("nested/dir")).toContain("hello.txt");

  // Binary must survive the base64 hop unchanged.
  const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
  await d.writeFile("bin.dat", bytes);
  expect(Array.from(await d.readFileBuffer("bin.dat"))).toEqual(Array.from(bytes));

  await d.rm("nested", { recursive: true });
  expect(await d.exists("nested/dir/hello.txt")).toBe(false);
});

test("runs commands and reports a non-zero exit as a result, not a failure", async () => {
  const d = driverFor("inst-b");
  const ok = await d.exec("echo hi && pwd");
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toContain("hi");

  // A failing build must reach the model as stderr + exit code. Mapping it to a
  // transport error would hide the one thing the agent needs to read.
  const bad = await d.exec("echo boom >&2; exit 3");
  expect(bad.exitCode).toBe(3);
  expect(bad.stderr).toContain("boom");
});

test("isolates one instance's workspace from another's", async () => {
  const a = driverFor("inst-x");
  const b = driverFor("inst-y");
  await a.writeFile("secret.txt", "instance-x data");

  expect(await b.exists("secret.txt"), "y must not see x's file").toBe(false);
  await expect(b.readFile("secret.txt")).rejects.toThrow();

  // …and not via a traversal either.
  await expect(b.readFile("../inst-x/secret.txt")).rejects.toThrow(/escapes the workspace/);
});

test("rejects paths that escape the workspace root", async () => {
  const d = driverFor("inst-esc");
  for (const p of ["../../etc/passwd", "/etc/passwd", "a/../../../etc/passwd"]) {
    await expect(d.readFile(p), `must reject ${p}`).rejects.toThrow(/escapes the workspace/);
  }
  // The host filesystem is untouched by an attempt.
  expect(existsSync("/etc/passwd")).toBe(true);
});

test("a command sees only the env sent with it", async () => {
  // The service builds command env from an allowlist rather than inheriting
  // its own process env — so a secret held by the container never leaks into a
  // command the model runs.
  process.env.SANDBOX_LEAK_CANARY = "should-not-appear";
  try {
    const d = driverFor("inst-env", { GH_TOKEN: "token-for-this-session" });
    const leaked = await d.exec("echo \"${SANDBOX_LEAK_CANARY:-absent}\"");
    expect(leaked.stdout.trim(), "container env must not reach the command").toBe("absent");

    const sent = await d.exec("echo \"${GH_TOKEN:-absent}\"");
    expect(sent.stdout.trim(), "session env is forwarded per request").toBe("token-for-this-session");

    // PATH must still be there, or nothing runs.
    expect((await d.exec("echo $PATH")).stdout.trim().length).toBeGreaterThan(0);
  } finally {
    delete process.env.SANDBOX_LEAK_CANARY;
  }
});

test("clones a repo inside the sandbox and reuses it on the next turn", async () => {
  const d = driverFor("inst-repo");
  // Serve a local repo over file:// so the test needs no network.
  const origin = mkdtempSync(join(tmpdir(), "ada-origin-"));
  try {
    await d.exec(`git init -q "${origin}" && cd "${origin}" && git config user.email t@t.t && git config user.name t && echo hi > a.txt && git add -A && git commit -qm init`, { cwd: "." });
    // ensureRepoInSandbox builds a github.com URL, so exercise the reuse path
    // (the branch that must not re-clone) by pre-creating the checkout.
    await d.exec(`git clone -q "${origin}" myrepo`);
    expect(await d.exists("myrepo/.git")).toBe(true);

    const reused = await ensureRepoInSandbox(d, { owner: "someone", repo: "myrepo" });
    expect(reused).toEqual({ dir: "myrepo", cloned: false });
  } finally {
    rmSync(origin, { recursive: true, force: true });
  }
});

test("refuses a repo spec that was not validated", async () => {
  const d = driverFor("inst-inject");
  await expect(
    ensureRepoInSandbox(d, { owner: "x; rm -rf /", repo: "y" }),
  ).rejects.toThrow(/unvalidated repo spec/);
});

test("selects remote only when the platform injects a sandbox host", () => {
  expect(sandboxEnabled({})).toBe(false);
  expect(sandboxHost({})).toBeNull();
  expect(sandboxHost({ KNOWLEDGE_SANDBOX_HOST: "sandbox" })).toBe("http://sandbox:3000");
  expect(sandboxHost({ KNOWLEDGE_SANDBOX_HOST: "sandbox", KNOWLEDGE_SANDBOX_PORT: "9000" })).toBe("http://sandbox:9000");
});

/* ---------------- the sandbox as Flue actually uses it ---------------- */

/**
 * Everything above drives the driver directly. These go through
 * `remote().createSandbox()` — the path `useSandbox()` takes — because a bug
 * shipped that only existed in that layer.
 *
 * The factory passed a RELATIVE cwd ("." or a repo name) to
 * `sandboxFromDriver`. Flue resolves tool paths as
 * `p.startsWith("/") ? p : cwd + "/" + p` and normalises the result, so a
 * relative cwd makes `resolvePath(".")` collapse to `/`. Every `bash`, `read`,
 * `grep` and `glob` then arrived here as `/` and was rejected — correctly — as
 * escaping the workspace. A deployed session could not run `true`, let alone
 * reach its own checkout.
 */

test("roots the sandbox at an absolute workspace path", async () => {
  const { remote } = await import("../agent/session/remote-sandbox.ts");
  const sandbox = await remote({ baseUrl }).createSandbox({ id: "inst-cwd" });

  // The regression guard: a relative cwd normalises to "/" here.
  expect(sandbox.cwd.startsWith("/"), `cwd must be absolute, got ${sandbox.cwd}`).toBe(true);
  expect(sandbox.cwd).not.toBe("/");

  // The exact commands the deployed session could not run.
  const trivial = await sandbox.exec("true");
  expect(trivial.exitCode, "`true` must run").toBe(0);
  // `pwd -P` and realpath on both sides: macOS resolves /var -> /private/var,
  // which would fail a string compare for a reason that does not exist in the
  // Linux container. The property under test is that the shell and the file
  // tools agree on the directory, not on its spelling.
  const pwd = await sandbox.exec("pwd -P");
  expect(pwd.stdout.trim(), "the shell agrees with the sandbox cwd").toBe(realpathSync(sandbox.cwd));

  // …and relative paths resolve inside the workspace rather than at /.
  await sandbox.writeFile("a.txt", "content");
  expect(await sandbox.readFile("a.txt")).toBe("content");
});

test("roots the sandbox inside a checkout when one is named", async () => {
  const { remote, remoteSandboxDriver } = await import("../agent/session/remote-sandbox.ts");
  const driver = remoteSandboxDriver({ baseUrl, id: "inst-sub" });
  await driver.mkdir("astro", { recursive: true });
  await driver.writeFile("astro/agents.md", "# rules");

  const sandbox = await remote({ baseUrl, subdir: "astro" }).createSandbox({ id: "inst-sub" });
  expect(sandbox.cwd.endsWith("/astro")).toBe(true);
  // A bare filename must resolve inside the checkout — this is what makes
  // Flue's own AGENTS.md discovery find the project's conventions.
  expect(await sandbox.readFile("agents.md")).toBe("# rules");
});

test("reports the instance's absolute workspace path", async () => {
  const { remoteSandboxDriver } = await import("../agent/session/remote-sandbox.ts");
  const a = await remoteSandboxDriver({ baseUrl, id: "inst-ws-a" }).workspacePath();
  const b = await remoteSandboxDriver({ baseUrl, id: "inst-ws-b" }).workspacePath();
  expect(a.startsWith("/")).toBe(true);
  expect(a, "each instance gets its own directory").not.toBe(b);
});
