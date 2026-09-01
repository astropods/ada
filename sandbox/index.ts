/**
 * Execution sandbox — the isolated side of the split.
 *
 * This container runs the agent's filesystem and shell operations. It holds
 * NONE of the control plane's secrets: no database credentials, no GitHub App
 * client secret, no HMAC signing key, no other user's data. It receives, per
 * request, only what one operation needs — and a GitHub token only for the
 * duration of the command that uses it. So a rogue `bash` the model runs
 * reaches at most one conversation's checkout, in a process that has nothing
 * else worth stealing.
 *
 * ── What changed in the Flue rewrite ─────────────────────────────────────
 *
 * The previous version of this service was a Claude Code runner: it accepted a
 * prompt, spawned `claude -p`, and streamed raw stream-json back over SSE. It
 * had to know about models, credentials, resume ids, and tool policy, and it
 * shared source with the control plane to do it.
 *
 * It is now a dumb filesystem-and-shell server implementing exactly Flue's
 * `SandboxDriver` interface — nine operations, no agent concepts at all. The
 * agent loop runs in the control plane; only the side effects happen here. That
 * is a much smaller thing to secure and a much smaller thing to get wrong, and
 * it means the model credential never reaches this container.
 *
 * Endpoints mirror the driver one-to-one:
 *   GET  /health
 *   POST /workspace   {id}                                     -> {path}   (absolute)
 *   POST /exec        {id, command, cwd?, env?, timeoutMs?}  -> {stdout, stderr, exitCode}
 *   POST /read        {id, path}                             -> {content}        (utf8)
 *   POST /read-buffer {id, path}                             -> {base64}
 *   POST /write       {id, path, content|base64}             -> {ok}
 *   POST /stat        {id, path}                             -> FileStat
 *   POST /readdir     {id, path}                             -> {entries}
 *   POST /exists      {id, path}                             -> {exists}
 *   POST /mkdir       {id, path, recursive?}                 -> {ok}
 *   POST /rm          {id, path, recursive?, force?}         -> {ok}
 *
 * `id` is the Flue agent instance id. Every path is resolved inside that
 * instance's own directory under WORKSPACE_ROOT and REJECTED if it escapes —
 * one conversation cannot read another's checkout even by asking nicely.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(process.env.WORKSPACE_ROOT ?? "/data");
/**
 * Optional shared secret. When set here it MUST be presented by the caller.
 * Unset means the service trusts its network, which is only acceptable because
 * the platform does not route to a knowledge container from outside the
 * deployment — it is checked at startup and warned about loudly.
 */
const TOKEN = process.env.SANDBOX_TOKEN ?? "";
/** Hard ceiling on a single command, independent of what the caller asks for. */
const MAX_TIMEOUT_MS = Number(process.env.SANDBOX_MAX_TIMEOUT_MS ?? 15 * 60 * 1000);
/** Cap on a single request body, so a 200MB JSON write can't exhaust memory. */
const MAX_BUFFER = Number(process.env.SANDBOX_MAX_BUFFER ?? 16 * 1024 * 1024);
/**
 * Output retained per stream, per command — a HEAD and a TAIL window, with the
 * middle discarded as it streams past.
 *
 * This container runs builds inside a fixed, small memory budget, and captured
 * output used to be the largest avoidable consumer in it. The previous version
 * asked `execFile` for up to 16MB per stream with the default utf8 encoding,
 * which is a much bigger number than it looks: Node decodes each chunk to a
 * UTF-16 string (2x), joins them (2x again), then `JSON.stringify` escapes the
 * result and `res.end` re-encodes it. Measured, ONE command emitting 16MB of
 * stdout cost +152MB RSS here — and 16MB was the per-stream figure, so stdout
 * plus stderr doubled it.
 *
 * None of it survived the trip. Flue's `bash` tool truncates to the LAST 2000
 * lines or 50KB before the model ever sees it, so ~320x of what we buffered,
 * serialised and sent was discarded on arrival.
 *
 * Both windows are therefore kept far above what any caller can consume, and
 * both ENDS are kept because the two consumers disagree about which one they
 * want: `bash` keeps the tail (`truncateTail`), while `grep` takes the FIRST
 * 100 matching lines. Keeping only one end would silently change which matches
 * a search reports.
 */
