/**
 * Execution sandbox — the isolated side of the split.
 *
 * This container runs the agent's filesystem and shell operations. It holds
 * NONE of the control plane's secrets: no database credentials, no GitHub App
 * client secret, no HMAC signing key, no other user's data. It receives, per
 * request, only what one operation needs — and a GitHub token only for the
 * duration of the command that uses it. So a rogue `bash` the model runs finds
 * a process with nothing worth stealing in it.
 *
 * Reaching no FURTHER than its own conversation is a SEPARATE guarantee with a
 * separate mechanism, and this comment used to claim it without one. Two
 * different things enforce it:
 *
 *   - FILE endpoints are contained by `resolveIn`: every caller-supplied path is
 *     resolved inside that instance's directory and rejected otherwise. That is
 *     a check on an argument.
 *   - COMMANDS cannot be contained that way, because a command is a program and
 *     has no argument to check — `cat /data/<other-instance>/secret` is a valid
 *     one. They are confined by the kernel instead: a uid per instance,
 *     workspaces chmod 0700, spawned as that uid. See "command confinement".
 *
 * Command confinement requires this service to run as root (it does in this
 * image — there is no USER line). Where it cannot, /health reports
 * `confinement: "none"` and startup warns, rather than quietly serving a weaker
 * guarantee. The file endpoints stay contained either way.
 *
 * NOT covered: the network. Commands share a network namespace, so this is
 * filesystem isolation between conversations, not a general-purpose sandbox.
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
 * instance's own directory under WORKSPACE_ROOT and REJECTED if it escapes, and
 * commands run under that instance's own uid — so one conversation cannot read
 * another's checkout by asking nicely OR by spelling an absolute path at a
 * shell.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import {
  chmodSync,
  existsSync,
  lchownSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
/**
 * First uid handed to a conversation's commands. Above the system range and
 * above the uids a base image is likely to use, so a sandbox uid never collides
 * with a real account in the container.
 */
const UID_BASE = Number(process.env.SANDBOX_UID_BASE ?? 100000);
/** Records the uid assigned to an instance, so it survives a service restart. */
const UID_MARKER = ".sandbox-uid";
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

/**
 * Redirect everything a confined command needs to write into its OWN workspace.
 *
 * Two things force this. A dropped-privilege command cannot write the paths the
 * image bakes in — HOME is root's, and the caches under `${WORKSPACE_ROOT}/.cache`
 * are root-owned — so without this, confinement would simply break `git`, `bun`
 * and every package manager.
 *
 * The second reason is the better one: a mutable cache SHARED between
 * conversations is itself a channel between them. One conversation poisoning a
 * module cache that another then builds against is exactly the crossing this
 * confinement exists to prevent, and it would have survived the uid split. So
 * per-instance caches are part of the isolation, not a workaround for it.
 *
 * The cost is honest and worth stating: a toolchain or module cache is no longer
 * shared across conversations, so the first build in each pays a download that
 * it previously might not have. Within a conversation — the repeated case, since
 * an instance directory outlives its turns — caching is unchanged.
 *
 * USER/LOGNAME are set because a synthetic uid has no /etc/passwd entry, and
 * tools that want a user name generally consult the environment before
 * getpwuid(). Returns nothing at all when unconfined, so that path keeps the
 * image's shared caches exactly as before.
 */
