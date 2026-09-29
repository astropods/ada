/**
 * Astro sandbox — Flue's `SandboxDriver` over a platform MicroVM, one per
 * conversation. Replaces the container in `sandbox/`.
 *
 * `SandboxClient` covers four of Flue's nine methods; `stat`, `exists`, `mkdir`
 * and `rm` are synthesized with quoted shell utilities, as every Flue provider
 * adapter does.
 *
 * Two platform limits leak through, both worse than the container's:
 *  - reads cap at ~768 KiB (the client reads via `base64` over `exec`, and exec
 *    output is capped at 1 MiB per stream). The container allowed 16 MiB.
 *  - writes chunk at 36 KiB of file per round-trip, so a 25 MB upload is ~712
 *    sequential calls.
 */

import { sandboxFromDriver } from "@flue/runtime";
import type { FileStat, Sandbox, SandboxDriver, SandboxFactory, ShellResult } from "@flue/runtime";
import {
  SandboxClient,
  SandboxNotEnabledError,
  SandboxRequestError,
  SandboxUnavailableError,
} from "@astropods/adapter-core";
import { tokenKind } from "../auth/authz.ts";

/** Fixed by the platform image (`SANDBOX_WORKDIR`), so nothing to ask at startup. */
export const SANDBOX_ROOT = "/workspace";

/** Ceiling on one command, matching the container's `SANDBOX_MAX_TIMEOUT_MS`. */
const MAX_TIMEOUT_MS = Number(process.env.ASTRO_SANDBOX_MAX_TIMEOUT_MS ?? 15 * 60 * 1000);

/**
 * A first attach installs the declaration, which takes minutes, and the edge
 * proxy answers that with a 502 long before the server says "preparing" — which
 * the client only retries for its own 202s. Safe to retry: attach is idempotent
 * per name. Kept under the client's own 900s prepare budget.
 */
const ATTACH_TIMEOUT_MS = Number(process.env.ASTRO_SANDBOX_ATTACH_TIMEOUT_MS ?? 10 * 60 * 1000);
const ATTACH_RETRY_MS = Number(process.env.ASTRO_SANDBOX_ATTACH_RETRY_MS ?? 5_000);

/** The edge gave up on the origin. A 4xx is a real refusal, so it is not retried. */
function isEdgeFailure(e: unknown): boolean {
  return e instanceof SandboxRequestError && [502, 503, 504].includes(e.status);
}

/** Whether the platform (or `ast` locally) gave this process an identity. */
export function astroSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ASTRO_AUTHZ_TOKEN);
}

/**
 * Same name means the same filesystem, so the instance id is the key. Prefixed
 * because names are scoped per deployment, and reduced to the platform's
 * `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` — a Slack thread id need not be in it.
 */
export function sandboxNameFor(instanceId: string): string {
  const safe = instanceId.replace(/[^A-Za-z0-9._:-]/g, "-");
  return `ada-${safe}`.slice(0, 128);
}

/** One per process: it caches per-sandbox credentials by name and renews them. */
let shared: SandboxClient | null = null;
function sharedClient(): SandboxClient {
  shared ??= new SandboxClient();
  return shared;
}

/** Test seam: drop the memoized client so a fake can take its place. */
export function resetSandboxClient(next: SandboxClient | null = null): void {
  shared = next;
}

/** Quote for `/bin/sh -c`. Paths come from the model, so this is load-bearing. */
function sq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v != null)) as Record<string, string>;
}

/**
 * Name the cause and the lever; null for anything unrecognised, so the caller
 * keeps its own message. A cap refusal otherwise reaches the user as
 * `AGENT_ERROR` and the log as "Limit reached", and three caps share that
 * status. The platform sends `usage`/`limit`/`details`, but the client keeps
 * only `error` — so the numbers are unrecoverable here and the token kind,
 * which decides which cap applies, is not.
 */
export function explainSandboxFailure(e: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  // Flue wraps a turn failure, so the useful error is usually a `cause` down.
  for (let link: unknown = e, depth = 0; link && depth < 8; depth++) {
    const explained = explainOne(link, env);
    if (explained) return explained;
    link = (link as { cause?: unknown }).cause;
  }
  return null;
}

