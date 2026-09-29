import { test, expect } from "@playwright/test";
import type { SandboxClient } from "@astropods/adapter-core";
import {
  astro,
  astroSandboxDriver,
  astroSandboxEnabled,
  sandboxNameFor,
  SANDBOX_ROOT,
} from "../agent/session/astro-sandbox.ts";

/**
 * Flue's `SandboxDriver` over a platform MicroVM.
 *
 * The client covers four of the nine methods; `stat`, `exists`, `mkdir` and
 * `rm` are synthesized from shell utilities, so the sharp edges are the quoting
 * of a model-supplied path and the parsing of `stat` output. Both are tested
 * against a recording fake rather than a live sandbox.
 */

/** The name pattern the control plane enforces. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface Recorded {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

function fakeClient(
  reply: (script: string) => { exitCode?: number; stdout?: string; stderr?: string; truncated?: boolean; timedOut?: boolean } = () => ({}),
) {
  const execs: Recorded[] = [];
  const runs: Recorded[] = [];
  const writes: { path: string; kind: "text" | "bytes"; size: number }[] = [];
  const mkdirs: string[] = [];
  const client = {
    async exec(name: string, req: Recorded) {
      execs.push({ ...req, name });
      const script = req.command[2] ?? "";
      if (/^mkdir /.test(script)) mkdirs.push(script);
      const r = reply(script);
      return {
        exitCode: r.exitCode ?? 0,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        durationMs: 1,
        timedOut: r.timedOut ?? false,
        truncated: r.truncated ?? false,
      };
    },
    async run(name: string, req: Recorded, _opts?: unknown) {
      runs.push({ ...req, name });
      return {
        processId: "p1", command: req.command, state: "exited" as const, exitCode: 0,
        startedAt: "", stdout: "ran", stderr: "", stdoutNext: 0, stderrNext: 0,
        stdoutDropped: 0, stderrDropped: 0, timedOut: false, killed: false,
      };
    },
    async readFile() { return "text"; },
    async readFileBytes() { return new Uint8Array([1, 2, 3]); },
    async writeFile(_n: string, path: string, c: string) { writes.push({ path, kind: "text", size: c.length }); },
    async writeFileBytes(_n: string, path: string, c: Uint8Array) { writes.push({ path, kind: "bytes", size: c.byteLength }); },
    async listDir() { return [{ name: "a.ts", isDirectory: false }, { name: "src", isDirectory: true }]; },
  } as unknown as SandboxClient;
  return { client, execs, runs, writes, mkdirs, script: () => execs.at(-1)?.command[2] ?? "" };
}

const driverWith = (f: ReturnType<typeof fakeClient>) => astroSandboxDriver({ id: "sess_1", client: f.client });

/* ── Selection and naming ──────────────────────────────────────────────── */

test("the sandbox is selected by the identity the platform injects", () => {
  // Same shape as the container's KNOWLEDGE_SANDBOX_HOST check: absent means
  // no sandbox, so `node agent/index.ts` keeps working on Flue's local().
  expect(astroSandboxEnabled({ ASTRO_AUTHZ_TOKEN: "t" } as NodeJS.ProcessEnv)).toBe(true);
  expect(astroSandboxEnabled({} as NodeJS.ProcessEnv)).toBe(false);
});

test("a conversation id becomes a name the control plane accepts", () => {
  // Names are scoped per deployment, hence the prefix.
  expect(sandboxNameFor("sess_c3a4e5d0-83cc-4afc")).toBe("ada-sess_c3a4e5d0-83cc-4afc");
  expect(sandboxNameFor("sess_c3a4e5d0")).toMatch(NAME_RE);

  // A Slack thread id is not guaranteed to be inside the allowed set, and a
  // name the control plane rejects would fail the turn instead of validating.
  const slack = sandboxNameFor("T01ABC/1712345678.123456");
  expect(slack).toMatch(NAME_RE);
  expect(slack).not.toContain("/");

  // 128 is the ceiling, prefix included.
  const long = sandboxNameFor("x".repeat(400));
  expect(long.length).toBe(128);
  expect(long).toMatch(NAME_RE);
});

