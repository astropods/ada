import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { remoteSandboxDriver, ensureRepoInSandbox, sandboxHost, sandboxEnabled } from "../agent/session/remote-sandbox.ts";
import { cloneCommand } from "../agent/session/repo.ts";

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

test("rejects a symlink that points out of the workspace", async () => {
  // The containment check used to be purely lexical, which defeats `../` and
  // absolute paths but NOT a symlink: the model could create one inside its own
  // workspace and `fs.readFile` would follow it straight out. That shipped.
  const d = driverFor("inst-symlink");
  await d.exec("ln -s /etc/passwd escape.txt");
  await d.exec("ln -s /etc evildir");

  await expect(d.readFile("escape.txt"), "a symlinked file").rejects.toThrow(/escapes the workspace/);
  await expect(d.readFile("evildir/passwd"), "a symlinked parent directory").rejects.toThrow(
    /escapes the workspace/,
  );
  await expect(d.readdir("evildir")).rejects.toThrow(/escapes the workspace/);
  // Writing through one must fail too, not just reading.
  await expect(d.writeFile("evildir/pwned", "x")).rejects.toThrow(/escapes the workspace/);

  // A symlink that stays INSIDE the workspace is still fine — the check
  // constrains where paths land, it does not ban symlinks.
  await d.writeFile("real.txt", "inside");
  await d.exec("ln -s real.txt alias.txt");
  expect(await d.readFile("alias.txt")).toBe("inside");
});

test("rejects a DANGLING symlink that points out of the workspace", async () => {
  /**
   * The second symlink hole, and the more dangerous one.
   *
   * The containment check walked up to the deepest EXISTING ancestor,
   * realpath'd that, and rejoined the missing components as text — which is
   * only sound if "does not exist" and "is not a symlink" mean the same thing.
   * They do not. `existsSync` FOLLOWS a link, so a symlink whose target does
   * not exist reads as absent: its own name became a "missing" component,
   * never dereferenced, and the lexical path sailed through the check. `write`
   * then followed it on the way out and created the file outside.
   *
   * Severity is the reason this is asserted from several angles rather than
   * once. `/write` runs in the SERVICE process, which is root so it can confine
   * commands — so this escaped the per-instance uid entirely and could land
   * anywhere in the container, `/etc/cron.d` included.
   */
  const d = driverFor("inst-dangling");
  const outside = join(root, "PWNED-dangling.txt");

  // The target deliberately does not exist — that is the whole trick.
  await d.exec(`ln -s ${outside} link`);
  expect(existsSync(outside), "precondition: the target must not exist yet").toBe(false);

  await expect(d.writeFile("link", "pwned")).rejects.toThrow(/escapes the workspace/);
  expect(existsSync(outside), "nothing may be created outside the workspace").toBe(false);

  // Reading through it is refused too, not just writing.
  await expect(d.readFile("link")).rejects.toThrow(/escapes the workspace/);

  // A dangling RELATIVE link out is the same hole spelled differently.
  await d.exec("ln -s ../../PWNED-relative.txt rel-link");
  await expect(d.writeFile("rel-link", "pwned")).rejects.toThrow(/escapes the workspace/);
  expect(existsSync(join(root, "..", "PWNED-relative.txt"))).toBe(false);

  // And so is a dangling link reached THROUGH a symlinked directory, which a
  // fix that only special-cased the final component would miss.
  await d.exec(`mkdir -p sub && ln -s ${root} sub/out`);
  await expect(d.writeFile("sub/out/PWNED-via-dir.txt", "pwned")).rejects.toThrow(
    /escapes the workspace/,
  );
});

test("still allows a dangling symlink that points INSIDE the workspace", async () => {
  // The other direction, and the one a careless fix breaks: refusing every
  // symlink whose target is missing would also refuse this, which is ordinary
  // and legitimate — a link created before the file it names. The rule is about
  // WHERE the link lands, never about whether the target exists yet.
  const d = driverFor("inst-dangling-ok");

  await d.exec("ln -s not-yet.txt inside-link");
  await d.writeFile("inside-link", "written through an inside link");
  // It must land on the target, not on the link.
  expect(await d.readFile("not-yet.txt")).toBe("written through an inside link");

  // A chain of links that stays inside is still fine.
  await d.exec("ln -s inside-link chain");
  await d.writeFile("chain", "through a chain");
  expect(await d.readFile("not-yet.txt")).toBe("through a chain");

  // And so is an ordinary new file, nested directories included — the case the
  // tolerant resolution exists to preserve.
  await d.writeFile("a/b/c/new.txt", "fresh");
  expect(await d.readFile("a/b/c/new.txt")).toBe("fresh");
});