function explainOne(e: unknown, env: NodeJS.ProcessEnv): string | null {
  if (e instanceof SandboxNotEnabledError) {
    return (
      "This agent has no execution sandbox: the platform reports none is available for it. " +
      "Check that astropods.yml still declares a `sandbox:` section and that the server has a sandbox image."
    );
  }
  if (e instanceof SandboxUnavailableError) {
    return "Could not reach the platform to start an execution sandbox. The control plane may be unreachable from here.";
  }
  if (!(e instanceof SandboxRequestError)) return null;

  switch (e.status) {
    case 402:
      // Which cap depends on who is attaching, and the response cannot say.
      return tokenKind(env) === "dev"
        ? "Out of execution sandboxes for this local dev session. One conversation holds one sandbox for as " +
            "long as it lives, and a local session is capped well below the account " +
            "(SANDBOX_MAX_PER_DEV_SESSION, 3 by default) so local work cannot take a deployed agent's slots. " +
            "End a conversation, run `ast project stop` to release them all, or ask for the dev-session cap to be raised."
        : "Out of execution sandboxes for this deployment. One conversation holds one sandbox for as long as it " +
            "lives, so concurrent conversations are bounded by SANDBOX_MAX_PER_DEPLOYMENT (20 by default) and by " +
            "the account's sandbox quota. Ask for whichever is binding to be raised.";
    case 401:
    case 403:
      return tokenKind(env) === "dev"
        ? "The platform rejected this agent's sandbox credentials. A local dev session is revoked by " +
            "`ast project stop` and expires on its own, so restart `ast project start` to mint a new one."
        : "The platform rejected this deployment's sandbox credentials.";
    case 404:
      return "The platform has no sandbox by that name, and would not create one.";
    default:
      return e.status >= 500
        ? `The platform failed to start an execution sandbox (HTTP ${e.status}). This is usually transient.`
        : null;
  }
}

export interface AstroSandboxOptions {
  /** Instance id — one sandbox per conversation. */
  id: string;
  /**
   * Layered onto every command; holds GH_TOKEN. Per request, never the
   * declaration's static `env`, so it lives only as long as the command.
   */
  env?: Record<string, string | undefined>;
  client?: SandboxClient;
  /** Exposed for tests, which cannot afford real backoff. */
  attachRetry?: { timeoutMs?: number; delayMs?: number };
}

class AstroSandboxDriver implements SandboxDriver {
  private readonly name: string;
  private readonly client: SandboxClient;
  private readonly env: Record<string, string>;
  private readonly retry: { timeoutMs: number; delayMs: number };
  private attached: Promise<void> | null = null;

  constructor(opts: AstroSandboxOptions) {
    this.name = sandboxNameFor(opts.id);
    this.client = opts.client ?? sharedClient();
    this.env = stripUndefined(opts.env ?? {});
    this.retry = {
      timeoutMs: opts.attachRetry?.timeoutMs ?? ATTACH_TIMEOUT_MS,
      delayMs: opts.attachRetry?.delayMs ?? ATTACH_RETRY_MS,
    };
  }

  /**
   * Memoized on the PROMISE so concurrent first operations wait on one attach
   * rather than each paying the edge timeout. The client attaches implicitly
   * too; doing it here is what puts the retry in the path.
   */
  /** Public face of `ensureAttached`, for a caller that wants to wait up front. */
  async attach(): Promise<void> {
    return this.ensureAttached();
  }

  private async ensureAttached(): Promise<void> {
    this.attached ??= (async () => {
      const deadline = Date.now() + this.retry.timeoutMs;
      for (let attempt = 1; ; attempt++) {
        try {
          await this.client.attach(this.name);
          return;
        } catch (e) {
          if (!isEdgeFailure(e) || Date.now() + this.retry.delayMs >= deadline) {
            const why = explainSandboxFailure(e);
            if (why) console.error(`[sandbox] ${this.name}: ${why}`);
            throw e;
          }
          console.warn(
            `[sandbox] ${this.name}: attach attempt ${attempt} hit a gateway error ` +
              `(${(e as SandboxRequestError).status}) — the declaration is probably still installing; retrying`,
          );
          await new Promise((r) => setTimeout(r, this.retry.delayMs));
        }
      }
    })().catch((e) => {
      // Not sticky: a later turn may find a platform that has since recovered.
      this.attached = null;
      throw e;
    });
    return this.attached;
  }

  /** `/bin/sh -c`, as the container spawned and the client uses — no bash needed. */
  private async sh(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.ensureAttached();
    return this.client.exec(this.name, { command: ["/bin/sh", "-c", script] });
  }