function confinedEnv(id: string, dir: string): NodeJS.ProcessEnv {
  if (!confineCommands) return {};
  const cache = join(dir, ".cache");
  const tmp = join(dir, ".tmp");
  const paths = {
    HOME: dir,
    TMPDIR: tmp,
    GOMODCACHE: join(cache, "go", "mod"),
    GOCACHE: join(cache, "go", "build"),
    npm_config_cache: join(cache, "npm"),
    PIP_CACHE_DIR: join(cache, "pip"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
  };
  const uid = uidFor(id, dir);
  // Once per instance, not once per command. npm, bun and Go all create their
  // own cache directory, so this is insurance for a tool that expects its
  // configured cache path to already exist rather than something they need.
  if (!scaffolded.has(id)) {
    scaffolded.add(id);
    for (const d of [tmp, ...Object.values(paths).filter((v) => v !== dir && v !== tmp)]) {
      try {
        mkdirSync(d, { recursive: true });
        chownTree(d, uid);
      } catch {
        /* a command reports a write failure far more usefully than we can */
      }
    }
  }
  return { ...paths, USER: `sandbox-${uid}`, LOGNAME: `sandbox-${uid}` };
}

/* -------------------------------------------------- command confinement */

/**
 * OS-level isolation for the SHELL, which `resolveIn` cannot provide.
 *
 * `resolveIn` below confines the FILE endpoints: every path a caller names is
 * resolved inside its own instance directory and rejected if it escapes. That
 * is a check on an argument, and a shell command has no argument to check. It
 * is a program, and `cat /data/<other-instance>/secret` is a perfectly valid
 * one. So `/exec` used to be a hole straight through the containment the rest of
 * this file enforces: one conversation could read another's checkout, and list
 * every sibling instance to find it.
 *
 * The fix is to stop relying on a check and let the kernel do it. Each instance
 * is assigned its own unprivileged uid; its directory is chowned to that uid and
 * chmod 0700; and its commands are spawned AS that uid. A shell in conversation
 * B is then refused by the filesystem when it reaches for A's directory —
 * whatever path it spells, however it spells it, and including through a
 * symlink, because the permission is enforced on the inode rather than on the
 * string.
 *
 * WHAT THIS REQUIRES, and what happens without it: dropping privileges needs the
 * service to be root (it is, in this image — there is no USER line). If it is
 * not, confinement is IMPOSSIBLE rather than merely skipped, so the service says
 * so loudly at startup and reports it in /health instead of quietly serving a
 * weaker guarantee than its documentation claims. That silent-weaker-guarantee
 * is exactly the failure being corrected here.
 *
 * WHAT IT DOES NOT COVER: the network. Commands still share a network namespace,
 * so this is filesystem isolation between conversations, not a full sandbox.
 */
let confineCommands = false;
/** Instance id -> its uid. Populated from disk on demand and at startup. */
const instanceUids = new Map<string, number>();
let nextUid = UID_BASE;
let confinementWarned = false;
/** Instances whose HOME/cache scaffold has been created, so it happens once. */
const scaffolded = new Set<string>();

/** Whether this process can drop privileges at all. */
function canConfine(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Seed uid bookkeeping from the volume, so a restart keeps every instance on the
 * uid that already owns its files. Without this a restart would hand out uids
 * from the base again and a conversation would be locked out of its own
 * workspace.
 */
function loadUidAssignments(): void {
  if (!existsSync(ROOT)) return;
  for (const name of readdirSync(ROOT)) {
    const marker = join(ROOT, name, UID_MARKER);
    if (!existsSync(marker)) continue;
    const uid = Number(readFileSync(marker, "utf8").trim());
    if (!Number.isInteger(uid) || uid < UID_BASE) continue;
    instanceUids.set(name, uid);
    if (uid >= nextUid) nextUid = uid + 1;
  }
}

/**
 * The uid for an instance, allocating one on first use.
 *
 * Allocation is a monotonic counter rather than a hash of the instance id. A
 * hash is stateless and tempting, but two ids colliding would silently give two
 * conversations the same uid — that is, no isolation between them, with nothing
 * to indicate it. A counter seeded from what is already on disk cannot collide.
 */
function uidFor(id: string, dir: string): number {
  const cached = instanceUids.get(id);
  if (cached != null) return cached;
  const marker = join(dir, UID_MARKER);
  if (existsSync(marker)) {
    const existing = Number(readFileSync(marker, "utf8").trim());
    if (Number.isInteger(existing) && existing >= UID_BASE) {
      instanceUids.set(id, existing);
      if (existing >= nextUid) nextUid = existing + 1;
      return existing;
    }
  }
  const uid = nextUid++;
  writeFileSync(marker, `${uid}\n`, { mode: 0o644 });
  instanceUids.set(id, uid);
  return uid;
}

/**
 * Give every existing entry to `uid`.
 *
 * `lchownSync`, NEVER `chownSync`. chown follows symlinks, and this runs as root
 * over a directory tree whose contents the model wrote. A workspace containing a
 * symlink to /etc/shadow would hand that file to the sandbox uid — turning
 * confinement into a privilege escalation. lchown changes the link itself.
 */
function chownTree(path: string, uid: number): void {
  lchownSync(path, uid, uid);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return; // not a directory, or vanished mid-walk
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) lchownSync(full, uid, uid);
    else if (entry.isDirectory()) chownTree(full, uid);
    else lchownSync(full, uid, uid);
  }
}