/* ── exec ──────────────────────────────────────────────────────────────── */

test("a command runs through /bin/sh -c, as the container spawned it", async () => {
  const f = fakeClient();
  await driverWith(f).exec("ls -la", { cwd: "/workspace/ada" });
  expect(f.execs[0].command).toEqual(["/bin/sh", "-c", "ls -la"]);
  expect(f.execs[0].cwd).toBe("/workspace/ada");
});

test("per-call env wins over the session's", async () => {
  const f = fakeClient();
  const driver = astroSandboxDriver({ id: "sess_1", client: f.client, env: { GH_TOKEN: "session", KEEP: "yes" } });
  await driver.exec("git push", { env: { GH_TOKEN: "per-call" } });
  expect(f.execs[0].env).toEqual({ GH_TOKEN: "per-call", KEEP: "yes" });
});

test("an undefined session env value is dropped rather than sent as undefined", async () => {
  const f = fakeClient();
  const driver = astroSandboxDriver({ id: "sess_1", client: f.client, env: { GH_TOKEN: undefined } });
  await driver.exec("git status");
  expect(f.execs[0].env).toEqual({});
});

test("a timeout is capped, not trusted", async () => {
  const f = fakeClient();
  await driverWith(f).exec("sleep 9999", { timeoutMs: 60 * 60 * 1000 });
  expect(f.execs[0].timeoutMs).toBe(15 * 60 * 1000);
});

test("an abortable command routes through run(), the only call that takes a signal", async () => {
  const f = fakeClient();
  const res = await driverWith(f).exec("long build", { signal: new AbortController().signal });
  expect(f.runs).toHaveLength(1);
  expect(f.execs, "exec() cannot carry the signal, so it must not be used").toHaveLength(0);
  expect(res.stdout).toBe("ran");
});

test("truncated and timed-out output says so, because ShellResult has nowhere to put a flag", async () => {
  // A model handed a silent prefix of a build log concludes the build said
  // only that much.
  const f = fakeClient(() => ({ stdout: "first 1MiB", truncated: true, timedOut: true }));
  const res = await driverWith(f).exec("yes");
  expect(res.stdout).toBe("first 1MiB");
  expect(res.stderr).toContain("cut at the sandbox's 1MiB-per-stream cap");
  expect(res.stderr).toContain("killed at its timeout");
});

test("a clean command's stderr is left exactly as it was", async () => {
  const f = fakeClient(() => ({ stderr: "a warning" }));
  expect((await driverWith(f).exec("build")).stderr).toBe("a warning");
});

/* ── The synthesized four ──────────────────────────────────────────────── */

test("stat is parsed from one shell call, types included", async () => {
  const f = fakeClient(() => ({ stdout: "regular file|4096|1700000000\n" }));
  const s = await driverWith(f).stat("/workspace/a.ts");
  expect(f.script()).toBe("stat -c '%F|%s|%Y' -- '/workspace/a.ts'");
  expect(s).toMatchObject({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 4096 });
  expect(s.mtime?.getTime()).toBe(1700000000 * 1000);

  for (const [kind, field] of [["directory", "isDirectory"], ["symbolic link", "isSymbolicLink"], ["regular empty file", "isFile"]] as const) {
    const g = fakeClient(() => ({ stdout: `${kind}|0|1\n` }));
    expect(await driverWith(g).stat("/x"), kind).toMatchObject({ [field]: true });
  }
});

test("stat on a missing path throws, since the contract has no way to say otherwise", async () => {
  const f = fakeClient(() => ({ exitCode: 1, stderr: "cannot statx: No such file" }));
  await expect(driverWith(f).stat("/nope")).rejects.toThrow(/No such file/);
});

test("exists counts a broken symlink as present", async () => {
  const f = fakeClient();
  await driverWith(f).exists("/workspace/link");
  // `-e` alone follows the link and answers false when the target is gone,
  // which would have a caller create something already in the way.
  expect(f.script()).toBe("[ -e '/workspace/link' ] || [ -L '/workspace/link' ]");
  const missing = fakeClient(() => ({ exitCode: 1 }));
  expect(await driverWith(missing).exists("/nope")).toBe(false);
});

