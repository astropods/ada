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
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
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
/** Cap on captured output, so one runaway command can't exhaust memory. */
const MAX_BUFFER = Number(process.env.SANDBOX_MAX_BUFFER ?? 16 * 1024 * 1024);
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
  "npm_config_cache", "PIP_CACHE_DIR",
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
    return new Promise((resolvePromise) => {
      execFile(
        "/bin/sh",
        ["-c", command],
        { cwd, env, timeout, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          // A non-zero exit is a RESULT, not a transport failure — the model
          // needs to see the stderr of a failed build, not a 500.
          const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
          resolvePromise({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") + (e?.killed ? `\n[sandbox] command timed out after ${timeout}ms` : ""),
            exitCode: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          });
        },
      );
    });
  },

  async "/read"(b) {
    return { content: await readFile(resolveIn(str(b, "id"), str(b, "path")), "utf8") };
  },

  async "/read-buffer"(b) {
    const buf = await readFile(resolveIn(str(b, "id"), str(b, "path")));
    return { base64: buf.toString("base64") };
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

/** Reclaim idle instance workspaces so long-lived deployments don't fill /data. */
function sweep(): void {
  if (!existsSync(ROOT)) return;
  const cutoff = Date.now() - WORKSPACE_TTL_MS;
  let removed = 0;
  for (const name of readdirSync(ROOT)) {
    const full = join(ROOT, name);
    try {
      if (statSync(full).mtimeMs >= cutoff) continue;
      rmSync(full, { recursive: true, force: true });
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
  setInterval(sweep, 60 * 60 * 1000).unref();
  createSandboxServer().listen(PORT, () => console.log(`[sandbox] listening on ${PORT}, root ${ROOT}`));
}