/**
 * Make `dir` reachable by its instance's uid and by nobody else's.
 *
 * Idempotent and cheap on the common path: it compares the current owner and
 * mode first, so the recursive walk happens once per workspace — on creation, or
 * once when a deployment upgrades into a version that confines (where the tree
 * already exists and is owned by root).
 */
function confineWorkspace(id: string, dir: string): void {
  if (!confineCommands) return;
  const uid = uidFor(id, dir);
  try {
    const st = statSync(dir);
    if (st.uid === uid && (st.mode & 0o777) === 0o700) return;
    chownTree(dir, uid);
    chmodSync(dir, 0o700);
    // The marker stays root-owned and readable so the mapping survives even if
    // the instance's own commands scribble over their directory.
    lchownSync(join(dir, UID_MARKER), 0, 0);
  } catch (e) {
    if (!confinementWarned) {
      confinementWarned = true;
      console.warn(
        `[sandbox] could not confine ${dir}: ${(e as Error).message} — commands for different ` +
          "conversations may be able to read each other's files",
      );
    }
  }
}

/* ---------------------------------------------------------- path safety */

/** The directory belonging to one agent instance. Created on first use. */
function workspaceOf(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new HttpError(400, "invalid instance id");
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  confineWorkspace(id, dir);
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
  const full = resolveSymlinksTolerantly(lexical, path);

  if (full !== base && !full.startsWith(base + sep)) {
    throw new HttpError(403, `path escapes the workspace: ${path}`);
  }
  return full;
}

/** A symlink chain longer than this is a loop, or close enough to one. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Open flags that make the KERNEL re-check the containment decision.
 *
 * `resolveIn` returns a path with every symlink already resolved, so the final
 * component of what we open is never legitimately a link. Saying so to the
 * kernel with O_NOFOLLOW costs nothing and converts a class of bug from an
 * ESCAPE into an `ELOOP` error: if the resolver is ever wrong again — and it has
 * been wrong twice — the write does not happen.
 *
 * It also closes the final-component race. Between resolving a path and opening
 * it, a command running concurrently in the same workspace can replace that
 * component with a symlink; O_NOFOLLOW means the open fails rather than
 * following it. (An intermediate component can still be swapped. Closing that
 * needs `openat2`/`RESOLVE_BENEATH`, which Node does not expose — noted in the
 * README rather than left as an unstated assumption.)
 */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

/**
 * `realpath` for a path whose tail may not exist yet.
 *
 * `realpathSync` cannot be used directly: writing a NEW file is legitimate, and
 * realpath fails on a path that isn't there. The previous approach was to walk
 * up to the deepest EXISTING ancestor, realpath that, and rejoin the missing
 * components lexically — which is correct only if "doesn't exist" and "isn't a
 * symlink" are the same thing. They are not.
 *
 * A DANGLING symlink — one whose target does not exist — is invisible to
 * `existsSync`, because that follows the link and finds nothing. So the link's
 * own name was treated as a missing component and rejoined as text, never
 * dereferenced. `ln -s /etc/cron.d/pwn link` then passed the containment check
 * (the lexical path is inside the workspace) and `/write` followed the link on
 * the way out. That write happens in THIS process, which runs as root so it can
 * confine commands — so the escape bypassed the per-instance uid entirely and
 * could land anywhere in the container. Confirmed reproducible before the fix.
 *
 * This resolves symlinks the way the kernel does: one component at a time,
 * using `lstat` (which does NOT follow) so a dangling link is still seen as a
 * link. When one is found, its target is expanded and the walk RESTARTS over
 * the expansion plus whatever components remained — otherwise a link pointing
 * through another symlinked directory would leave that one unresolved.
 * Components that genuinely do not exist simply accumulate, which is what keeps
 * writing a new file inside the workspace working.
 */