test("rejects paths that escape the workspace root", async () => {
  const d = driverFor("inst-esc");
  for (const p of ["../../etc/passwd", "/etc/passwd", "a/../../../etc/passwd"]) {
    await expect(d.readFile(p), `must reject ${p}`).rejects.toThrow(/escapes the workspace/);
  }
  // The host filesystem is untouched by an attempt.
  expect(existsSync("/etc/passwd")).toBe(true);
});

test("no generated symlink shape can write outside the workspace", async () => {
  /**
   * A PROPERTY test, because enumerating cases has now failed twice.
   *
   * Both symlink escapes in this service were found by someone thinking of a
   * shape nobody had thought of before: first a symlink to an existing target,
   * then a DANGLING one. Each fix came with tests for the shape that was
   * reported, and each looked complete. Listing cases is exactly the method
   * that produced two misses, so this searches the space instead.
   *
   * The oracle is the INVARIANT rather than the verdict. Predicting whether a
   * given shape should be accepted means reimplementing the resolver in the
   * test, which would just reproduce its bugs. Instead: whatever the service
   * decides, nothing may exist outside the workspace afterwards, and anything it
   * accepted must have landed inside. That holds for every shape without the
   * test needing to know which is which.
   *
   * Seeded so a failure is reproducible — the seed is printed on breakage.
   */
  const SEED = Number(process.env.ADA_FUZZ_SEED ?? 0x5eed);
  let x = SEED;
  const rnd = (n: number): number => {
    // Deterministic LCG. A random-per-run test that fails once and passes on
    // retry teaches nothing.
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x % n;
  };
  const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)];

  const d = driverFor("inst-fuzz");
  const wsFuzz = await d.workspacePath();
  const outsideDir = mkdtempSync(join(tmpdir(), "ada-fuzz-outside-"));

  try {
    for (let i = 0; i < 120; i++) {
      const name = `n${i}`;
      // Build a link whose target is drawn from the whole space: inside and
      // outside, absolute and relative, existing and dangling, direct and via
      // another link, with traversal thrown in.
      const target = pick([
        `${outsideDir}/canary-${i}.txt`,        // absolute, outside, dangling
        `${outsideDir}`,                        // absolute, outside, existing dir
        "/etc/ada-fuzz-should-never-exist",     // absolute, outside, dangling
        "/etc",                                 // absolute, outside, existing
        `../../${basename(outsideDir)}/c-${i}`, // relative traversal out
        `../../../../../../etc/x-${i}`,         // deep relative traversal
        `${wsFuzz}/inside-${i}.txt`,            // absolute, inside, dangling
        `inside-rel-${i}.txt`,                  // relative, inside, dangling
        `./nested/deep-${i}.txt`,               // relative, inside, nested
        `link-prev-${i - 1}`,                   // a chain through another link
      ]);
      await d.exec(`ln -sfn ${JSON.stringify(target)} ${JSON.stringify(`link-prev-${i}`)}`);

      const shape = pick([
        `link-prev-${i}`,                       // straight at the link
        `link-prev-${i}/child.txt`,             // through it as a directory
        `./link-prev-${i}`,
        `sub/../link-prev-${i}`,                // traversal then the link
      ]);

      // Whatever it decides is fine; both outcomes are legal answers.
      const wrote = await d
        .writeFile(shape, `fuzz-${i}`)
        .then(() => true)
        .catch(() => false);

      // INVARIANT 1: nothing may appear outside the workspace, ever.
      const leaked = readdirSync(outsideDir).filter((f) => f.startsWith("canary"));
      expect(
        leaked,
        `seed ${SEED}, iteration ${i}: shape ${shape} -> target ${target} escaped ` +
          `(rerun with ADA_FUZZ_SEED=${SEED})`,
      ).toEqual([]);
      expect(
        existsSync("/etc/ada-fuzz-should-never-exist"),
        `seed ${SEED}, iteration ${i}: wrote into /etc via ${target}`,
      ).toBe(false);

      // INVARIANT 2: if it accepted the write, the bytes must be inside the
      // workspace. An "accepted" that landed elsewhere is the actual bug.
      if (wrote) {
        const found = await d.exec(
          `grep -rl ${JSON.stringify(`fuzz-${i}`)} . 2>/dev/null | head -1`,
        );
        expect(
          found.stdout.trim().length > 0,
          `seed ${SEED}, iteration ${i}: accepted ${shape} but the content is not in the workspace`,
        ).toBe(true);
      }
    }
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("the kernel re-checks the resolver on the final component", async () => {
  // Defence in depth, and cheap: `resolveIn` returns a path whose symlinks are
  // already resolved, so opening with O_NOFOLLOW should never legitimately
  // fail. Asserting it means a future resolver bug surfaces as ELOOP — an
  // error — instead of as a write outside the workspace.
  const d = driverFor("inst-nofollow");

  // The legitimate cases must be unaffected by the flag.
  await d.writeFile("plain.txt", "ok");
  expect(await d.readFile("plain.txt")).toBe("ok");
  await d.exec("ln -s plain.txt alias.txt");
  expect(await d.readFile("alias.txt"), "an inside symlink still reads").toBe("ok");
  await d.writeFile("nested/deep/new.txt", "fresh");
  expect(await d.readFile("nested/deep/new.txt")).toBe("fresh");

  // A component swapped for a symlink AFTER resolution is what O_NOFOLLOW
  // catches. Simulated by pointing at a path the resolver treats as a plain new
  // file while it is in fact a link at open time.
  const raced = await d.exec("ln -sfn /etc/ada-race-target racy.txt && echo done");
  expect(raced.exitCode).toBe(0);
  await expect(d.writeFile("racy.txt", "pwned")).rejects.toThrow(/escapes the workspace|ELOOP/);
  expect(existsSync("/etc/ada-race-target")).toBe(false);
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

/* ---------------- staying inside the container's memory budget ---------------- */

/**
 * The sandbox runs builds inside a fixed, small container — measured at a 1GiB
 * memory limit and a CPU quota of a tenth of a core — and it cannot be resized.
 * Two things here used to spend that budget carelessly, and both are asserted
 * rather than assumed, because a regression shows up as an OOM kill in
 * production rather than as a failing test.
 *
 * The first is captured output. Anything retained beyond what the caller can
 * actually consume is pure cost, and the caller's limit is set by Flue: `bash`
 * truncates to the LAST 2000 lines or 50KB, while `grep` takes the FIRST 100
 * matching lines. So the service keeps a bounded window at BOTH ENDS and elides
 * the middle — and the tests below pin the invariant that matters, which is not
 * "output is small" but "the model sees exactly what it saw before".
 */

/** Flue's own downstream policy, mirrored so the assertions test the real thing. */
const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 51200;
function truncateTail(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines && text.length <= maxBytes) return text;
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > maxBytes) out = out.slice(-maxBytes);
  return out;
}
/** What Flue's `bash` tool would show the model for a given result. */
const bashView = (r: { stdout: string; stderr: string }): string =>
  truncateTail((r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim(), MAX_READ_LINES, MAX_READ_BYTES);
/** What Flue's `grep` tool would show the model — the HEAD, not the tail. */
const grepView = (r: { stdout: string }): string => r.stdout.trim().split("\n").slice(0, 100).join("\n");

const LINE = "x".repeat(50);
const manyLines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1} ${LINE}`);
/** ~10MB of stdout, well past any window, generated without a helper file. */
const emitLines = (n: number) =>
  `awk 'BEGIN{for(i=1;i<=${n};i++) printf "%d %s\\n", i, "${LINE}"}'`;

test("bounds captured output without changing what the model sees", async () => {
  const d = driverFor("inst-bigout");
  const n = 200_000;
  const r = await d.exec(emitLines(n));
  const unbounded = manyLines(n).join("\n");

  // The two views the framework actually derives, byte-for-byte against the
  // output as if nothing had been elided at all.
  expect(bashView(r), "bash sees the true tail").toBe(truncateTail(unbounded, MAX_READ_LINES, MAX_READ_BYTES));
  expect(grepView(r), "grep sees the true head").toBe(manyLines(100).join("\n"));

  // Both ends are kept precisely because those two disagree about which end
  // they want; keeping one would silently change which matches a search finds.
  expect(r.stdout.startsWith("1 ")).toBe(true);
  expect(r.stdout.trimEnd().endsWith(`${n} ${LINE}`)).toBe(true);

  // What was dropped is stated in-band. Silent truncation is the failure mode
  // worth avoiding — the model would reason about output it never received.
  expect(r.stdout).toMatch(/\[sandbox\] \d+ bytes of output elided/);
  // And the payload is a fraction of the ~10MB produced.
  expect(r.stdout.length).toBeLessThan(1_500_000);
});

test("small output is passed through untouched", async () => {
  // The overwhelming majority of commands are far under the window, and must
  // not be reshaped, re-encoded, or annotated in any way.
  const d = driverFor("inst-smallout");
  const r = await d.exec("printf 'a\\nb\\nc\\n'");
  expect(r.stdout).toBe("a\nb\nc\n");
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
});

test("a command that outruns the window completes instead of being killed", async () => {
  // `execFile`'s maxBuffer KILLS the child when it is exceeded, so a verbose
  // but perfectly successful build used to come back as a failure with partial
  // output. Bounding the capture ourselves decouples "how much we keep" from
  // "whether the command is allowed to finish".
  const d = driverFor("inst-overrun");
  const r = await d.exec(`${emitLines(400_000)}; echo sentinel-done`);
  expect(r.exitCode, "the command must be allowed to succeed").toBe(0);
  expect(r.stdout.trimEnd().endsWith("sentinel-done"), "its final line must survive").toBe(true);
});

test("a timeout kills the whole process tree, not just the shell", async () => {
  /**
   * This was a memory leak, not a tidiness point.
   *
   * The timeout signalled the direct child — `/bin/sh` — and left its
   * descendants orphaned and RUNNING. A `bun install` or `tsc` that timed out
   * kept its memory for as long as it liked, in the container least able to
   * spare it, and the next command started on top of it. Verified against the
   * old implementation: the grandchild survived.
   */
  const d = driverFor("inst-orphan");
  const marker = "orphan-marker.txt";
  const base = await d.exec("pwd");
  const abs = `${base.stdout.trim()}/${marker}`;

  // A grandchild that outlives the shell, then writes proof it was still alive.
  await d.exec(`( sh -c 'sleep 1; echo leaked > "${abs}"' ) & sleep 5`, { timeoutMs: 400 });
  await new Promise((r) => setTimeout(r, 2500));

  expect(await d.exists(marker), "an orphaned grandchild kept running after the timeout").toBe(false);
});

test("refuses to load a file too large to hold, and says how to read it", async () => {
  // A read is amplified on the way out (bytes -> base64 -> UTF-16 -> JSON), so
  // one vendored bundle can take the container down. Rejecting beats being
  // OOM-killed, and beats truncating silently: the model EDITS these files, and
  // a partial read it believes is whole is how a truncated file is written back.
  const d = driverFor("inst-bigfile");
  await d.writeFile("small.txt", "x".repeat(100));
  await d.writeFile("big.bin", "y".repeat(4096));

  // The limit is read per call, so it can be lowered here rather than needing a
  // 16MB fixture (which would itself be the memory spike under test).
  process.env.SANDBOX_MAX_READ_FILE_BYTES = "1024";
  try {
    expect(await d.readFile("small.txt"), "an ordinary file still reads").toHaveLength(100);

    await expect(d.readFile("big.bin")).rejects.toThrow(/above the sandbox read limit/);
    await expect(d.readFileBuffer("big.bin")).rejects.toThrow(/above the sandbox read limit/);
    // The error has to tell the model what to do instead.
    await expect(d.readFile("big.bin")).rejects.toThrow(/sed -n, head, tail/);

    // A missing file must still report as missing, not as oversized.
    await expect(d.readFile("nope.txt")).rejects.toThrow(/ENOENT/);
  } finally {
    delete process.env.SANDBOX_MAX_READ_FILE_BYTES;
  }
  // With the cap restored, the same file reads fine — the limit is the only
  // thing that refused it.
  expect(await d.readFile("big.bin")).toHaveLength(4096);
});

test("caps the clone's delta threads, which is a memory control", () => {
  // `git index-pack` runs one delta-resolution thread per detected CPU (capped
  // at 3) and its own docs note the delta-window memory is multiplied by the
  // thread count. In a CPU-quota'd container that detection reads the HOST's
  // cores, so it spends multiples of that window on parallelism a tenth of a
  // core will never deliver.
  const cmd = cloneCommand({ owner: "astropods", repo: "ada" }, "ada");
  expect(cmd).toContain("-c pack.threads=1");
  expect(cmd).toContain("--depth=1");
  expect(cmd).toContain("https://github.com/astropods/ada.git");
  // The thread cap has to precede the subcommand or git ignores it.
  expect(cmd.indexOf("-c pack.threads=1")).toBeLessThan(cmd.indexOf("clone"));
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

test("degrades to `pwd` when the sandbox image predates /workspace", async () => {
  // Exactly the production failure: the control plane redeployed with the
  // /workspace endpoint, the sandbox container did not rebuild, and every
  // session died at startup with a bare `not found`. The two containers deploy
  // together but do not always rebuild together, so the client must degrade.
  const { createServer } = await import("node:http");
  const legacy = createServer((req, res) => {
    if (req.url === "/workspace") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    // Everything else behaves like the deployed (older) service.
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      void fetch(`${baseUrl}${req.url}`, {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
      })
        .then(async (upstream) => {
          const body = await upstream.text();
          res.writeHead(upstream.status, { "Content-Type": "application/json" });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(502).end("{}");
        });
    });
  });
  await new Promise<void>((r) => legacy.listen(0, "127.0.0.1", r));
  const legacyUrl = `http://127.0.0.1:${(legacy.address() as AddressInfo).port}`;

  try {
    const { remote } = await import("../agent/session/remote-sandbox.ts");
    const sandbox = await remote({ baseUrl: legacyUrl }).createSandbox({ id: "inst-legacy" });

    expect(sandbox.cwd.startsWith("/"), "still gets an absolute cwd").toBe(true);
    expect(sandbox.cwd).not.toBe("/");
    expect((await sandbox.exec("true")).exitCode, "and the session works").toBe(0);
    await sandbox.writeFile("ok.txt", "fallback");
    expect(await sandbox.readFile("ok.txt")).toBe("fallback");
  } finally {
    legacy.close();
  }
});