const MAX_HEAD_BYTES = Number(process.env.SANDBOX_MAX_HEAD_BYTES ?? 256 * 1024);
const MAX_TAIL_BYTES = Number(process.env.SANDBOX_MAX_TAIL_BYTES ?? 256 * 1024);
/**
 * Largest file `/read` and `/read-buffer` will load.
 *
 * A read is amplified on the way out — bytes, then base64 (1.33x), then a
 * UTF-16 JS string (2x that), then the JSON body. Source files are nowhere near
 * this; build artefacts and vendored bundles are, and one of them was enough to
 * take the container down.
 *
 * Read PER CALL rather than frozen at module load, unlike the caps above. This
 * is the one limit an operator may need to move without rebuilding the image —
 * the container's memory budget is fixed and not ours to raise, so the knob that
 * trades capability against it should be reachable at runtime.
 */
const maxReadFileBytes = (): number =>
  Number(process.env.SANDBOX_MAX_READ_FILE_BYTES ?? 16 * 1024 * 1024);
/**
 * Commands allowed to run at once.
 *
 * The control plane already bounds concurrent RUNS, but one run issues many
 * tool calls and a reviewer delegate issues its own, so nothing bounded how
 * many compilers were resident here simultaneously. With a CPU quota of a
 * tenth of a core, extra parallelism buys no wall-clock anyway — it only
 * multiplies peak memory. Excess commands queue instead of competing.
 *
 * THE TRADE-OFF, because it is not free: this is below MAX_CONCURRENT_RUNS
 * (default 3), so a long build in one conversation can make another
 * conversation's `bash` wait for a slot. That is deliberate — on a fixed 1GiB
 * you can afford one or two real builds, and queuing is a better failure than
 * an OOM kill that takes every conversation down together. But if turns look
 * like they are hanging rather than working, this is the number to raise (to
 * MAX_CONCURRENT_RUNS, so no run can be starved by another) before anything
 * else here. Only `/exec` is gated; file operations are never queued.
 */
const MAX_CONCURRENT_EXEC = Number(process.env.SANDBOX_MAX_CONCURRENT_EXEC ?? 2);
/** Idle workspaces are reclaimed after this long. */
const WORKSPACE_TTL_MS = Number(process.env.SANDBOX_WORKSPACE_TTL_MS ?? 24 * 60 * 60 * 1000);

/**
 * Environment for a spawned command.
 *
 * Deliberately built from nothing rather than from `process.env`. Even though
 * this container is supposed to hold no secrets, "supposed to" is not a
 * security control — an operator adding one env var should not silently hand it
 * to every command the model runs. Callers pass what a command needs.
 */
const BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR",
  "GOMODCACHE", "GOCACHE", "GOFLAGS", "GOMEMLIMIT", "GOMAXPROCS", "GOPATH", "GOTOOLCHAIN",
  "npm_config_cache", "PIP_CACHE_DIR", "BUN_INSTALL_CACHE_DIR",
  // Worker-pool and heap caps for the NON-Go toolchain. The image sets these
  // (see sandbox/Dockerfile); they only reach the compilers and test runners
  // the model spawns if they are forwarded here. `nproc` and `os.cpus()` both
  // report the HOST core count inside a CPU-quota'd container — measured, 12
  // cores visible under a 0.1-core quota — so a test runner or bundler that
  // sizes its pool from either forks a dozen workers that cannot run, and each
  // one costs ~45MB of resident Node before it does any work. That is the
  // memory limit, spent on parallelism the quota forbids.
  "NODE_OPTIONS", "UV_THREADPOOL_SIZE", "MAKEFLAGS", "JOBS", "npm_config_jobs",
  "CARGO_BUILD_JOBS", "VITEST_MAX_THREADS", "VITEST_MIN_THREADS", "VITEST_MAX_FORKS",
  "NX_PARALLEL", "TURBO_CONCURRENCY", "PYTHONDONTWRITEBYTECODE",
] as const;

function baseEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
  for (const k of BASE_ENV_KEYS) if (process.env[k] != null) out[k] = process.env[k];
  return out;
}

/* ---------------------------------------------------------- path safety */

/** The directory belonging to one agent instance. Created on first use. */
function workspaceOf(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new HttpError(400, "invalid instance id");
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a caller-supplied path inside an instance's workspace.
 *
 * THE containment check, and it must be SYMLINK-AWARE.
 *
 * A purely lexical `resolve()` is not enough. It defeats `../` and absolute
 * paths, but not a symlink: the model can `ln -s /etc/passwd link` inside its
 * own workspace, and `<base>/link` passes a string comparison while
 * `fs.readFile` cheerfully follows the link out of the sandbox. The first
 * version of this shipped with exactly that hole.
 *
 * So: resolve lexically, then resolve symlinks on the deepest part of the path
 * that actually exists, and compare THAT against the real base. Walking up to
 * the nearest existing ancestor is what lets a write to a not-yet-created file
 * work while still catching a symlinked parent directory.
 *
 * A path that lands outside is rejected rather than clamped, so a bug surfaces
 * as an error instead of silently touching the wrong file.
 */
function resolveIn(id: string, path: string): string {
  // The workspace itself always exists (workspaceOf creates it), and is
  // realpath'd so a symlinked root — /var -> /private/var on macOS, a mounted
  // /data elsewhere — compares equal to what the OS reports.
  const base = realpathSync(workspaceOf(id));
  const lexical = isAbsolute(path) ? resolve(path) : resolve(base, path);

  let probe = lexical;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break; // reached the filesystem root
    missing.unshift(basename(probe));
    probe = parent;
  }
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  const full = missing.length > 0 ? join(real, ...missing) : real;

  if (full !== base && !full.startsWith(base + sep)) {
    throw new HttpError(403, `path escapes the workspace: ${path}`);
  }
  return full;
}

/* ------------------------------------------------- bounded output capture */

/**
 * Accumulates a child's output into a bounded HEAD window and a bounded TAIL
 * window, discarding the middle as it streams past.
 *
 * Chunks are kept as Buffers and decoded ONCE at the end. Decoding per chunk
 * (what `execFile` does when given an encoding) doubles the cost immediately by
 * going to UTF-16 and then doubles it again on the join.
 *
 * A cut can land mid-codepoint, so each window is decoded independently and a
 * split multi-byte character degrades to U+FFFD at the seam. That only happens
 * in output already being elided, next to a marker saying so.
 */
class BoundedCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private elided = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < MAX_HEAD_BYTES) {
      const take = Math.min(rest.length, MAX_HEAD_BYTES - this.headBytes);
      this.head.push(rest.subarray(0, take));
      this.headBytes += take;
      rest = rest.subarray(take);
      if (rest.length === 0) return;
    }
    this.tail.push(rest);
    this.tailBytes += rest.length;
    // Drop whole chunks off the front while doing so still leaves a full tail
    // window. Bounded by MAX_TAIL_BYTES + one chunk, never by total output.
    while (this.tail.length > 1 && this.tailBytes - this.tail[0].length >= MAX_TAIL_BYTES) {
      const dropped = this.tail.shift() as Buffer;
      this.tailBytes -= dropped.length;
      this.elided += dropped.length;
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    if (this.tail.length === 0) return head;
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (this.elided === 0) return head + tail;
    return `${head}\n[sandbox] ${this.elided} bytes of output elided here to stay inside the sandbox memory budget\n${tail}`;
  }
}

/**
 * FIFO counting semaphore, bounding how many commands run at once.
 *
 * Deliberately a local copy rather than an import: this service shares no
 * source with the control plane and has no dependencies, which is what keeps
 * the process running model-authored commands small enough to reason about.
 */
class Slots {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available -= 1;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    }
  }
}

const execSlots = new Slots(MAX_CONCURRENT_EXEC);

/* -------------------------------------------------------------- plumbing */

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

function str(b: Body, k: string, required = true): string {
  const v = b[k];
  if (typeof v === "string") return v;
  if (required) throw new HttpError(400, `${k} is required`);
  return "";
}

