/**
 * Astro sandbox — Flue's `SandboxDriver` over a platform-managed MicroVM.
 *
 * Replaces the bespoke execution service in `sandbox/`: instead of the control
 * plane calling an HTTP container it deployed, the agent attaches a sandbox BY
 * NAME through the control plane and talks to the VM the platform hands back.
 * The direction inverts, which is why no inbound port is needed here.
 *
 * The isolation is the platform's now, and it is strictly stronger than what it
 * replaces: a separate VM with its own kernel per conversation, no inbound
 * network, no platform credential inside, and no route to the agent cluster or
 * to another conversation. The container needed a per-instance uid, a 0700
 * workspace and path confinement to approximate that, and still could not
 * isolate the network at all.
 *
 * SELECTION is by injection, as before, only on a different variable: the
 * platform sets `ASTRO_AUTHZ_TOKEN` (and `ast project start` injects a
 * dev-session token locally). Absent means no sandbox, so `node agent/index.ts`
 * and `flue run` keep working on Flue's in-process `local()`.
 *
 * THE DRIVER IS NOT A PASS-THROUGH. `SandboxClient` covers four of Flue's nine
 * methods; `stat`, `exists`, `mkdir` and `rm` have no equivalent and are
 * synthesized here with quoted shell utilities. That is the same shape every
 * Flue provider adapter takes (see the modal/e2b/daytona adapters), not a
 * shortcut.
 *
 * TWO PLATFORM LIMITS LEAK THROUGH, and callers should know them:
 *
 *  - READS CAP AT ~768 KiB. The client implements `readFile` as `base64 < path`
 *    over `exec`, and exec output is capped at 1 MiB per stream, which base64
 *    reaches at three quarters of that. The container's limit was 16 MiB. A
 *    bigger file has to be read in pieces with `sed -n`/`head`/`tail`, which is
 *    what the error says.
 *
 *  - WRITES ARE CHUNKED AT 36 KiB of file per round-trip, because the client
 *    ships base64 in an argv that Linux caps at 128 KiB. A 25 MB upload is
 *    ~712 sequential `exec` calls. Ada's upload ceilings were sized for a
 *    single HTTP body and want revisiting for this path.
 */

import { sandboxFromDriver } from "@flue/runtime";
import type { FileStat, Sandbox, SandboxDriver, SandboxFactory, ShellResult } from "@flue/runtime";
import { SandboxClient } from "@astropods/adapter-core";

/**
 * The sandbox's working directory.
 *
 * Fixed by the platform image, which sets `SANDBOX_WORKDIR=/workspace` and is
 * the same for every sandbox — so unlike the container, there is nothing to ask
 * at startup. That round-trip existed only because the control plane could not
 * see the container's layout, and it took a version-skew fallback with it.
 */
export const SANDBOX_ROOT = "/workspace";

/** Ceiling on one command, matching the container's `SANDBOX_MAX_TIMEOUT_MS`. */
const MAX_TIMEOUT_MS = Number(process.env.ASTRO_SANDBOX_MAX_TIMEOUT_MS ?? 15 * 60 * 1000);

/** Whether the platform (or `ast` locally) gave this process an identity. */
export function astroSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ASTRO_AUTHZ_TOKEN);
}

/**
 * The sandbox name for a conversation.
 *
 * Same filesystem for the same name, never shared between different ones — so
 * the instance id is exactly the right key, and it is already how every other
 * per-conversation resource here is scoped.
 *
 * Prefixed because names are scoped per deployment rather than per agent, and
 * reduced to the platform's `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`: a Slack
 * thread id is not guaranteed to be within that set, and a name the control
 * plane rejects would fail the turn rather than the validation.
 */
export function sandboxNameFor(instanceId: string): string {
  const safe = instanceId.replace(/[^A-Za-z0-9._:-]/g, "-");
  return `ada-${safe}`.slice(0, 128);
}

/**
 * One client per process, not one per conversation.
 *
 * It holds the identity token and the per-sandbox credentials it renews, and
 * those are keyed by sandbox name inside it — so a second client would just
 * duplicate that cache and the renewals feeding it.
 */
let shared: SandboxClient | null = null;
function sharedClient(): SandboxClient {
  shared ??= new SandboxClient();
  return shared;
}

/** Test seam: drop the memoized client so a fake can take its place. */
export function resetSandboxClient(next: SandboxClient | null = null): void {
  shared = next;
}

/**
 * Single-quote a value for `/bin/sh -c`.
 *
 * Every synthesized command below interpolates a path, and a path is the one
 * argument here that comes from the model. Only an embedded single quote needs
 * work once the whole value is wrapped.
 */
function sq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v != null)) as Record<string, string>;
}