test("mkdir passes recursive through, and reports a real failure", async () => {
  const f = fakeClient();
  await driverWith(f).mkdir("/workspace/a/b", { recursive: true });
  expect(f.script()).toBe("mkdir -p -- '/workspace/a/b'");

  const plain = fakeClient();
  await driverWith(plain).mkdir("/workspace/a");
  expect(plain.script()).toBe("mkdir -- '/workspace/a'");

  const failed = fakeClient(() => ({ exitCode: 1, stderr: "File exists" }));
  await expect(driverWith(failed).mkdir("/workspace/a")).rejects.toThrow(/File exists/);
});

test("rm carries its flags, and -f means a missing path is fine", async () => {
  const f = fakeClient();
  await driverWith(f).rm("/workspace/x", { recursive: true, force: true });
  expect(f.script()).toBe("rm -rf -- '/workspace/x'");

  // The whole point of the flag: a failed `rm -f` must not throw.
  const forced = fakeClient(() => ({ exitCode: 1, stderr: "No such file" }));
  await expect(driverWith(forced).rm("/nope", { force: true })).resolves.toBeUndefined();

  const bare = fakeClient(() => ({ exitCode: 1, stderr: "is a directory" }));
  await expect(driverWith(bare).rm("/workspace/d")).rejects.toThrow(/is a directory/);
});

test("a path cannot break out of the quoting", async () => {
  // The path is the one argument here that comes from the model.
  const f = fakeClient();
  await driverWith(f).exists("/workspace/'; rm -rf /; echo '");
  const script = f.script();
  expect(script).toBe(
    "[ -e '/workspace/'\\''; rm -rf /; echo '\\''' ] || [ -L '/workspace/'\\''; rm -rf /; echo '\\''' ]",
  );
  // Every quote the path contributed is escaped, so no bare `;` escapes a word.
  expect(script.split("'\\''").length - 1, "both embedded quotes are neutralised").toBe(4);
});

test("readdir hands back names, not entries", async () => {
  const f = fakeClient();
  expect(await driverWith(f).readdir("/workspace")).toEqual(["a.ts", "src"]);
});

test("writeFile picks the transport by content type", async () => {
  const f = fakeClient();
  const d = driverWith(f);
  await d.writeFile("/workspace/a.txt", "hello");
  await d.writeFile("/workspace/a.bin", new Uint8Array([1, 2, 3, 4]));
  expect(f.writes).toEqual([
    { path: "/workspace/a.txt", kind: "text", size: 5 },
    { path: "/workspace/a.bin", kind: "bytes", size: 4 },
  ]);
});

test("the read cap is reported as something the model can act on", async () => {
  // The client reads via `base64 < path` over exec, so the 1MiB output cap
  // lands at ~768KiB of file — far below the container's 16MiB.
  const f = fakeClient();
  (f.client as unknown as { readFile: () => Promise<string> }).readFile = () => {
    throw new Error("could not read /w/big.json: output hit the sandbox's 1048576-byte cap");
  };
  await expect(driverWith(f).readFile("/w/big.json")).rejects.toThrow(/sed -n, head, tail/);
});

test("an ordinary read error is passed through untouched", async () => {
  const f = fakeClient();
  (f.client as unknown as { readFile: () => Promise<string> }).readFile = () => {
    throw new Error("could not read /w/gone: No such file or directory");
  };
  await expect(driverWith(f).readFile("/w/gone")).rejects.toThrow(/No such file or directory/);
});

/* ── The factory ───────────────────────────────────────────────────────── */

test("the factory roots the sandbox at the checkout when there is one", async () => {
  // Absolute, because Flue resolves every tool path against this cwd and a
  // relative one normalises `.` to `/`.
  const f = fakeClient();
  await astro({ client: f.client, subdir: "ada" }).createSandbox({ id: "sess_1" } as never);
  expect(f.mkdirs, "the cwd exists before the first tool call").toEqual(["mkdir -p -- '/workspace/ada'"]);

  const root = fakeClient();
  await astro({ client: root.client }).createSandbox({ id: "sess_1" } as never);
  expect(root.mkdirs).toEqual([`mkdir -p -- '${SANDBOX_ROOT}'`]);
});