async function readBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // A write of a large file is legitimate; a 200MB JSON body is not.
    if (size > MAX_BUFFER) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/* -------------------------------------------------------------- handlers */

/** What `/exec` answers with — Flue's `ShellResult`, without importing it. */
interface ShellLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Refuse a read too large to hold in this container's budget.
 *
 * Rejecting beats being OOM-killed mid-session, and it beats truncating
 * silently: the model EDITS these files, and a partial read it believes is
 * whole is how a truncated file gets written back. The message names the way
 * out, because the model is the one who has to act on it.
 *
 * A missing file falls through to `readFile`, so ENOENT stays ENOENT rather
 * than becoming a confusing size error.
 */
async function refuseOversizedRead(full: string): Promise<void> {
  const limit = maxReadFileBytes();
  const s = await stat(full).catch(() => null);
  if (s?.isFile() && s.size > limit) {
    throw new HttpError(
      413,
      `file is ${s.size} bytes, above the sandbox read limit of ${limit}; ` +
        `read part of it with \`bash\` (sed -n, head, tail) instead`,
    );
  }
}

const handlers: Record<string, (b: Body) => Promise<unknown>> = {
  /**
   * The instance's workspace as an ABSOLUTE path in this container.
   *
   * The control plane needs it because Flue resolves every tool path against
   * the sandbox `cwd`, and treats that cwd as absolute — a relative one
   * collapses to `/`, which this service then (correctly) rejects as an
   * escape. It also keeps `pwd` inside a `bash` command agreeing with what the
   * file tools see, which a chroot-style remapping of `/` would break.
   */
  async "/workspace"(b) {
    return { path: workspaceOf(str(b, "id")) };
  },

  async "/exec"(b) {
    const id = str(b, "id");
    const command = str(b, "command");
    const base = workspaceOf(id);
    const cwd = b.cwd ? resolveIn(id, str(b, "cwd")) : base;
    const env = { ...baseEnv(), ...((b.env as Record<string, string> | undefined) ?? {}) };
    const timeout = Math.min(Number(b.timeoutMs ?? MAX_TIMEOUT_MS) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);

    return execSlots.run(
      () =>
        new Promise((settle) => {
          // `detached` puts the command in its OWN PROCESS GROUP, which is what
          // makes the timeout able to kill the whole tree.
          //
          // This was a memory leak, not a tidiness point. `execFile`'s timeout
          // signals the direct child — `/bin/sh` — and leaves its descendants
          // orphaned and running. A `bun install` or `tsc` that timed out kept
          // its memory for as long as it felt like, in the container least able
          // to spare it, and the next command started on top of it.
          const child = spawn("/bin/sh", ["-c", command], { cwd, env, detached: true });
          const stdout = new BoundedCapture();
          const stderr = new BoundedCapture();
          let timedOut = false;
          let settled = false;

          const killTree = (): void => {
            try {
              // Negative pid = the whole process group.
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL"); // group already gone
            }
          };
          const timer = setTimeout(() => {
            timedOut = true;
            killTree();
          }, timeout);

          child.stdout?.on("data", (c: Buffer) => stdout.push(c));
          child.stderr?.on("data", (c: Buffer) => stderr.push(c));

          const done = (out: ShellLike): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            settle(out);
          };

          // Spawn itself failed (no /bin/sh, cwd vanished) — report it as the
          // command's own failure rather than a transport error.
          child.on("error", (e: Error) =>
            done({ stdout: stdout.text(), stderr: `[sandbox] ${e.message}`, exitCode: 1 }),
          );
          // `close` rather than `exit`: it fires once the pipes are drained, so
          // no output is dropped on the way out.
          child.on("close", (code: number | null) =>
            done({
              // A non-zero exit is a RESULT, not a transport failure — the model
              // needs to see the stderr of a failed build, not a 500. A signal
              // kill reports 1, as the previous execFile path did.
              stdout: stdout.text(),
              stderr:
                stderr.text() + (timedOut ? `\n[sandbox] command timed out after ${timeout}ms` : ""),
              exitCode: typeof code === "number" ? code : 1,
            }),
          );
        }),
    );
  },

  async "/read"(b) {
    const full = resolveIn(str(b, "id"), str(b, "path"));
    await refuseOversizedRead(full);
    return { content: await readFile(full, "utf8") };
  },

  async "/read-buffer"(b) {
    const full = resolveIn(str(b, "id"), str(b, "path"));
    await refuseOversizedRead(full);
    return { base64: (await readFile(full)).toString("base64") };
  },

  async "/write"(b) {
    const full = resolveIn(str(b, "id"), str(b, "path"));
    await mkdir(join(full, ".."), { recursive: true }); // the FlueFs.writeFile guarantee
    const base64 = b.base64;
    await writeFile(full, typeof base64 === "string" ? Buffer.from(base64, "base64") : str(b, "content", false));
    return { ok: true };
  },

  async "/stat"(b) {
    const s = await stat(resolveIn(str(b, "id"), str(b, "path")));
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      size: s.size,
      mtime: s.mtime.toISOString(),
    };
  },

  async "/readdir"(b) {
    return { entries: await readdir(resolveIn(str(b, "id"), str(b, "path"))) };
  },

  async "/exists"(b) {
    try {
      await stat(resolveIn(str(b, "id"), str(b, "path")));
      return { exists: true };
    } catch {
      return { exists: false };
    }
  },

  async "/mkdir"(b) {
    await mkdir(resolveIn(str(b, "id"), str(b, "path")), { recursive: b.recursive !== false });
    return { ok: true };
  },

  async "/rm"(b) {
    await rm(resolveIn(str(b, "id"), str(b, "path")), {
      recursive: Boolean(b.recursive),
      force: Boolean(b.force),
    });
    return { ok: true };
  },
};