test("advertises its capabilities so version skew is visible at startup", async () => {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  expect(health.ok).toBe(true);
  // A control plane can compare this against what it needs, instead of
  // discovering a stale image when a session fails mid-turn.
  expect(health.capabilities, "health lists the routes this image serves").toContain("/workspace");
  expect(health.capabilities).toContain("/exec");
});

/* ---------------- confinement of the SHELL between conversations ---------------- */

/**
 * `resolveIn` contains the FILE endpoints. It cannot contain `/exec`.
 *
 * A path argument can be checked; a shell command cannot, because it is a
 * program rather than an argument, and `cat /data/<other-instance>/secret` is a
 * perfectly valid one. So the shell used to be a hole straight through the
 * containment the rest of the service enforces: one conversation could read
 * another's checkout, and list the workspace root to find it. The isolation the
 * file endpoints assert above was real; the isolation the module's own comments
 * claimed for `bash` was not.
 *
 * The fix stops relying on a check and lets the kernel do it — a uid per
 * instance, workspaces chmod 0700, commands spawned as that uid — which needs
 * the service to be root. Two tests, because neither alone is enough:
 *
 *   - The ALWAYS-ON one asserts the service's REPORT MATCHES REALITY, in
 *     whichever mode it is in. That is the specific failure being corrected:
 *     not "the shell is unconfined" but "the shell is unconfined while the code
 *     says otherwise". It cannot pass while /health lies in either direction.
 *   - The OPT-IN one asserts the real denial against the shipped image, as
 *     root, in a container. It needs Docker, so it is opt-in rather than
 *     silently skipped — a conditional that hides a genuine breakage is worse
 *     than no test (same reasoning as the Postgres case in persistence.spec.ts).
 *
 *       ADA_TEST_CONFINEMENT=1 npx playwright test test/remote-sandbox.spec.ts
 */