  /**
   * An abort routes through `run()`, the only call taking a signal. Truncation
   * and timeouts are reported IN stderr: `ShellResult` has nowhere for a flag,
   * and a model handed a silent prefix will think that was the whole log.
   */
  async exec(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ShellResult> {
    await this.ensureAttached();
    const timeoutMs = Math.min(Number(options.timeoutMs ?? MAX_TIMEOUT_MS) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // Session env first so a per-call value can override it.
    const env = { ...this.env, ...(options.env ?? {}) };
    const request = { command: ["/bin/sh", "-c", command], cwd: options.cwd, env };

    if (options.signal) {
      const r = await this.client.run(this.name, request, { timeoutMs, signal: options.signal });
      return this.settle(r.stdout, r.stderr, r.exitCode ?? (r.killed ? 124 : 0), {
        timedOut: r.timedOut,
        // Output the sandbox dropped rather than cut: it outran the retention
        // window, so what arrived has a hole in it rather than a missing tail.
        dropped: r.stdoutDropped + r.stderrDropped > 0,
      });
    }

    const r = await this.client.exec(this.name, { ...request, timeoutMs });
    return this.settle(r.stdout, r.stderr, r.exitCode, { timedOut: r.timedOut, truncated: r.truncated });
  }

  private settle(
    stdout: string,
    stderr: string,
    exitCode: number,
    flags: { timedOut?: boolean; truncated?: boolean; dropped?: boolean },
  ): ShellResult {
    const notes: string[] = [];
    if (flags.truncated) notes.push("output was cut at the sandbox's 1MiB-per-stream cap");
    if (flags.dropped) notes.push("some output was dropped: it outran the sandbox's retention window");
    if (flags.timedOut) notes.push("the command was killed at its timeout rather than exiting");
    return {
      stdout,
      stderr: notes.length ? `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}[sandbox] ${notes.join("; ")}` : stderr,
      exitCode,
    };
  }

  // `try`/`await`, not `.catch()`: a synchronous throw returns no promise to
  // attach a handler to, and the error would escape untranslated.
  async readFile(path: string): Promise<string> {
    try {
      await this.ensureAttached();
      return await this.client.readFile(this.name, path);
    } catch (e) {
      throw this.readError(path, e);
    }
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    try {
      await this.ensureAttached();
      return await this.client.readFileBytes(this.name, path);
    } catch (e) {
      throw this.readError(path, e);
    }
  }

  /** The 1 MiB exec cap lands at ~768 KiB of file, low enough that real files hit it. */
  private readError(path: string, e: unknown): Error {
    const msg = (e as Error).message ?? String(e);
    if (!/cap|413/i.test(msg)) return e as Error;
    return new Error(
      `${path} is too large to read whole: the sandbox caps a read at about 768KiB. ` +
        `Read part of it with \`bash\` (sed -n, head, tail) instead. (${msg})`,
    );
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.ensureAttached();
    if (typeof content === "string") return this.client.writeFile(this.name, path, content);
    return this.client.writeFileBytes(this.name, path, content);
  }

  /** One call: `%F` names the type, and reports "symbolic link" undereferenced. */
  async stat(path: string): Promise<FileStat> {
    const r = await this.sh(`stat -c '%F|%s|%Y' -- ${sq(path)}`);
    if (r.exitCode !== 0) throw new Error(`stat ${path}: ${(r.stderr || r.stdout).trim() || "no such path"}`);
    const [kind = "", size = "", mtime = ""] = r.stdout.trim().split("|");
    return {
      isFile: kind === "regular file" || kind === "regular empty file",
      isDirectory: kind === "directory",
      isSymbolicLink: kind === "symbolic link",
      size: Number(size) || 0,
      mtime: new Date(Number(mtime) * 1000),
    };
  }

  async readdir(path: string): Promise<string[]> {
    await this.ensureAttached();
    return (await this.client.listDir(this.name, path)).map((e) => e.name);
  }

  /** `-e` OR `-L`: `-e` alone is false for a broken symlink that is still in the way. */
  async exists(path: string): Promise<boolean> {
    const q = sq(path);
    return (await this.sh(`[ -e ${q} ] || [ -L ${q} ]`)).exitCode === 0;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const r = await this.sh(`mkdir ${options.recursive ? "-p " : ""}-- ${sq(path)}`);
    if (r.exitCode !== 0) throw new Error(`mkdir ${path}: ${(r.stderr || r.stdout).trim()}`);
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const flags = `${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
    const r = await this.sh(`rm ${flags ? `-${flags} ` : ""}-- ${sq(path)}`);
    // `-f` means "missing is fine", which is the whole point of the flag.
    if (r.exitCode !== 0 && !options.force) {
      throw new Error(`rm ${path}: ${(r.stderr || r.stdout).trim()}`);
    }
  }
}

/** Attaches lazily on first use; `attach()` lets a caller wait on it up front. */
export type AstroDriver = SandboxDriver & { attach(): Promise<void> };

/** A driver for one conversation — also used directly by the runner to clone. */
export function astroSandboxDriver(opts: AstroSandboxOptions): AstroDriver {
  return new AstroSandboxDriver(opts);
}

/**
 * `subdir` names a repo checkout inside the workspace; omit for the root. The
 * cwd must be absolute — Flue resolves tool paths against it, and a relative
 * one normalises `.` to `/`.
 */
export function astro(opts: Omit<AstroSandboxOptions, "id"> & { subdir?: string } = {}): SandboxFactory {
  return {
    async createSandbox({ id }): Promise<Sandbox> {
      const driver = astroSandboxDriver({ ...opts, id });
      const cwd = opts.subdir ? `${SANDBOX_ROOT}/${opts.subdir}` : SANDBOX_ROOT;
      // So a fresh conversation does not fail its first `ls`, and this is where
      // the attach (and any first install) is waited out.
      await driver.mkdir(cwd, { recursive: true });
      return sandboxFromDriver(driver, cwd, {
        onOrphanSettled: (s) =>
          console.warn(`[sandbox] orphaned command settled after abort: ${s.command.slice(0, 120)}`),
      });
    },
  };
}