/* ---------------------------------------------------------------- server */

/**
 * Reclaim idle instance workspaces so long-lived deployments don't fill /data.
 *
 * Asynchronous on purpose. The synchronous version blocked the event loop for
 * as long as it took to delete a monorepo checkout tree, and with a CPU quota
 * of a tenth of a core that is long enough to stall every in-flight command and
 * make the service look hung.
 */
async function sweep(): Promise<void> {
  if (!existsSync(ROOT)) return;
  const cutoff = Date.now() - WORKSPACE_TTL_MS;
  let removed = 0;
  for (const name of await readdir(ROOT)) {
    const full = join(ROOT, name);
    try {
      if ((await stat(full)).mtimeMs >= cutoff) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* concurrent delete or permission race — skip */
    }
  }
  if (removed > 0) console.log(`[sandbox] reclaimed ${removed} idle workspace(s)`);
}

export function createSandboxServer() {
  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          // `capabilities` exists so the control plane can detect an image
          // older than itself at startup rather than discovering it when a
          // session fails. The two containers deploy together but do not
          // always rebuild together.
          return json(res, 200, { ok: true, root: ROOT, capabilities: Object.keys(handlers) });
        }
        if (req.method !== "POST") throw new HttpError(405, "method not allowed");
        if (TOKEN && req.headers["x-sandbox-token"] !== TOKEN) throw new HttpError(401, "unauthorized");
        const handler = handlers[(req.url ?? "").split("?")[0]];
        if (!handler) throw new HttpError(404, "not found");
        json(res, 200, await handler(await readBody(req)));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        // The message is the operation's own error (ENOENT, EACCES); it never
        // contains control-plane detail, because this process has none.
        json(res, status, { error: (e as Error).message });
      }
    })();
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

// Only start when run as the container entrypoint, so tests can import the
// factory and bind an ephemeral port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  mkdirSync(ROOT, { recursive: true });
  if (!TOKEN) {
    console.warn(
      "[sandbox] SANDBOX_TOKEN is not set — this service trusts its network. " +
        "That is only safe because the platform does not route to a knowledge container externally.",
    );
  }
  // Also once at boot: a container that restarts more often than the interval
  // otherwise never sweeps, and inherits every checkout it ever made.
  void sweep();
  setInterval(() => void sweep(), 60 * 60 * 1000).unref();
  createSandboxServer().listen(PORT, () => console.log(`[sandbox] listening on ${PORT}, root ${ROOT}`));
}