/* ── Which sandbox runs the commands ───────────────────────────────────── */

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

test("selection still follows what the platform injected, when nothing asks otherwise", async () => {
  const { sandboxMode } = await import("../agent/session/sandbox-mode.ts");
  // Unchanged behaviour for every deployment that predates this switch.
  expect(sandboxMode(env({ KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toBe("container");
  expect(sandboxMode(env({}))).toBe("local");
  // An unrecognised value falls through rather than inventing a fourth mode.
  expect(sandboxMode(env({ ADA_SANDBOX: "microvm", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toBe("container");
});

test("`auto` — the value the spec actually defaults to — resolves as injected", async () => {
  const { sandboxMode, describeSandbox } = await import("../agent/session/sandbox-mode.ts");
  // ADA_SANDBOX is declared as an input, so a deployment gets "auto" rather
  // than an unset variable. It has to mean the same thing as unset.
  expect(sandboxMode(env({ ADA_SANDBOX: "auto", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toBe("container");
  expect(sandboxMode(env({ ADA_SANDBOX: "auto" }))).toBe("local");
  // And the log says it was inferred, so `auto` in the config and "container"
  // in the log are visibly the same decision.
  expect(describeSandbox(env({ ADA_SANDBOX: "auto", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toContain("(auto)");
  expect(describeSandbox(env({ ADA_SANDBOX: "astro", ASTRO_AUTHZ_TOKEN: "t" }))).not.toContain("(auto)");
});

test("the platform sandbox is opt-in, so a rollout can be reversed without a revert", async () => {
  const { sandboxMode } = await import("../agent/session/sandbox-mode.ts");
  expect(sandboxMode(env({ ADA_SANDBOX: "astro", ASTRO_AUTHZ_TOKEN: "t" }))).toBe("astro");
  // Set alongside the container, the override wins — that is the whole point.
  expect(sandboxMode(env({ ADA_SANDBOX: "astro", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toBe("astro");
  expect(sandboxMode(env({ ADA_SANDBOX: "container", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toBe("container");
  expect(sandboxMode(env({ ADA_SANDBOX: " ASTRO ", ASTRO_AUTHZ_TOKEN: "t" })), "case and spacing").toBe("astro");
});

test("asking for the platform sandbox without a token does NOT fall back to in-process", async () => {
  const { sandboxMode, describeSandbox } = await import("../agent/session/sandbox-mode.ts");
  // Falling back would run the model's commands in the control plane, holding
  // the database credentials, the App secret and the HMAC key. A
  // misconfiguration must not be able to switch the boundary off — the turn
  // fails on the client's own error instead.
  expect(sandboxMode(env({ ADA_SANDBOX: "astro" }))).toBe("astro");
  expect(describeSandbox(env({ ADA_SANDBOX: "astro" }))).toContain("NO ASTRO_AUTHZ_TOKEN");
});

test("local can be forced, since that is the one downgrade worth making explicit", async () => {
  const { sandboxMode } = await import("../agent/session/sandbox-mode.ts");
  expect(sandboxMode(env({ ADA_SANDBOX: "local", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toBe("local");
});

test("startup names the boundary, in the words an operator needs", async () => {
  const { describeSandbox } = await import("../agent/session/sandbox-mode.ts");
  expect(describeSandbox(env({ ADA_SANDBOX: "astro", ASTRO_AUTHZ_TOKEN: "t" }))).toContain("MicroVM");
  expect(describeSandbox(env({ KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).toContain("container at http://sandbox");
  expect(describeSandbox(env({ ADA_SANDBOX: "container", KNOWLEDGE_SANDBOX_HOST: "sandbox" }))).not.toContain("(auto)");
  expect(describeSandbox(env({})), "local is not a boundary and should not read like one")
    .toContain("not an isolation boundary");
});