export interface AstroSandboxOptions {
  /** Instance id — one sandbox per conversation. */
  id: string;
  /**
   * Env layered onto every command. Holds the user's GH_TOKEN when connected.
   * Passed per request, never into the declaration's static `env`, so the
   * credential lives no longer than the command needing it.
   */
  env?: Record<string, string | undefined>;
  client?: SandboxClient;
}

class AstroSandboxDriver implements SandboxDriver {
  private readonly name: string;
  private readonly client: SandboxClient;
  private readonly env: Record<string, string>;

  constructor(opts: AstroSandboxOptions) {
    this.name = sandboxNameFor(opts.id);
    this.client = opts.client ?? sharedClient();
    this.env = stripUndefined(opts.env ?? {});
  }

  /**
   * Run a shell snippet for the driver's own use.
   *
   * `/bin/sh -c`, which is both what the container spawned and what the client
   * uses internally — so a command reaching the sandbox is interpreted the same
   * way it always was, and nothing here depends on bash being installed.
   */
  private async sh(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.client.exec(this.name, { command: ["/bin/sh", "-c", script] });
  }

  /**
   * The model's commands.
   *
   * An abort routes through `run()` rather than `exec()`, because only `run()`
   * takes a signal — and Flue does abort a turn mid-command, which is what its
   * orphaned-settlement callback exists to observe.
   *
   * Truncation and a timeout are reported IN the output. Flue's `ShellResult`
   * is `{stdout, stderr, exitCode}` with nowhere to put a flag, and a model
   * handed a silent prefix of a build log will conclude the build said only
   * that much.
   */
  async exec(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ShellResult> {
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

  // `try`/`await` rather than `.catch()` on the call: a callee that throws
  // SYNCHRONOUSLY never gets as far as returning a promise, so a `.catch`
  // chained onto it is never attached and the error escapes untranslated.
  async readFile(path: string): Promise<string> {
    try {
      return await this.client.readFile(this.name, path);
    } catch (e) {
      throw this.readError(path, e);
    }
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    try {
      return await this.client.readFileBytes(this.name, path);
    } catch (e) {
      throw this.readError(path, e);
    }
  }

  /**
   * Make the read cap actionable rather than a bare 413.
   *
   * The client reads through `base64 < path` over `exec`, so the 1 MiB output
   * cap lands at about 768 KiB of file — far under the container's 16 MiB, and
   * low enough that ordinary files hit it. The advice is the same the container
   * gave, because it is still the right advice.
   */
  private readError(path: string, e: unknown): Error {
    const msg = (e as Error).message ?? String(e);
    if (!/cap|413/i.test(msg)) return e as Error;
    return new Error(
      `${path} is too large to read whole: the sandbox caps a read at about 768KiB. ` +
        `Read part of it with \`bash\` (sed -n, head, tail) instead. (${msg})`,
    );
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") return this.client.writeFile(this.name, path, content);
    return this.client.writeFileBytes(this.name, path, content);
  }

  /**
   * `stat`, from the shell, because the client has none.
   *
   * One call rather than three: `%F` names the type, and it reports
   * "symbolic link" for a link because GNU `stat` does not dereference unless
   * asked. Failure means "no such path" to every caller, and Flue's contract
   * has no way to say otherwise, so it throws.
   */
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
    return (await this.client.listDir(this.name, path)).map((e) => e.name);
  }

  /**
   * `-e` OR `-L`, so a broken symlink counts as present.
   *
   * `-e` follows the link and answers false when the target is gone, which
   * would have a caller try to create something that is already in the way.
   */
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

/** A driver for one conversation — also used directly by the runner to clone. */
export function astroSandboxDriver(opts: AstroSandboxOptions): SandboxDriver {
  return new AstroSandboxDriver(opts);
}

/**
 * A `SandboxFactory` backed by a platform MicroVM, for `useSandbox()`.
 *
 * `subdir` names a directory inside the workspace (a repo checkout); omit it to
 * sit at the workspace root. The cwd is absolute because Flue resolves every
 * tool path against it, and a relative one normalises `.` to `/`.
 */
export function astro(opts: Omit<AstroSandboxOptions, "id"> & { subdir?: string } = {}): SandboxFactory {
  return {
    async createSandbox({ id }): Promise<Sandbox> {
      const driver = astroSandboxDriver({ ...opts, id });
      const cwd = opts.subdir ? `${SANDBOX_ROOT}/${opts.subdir}` : SANDBOX_ROOT;
      // So a fresh conversation does not fail its first `ls`. This is also the
      // first call to touch the sandbox, so it is where `attach` happens and
      // where a first install is waited out.
      await driver.mkdir(cwd, { recursive: true });
      return sandboxFromDriver(driver, cwd, {
        onOrphanSettled: (s) =>
          console.warn(`[sandbox] orphaned command settled after abort: ${s.command.slice(0, 120)}`),
      });
    },
  };
}