function resolveSymlinksTolerantly(lexical: string, original: string): string {
  let resolved = sep;
  let rest = lexical.split(sep).filter(Boolean);
  let hops = 0;

  while (rest.length > 0) {
    const part = rest.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const candidate = join(resolved, part);
    let link: string | null = null;
    try {
      // lstat, never stat: the whole point is to see a link that points nowhere.
      if (lstatSync(candidate).isSymbolicLink()) link = readlinkSync(candidate);
    } catch {
      link = null; // does not exist at all — a new file, or a new directory
    }
    if (link === null) {
      resolved = candidate;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) {
      throw new HttpError(400, `too many symbolic links: ${original}`);
    }
    // A relative target resolves against the link's own directory, which is the
    // already-resolved prefix. Either way the expansion is absolute, so the walk
    // restarts from the root with the remaining components still queued.
    const target = isAbsolute(link) ? resolve(link) : resolve(resolved, link);
    rest = [...target.split(sep).filter(Boolean), ...rest];
    resolved = sep;
  }
  return resolved;
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
    // Confinement env goes on LAST, after the caller's. A caller has no business
    // redirecting a confined command's HOME or caches back onto shared paths,
    // and letting the request win would make the isolation defeatable by the
    // very thing it isolates.
    const env = {
      ...baseEnv(),
      ...((b.env as Record<string, string> | undefined) ?? {}),
      ...confinedEnv(id, base),
    };
    const timeout = Math.min(Number(b.timeoutMs ?? MAX_TIMEOUT_MS) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const uid = confineCommands ? uidFor(id, base) : undefined;

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
          const child = spawn("/bin/sh", ["-c", command], {
            cwd,
            env,
            detached: true,
            // THE isolation boundary for shell commands. With a per-instance uid
            // and a 0700 workspace, the kernel refuses another conversation's
            // directory however the path is spelled — which a string check on an
            // argument can never do for a program.
            ...(uid != null ? { uid, gid: uid } : {}),
          });
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
    return { content: await readFile(full, { encoding: "utf8", flag: READ_FLAGS }) };
  },

  async "/read-buffer"(b) {
    const full = resolveIn(str(b, "id"), str(b, "path"));
    await refuseOversizedRead(full);
    return { base64: (await readFile(full, { flag: READ_FLAGS })).toString("base64") };
  },

  async "/write"(b) {
    const full = resolveIn(str(b, "id"), str(b, "path"));
    await mkdir(join(full, ".."), { recursive: true }); // the FlueFs.writeFile guarantee
    const base64 = b.base64;
    await writeFile(
      full,
      typeof base64 === "string" ? Buffer.from(base64, "base64") : str(b, "content", false),
      { flag: WRITE_FLAGS },
    );
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
    // A caller removing part of its workspace may have removed the scaffold, so
    // let the next command recreate it rather than assuming it survives.
    scaffolded.delete(str(b, "id"));
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

/**
 * Turn confinement on if this process can, and prepare the volume for it.
 *
 * Exported so a test can enable it explicitly; called by the entrypoint below.
 * Returns whether commands will be confined.
 */
export function initConfinement(): boolean {
  confineCommands = canConfine();
  if (!confineCommands) return false;
  mkdirSync(ROOT, { recursive: true });
  loadUidAssignments();
  try {
    // 0711: traversable but NOT listable. Instance directories are already
    // unreadable to each other, but a readable root let one conversation
    // ENUMERATE every other instance id — the reconnaissance step before
    // reading one. Execute-without-read denies the listing while still letting
    // each command reach its own directory through the path.
    chmodSync(ROOT, 0o711);
  } catch (e) {
    console.warn(`[sandbox] could not restrict ${ROOT}: ${(e as Error).message}`);
  }
  return true;
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
          // `confinement` is reported so an operator can SEE whether commands are
          // isolated from each other, rather than inferring it from the docs.
          // The previous version of this file claimed the isolation it did not
          // have; a claim that cannot be checked is how that survived.
          return json(res, 200, {
            ok: true,
            root: ROOT,
            capabilities: Object.keys(handlers),
            confinement: confineCommands ? "per-instance-uid" : "none",
          });
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
  if (initConfinement()) {
    console.log(
      `[sandbox] commands are confined: one unprivileged uid per instance (from ${UID_BASE}), ` +
        "workspaces chmod 0700",
    );
  } else {
    // Loud, because the documented guarantee does not hold in this mode and the
    // difference is invisible from the outside otherwise.
    console.warn(
      "[sandbox] NOT running as root, so commands CANNOT be confined: a shell in one " +
        "conversation can read another conversation's workspace by absolute path. The file " +
        "endpoints are still contained. Run this service as root to isolate commands.",
    );
  }
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