test("reports its confinement mode honestly, whichever mode it is in", async () => {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  expect(["per-instance-uid", "none"], "health must state a known mode").toContain(
    health.confinement,
  );

  // Instance A stores something only it should see.
  const a = driverFor("inst-confine-a");
  await a.writeFile("secret.txt", "A's private repo content");
  const wsA = await a.workspacePath();

  // The file endpoints refuse regardless of mode — that is `resolveIn`, and it
  // is not what is under test here.
  const b = driverFor("inst-confine-b");
  await expect(b.readFile(`${wsA}/secret.txt`)).rejects.toThrow(/escapes the workspace/);

  // The shell is what the mode describes, so hold the mode to it.
  const viaShell = await b.exec(`cat ${wsA}/secret.txt`);
  if (health.confinement === "per-instance-uid") {
    expect(viaShell.exitCode, "confined: the kernel must refuse it").not.toBe(0);
    expect(viaShell.stdout).not.toContain("private repo content");
  } else {
    // Unconfined (this suite does not run as root). Asserted, not glossed: the
    // guarantee genuinely is weaker here, and /health has to be saying so.
    expect(viaShell.stdout, "unconfined: the shell can cross, as /health admits").toContain(
      "private repo content",
    );
  }
});

const CONFINEMENT = process.env.ADA_TEST_CONFINEMENT === "1";

test.describe("the shipped image, running as root", () => {
  test.skip(!CONFINEMENT, "set ADA_TEST_CONFINEMENT=1 to run (needs Docker; see the note above)");
  test.describe.configure({ timeout: 300_000 });

  const TAG = "ada-sandbox:confinement-test";
  const NAME = "ada-sandbox-confinement-test";
  let url: string;

  test.beforeAll(async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const run = promisify(execFile);
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

    await run("docker", ["build", "-q", "-f", "sandbox/Dockerfile", "-t", TAG, "."], {
      cwd: repoRoot,
      maxBuffer: 1e8,
    });
    await run("docker", ["rm", "-f", NAME]).catch(() => {});
    const { stdout } = await run("docker", [
      "run", "-d", "--name", NAME, "-p", "0:3000", TAG,
    ]);
    const { stdout: port } = await run("docker", [
      "port", stdout.trim().slice(0, 12), "3000/tcp",
    ]);
    url = `http://127.0.0.1:${port.trim().split(":").pop()}`;

    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
        return;
      } catch {
        if (Date.now() > deadline) throw new Error("sandbox container did not start");
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  test.afterAll(async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("docker", ["rm", "-f", NAME]).catch(() => {});
  });

  const call = async (path: string, body: unknown): Promise<Record<string, string>> => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, string>;
  };

  test("a shell in one conversation cannot read another's workspace", async () => {
    expect(
      ((await (await fetch(`${url}/health`)).json()) as { confinement: string }).confinement,
      "the image must run as root and confine",
    ).toBe("per-instance-uid");

    await call("/write", { id: "victim", path: "secret.txt", content: "private repo content" });
    const wsVictim = (await call("/workspace", { id: "victim" })).path;

    // THE assertion: by ABSOLUTE path, from another instance's shell.
    const read = await call("/exec", { id: "attacker", command: `cat ${wsVictim}/secret.txt` });
    expect(read.stdout).not.toContain("private repo content");
    expect(read.exitCode).not.toBe(0);
    expect(read.stderr).toMatch(/permission denied/i);

    // Enumerating siblings is refused too — that is the step before reading one.
    const list = await call("/exec", { id: "attacker", command: "ls /data" });
    expect(list.stdout).not.toContain("victim");
    expect(list.stderr).toMatch(/permission denied/i);

    // Each conversation gets its own uid, which is what the kernel enforces on.
    const idA = (await call("/exec", { id: "victim", command: "id -u" })).stdout.trim();
    const idB = (await call("/exec", { id: "attacker", command: "id -u" })).stdout.trim();
    expect(idA).not.toBe(idB);

    // And confinement must not cost a conversation access to its OWN workspace.
    const own = await call("/exec", {
      id: "victim",
      command: "cat secret.txt && echo ok > mine.txt && cat mine.txt",
    });
    expect(own.exitCode).toBe(0);
    expect(own.stdout).toContain("private repo content");
    expect(own.stdout).toContain("ok");
  });

  test("the toolchain still works after dropping privileges", async () => {
    // The risk of a synthetic uid is tools that call getpwuid() and fail. Real
    // work has to keep working, or the isolation is bought with a broken agent.
    const git = await call("/exec", {
      id: "tool",
      command:
        "git init -q r && cd r && git config user.email t@t.t && git config user.name t && " +
        "echo hi > a.txt && git add -A && git commit -qm init && git log --oneline -1",
    });
    expect(git.exitCode, `git failed: ${git.stderr}`).toBe(0);

    const writable = await call("/exec", {
      id: "tool",
      command: 'test -w "$HOME" && test -w "$npm_config_cache" && test -w "$TMPDIR" && echo yes',
    });
    expect(writable.stdout.trim(), "HOME and caches must be writable by the confined uid").toBe("yes");

    // Caches are per-instance: a shared mutable cache would be a channel
    // between conversations that survived the uid split.
    const cache = await call("/exec", { id: "tool", command: 'echo "$npm_config_cache"' });
    expect(cache.stdout.trim()).toContain("/data/tool/");
  });
});
