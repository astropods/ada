/**
 * Remote sandbox — the control-plane side of the split.
 *
 * Implements Flue's `SandboxDriver` against the execution container in
 * `sandbox/`, so the model's filesystem and shell operations happen in a
 * process that holds none of this one's secrets.
 *
 * The whole integration is these nine methods. That is the payoff of Flue's
 * abstraction: the agent loop, the built-in file/shell tools, the security
 * gates, the reviewer subagent, and `AGENTS.md` discovery all talk to the
 * `Sandbox` interface and neither know nor care that execution is now a network
 * hop away. The previous split needed a bespoke protocol, an SSE stream of raw
 * stream-json, and a client mirroring the agent-session class.
 *
 * SELECTION is by injection: the platform sets `KNOWLEDGE_SANDBOX_HOST` when a
 * `knowledge.sandbox` container is deployed. Present means remote, absent means
 * `local()` in-process — so `node agent/index.ts` and `flue run` keep working
 * with no configuration, and a deployment gets isolation without a code change.
 */

import { sandboxFromDriver } from "@flue/runtime";
import type { FileStat, Sandbox, SandboxDriver, SandboxFactory, ShellResult } from "@flue/runtime";
import { cloneCommand } from "./repo.ts";

/** Where the platform injects the sandbox container's address. */
export function sandboxHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = env.KNOWLEDGE_SANDBOX_HOST;
  if (!host) return null;
  return `http://${host}:${env.KNOWLEDGE_SANDBOX_PORT ?? 3000}`;
}

export function sandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return sandboxHost(env) !== null;
}

export interface RemoteSandboxOptions {
  /** Base URL of the sandbox service. */
  baseUrl: string;
  /** Instance id — scopes every path to one conversation's workspace. */
  id: string;
  /**
   * Env layered onto every command. Holds the user's GH_TOKEN when connected.
   * Sent PER REQUEST and never persisted by the service, so the credential
   * lives no longer than the command that needs it.
   */
  env?: Record<string, string | undefined>;
  /** Shared secret, when the deployment configures one on both sides. */
  token?: string;
  fetchImpl?: typeof fetch;
}

class RemoteSandboxDriver implements SandboxDriver {
  private readonly opts: RemoteSandboxOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteSandboxOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.token) headers["x-sandbox-token"] = this.opts.token;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: this.opts.id, ...body }),
        signal,
      });
    } catch (e) {
      // Distinguish "the sandbox is unreachable" from "the operation failed".
      // The first is an outage the operator must see; the second is ordinary.
      throw new Error(`sandbox unreachable at ${this.opts.baseUrl}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`sandbox returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `sandbox error ${res.status}`);
    return parsed as T;
  }

  async exec(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ShellResult> {
    return this.call<ShellResult>(
      "/exec",
      {
        command,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        // Session env first so a per-call value can override it.
        env: { ...stripUndefined(this.opts.env ?? {}), ...(options.env ?? {}) },
      },
      options.signal,
    );
  }

  async readFile(path: string): Promise<string> {
    return (await this.call<{ content: string }>("/read", { path })).content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const { base64 } = await this.call<{ base64: string }>("/read-buffer", { path });
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.call("/write",
      typeof content === "string"
        ? { path, content }
        : { path, base64: Buffer.from(content).toString("base64") },
    );
  }

  async stat(path: string): Promise<FileStat> {
    const s = await this.call<{
      isFile: boolean; isDirectory: boolean; isSymbolicLink?: boolean; size?: number; mtime?: string;
    }>("/stat", { path });
    return { ...s, mtime: s.mtime ? new Date(s.mtime) : undefined };
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.call<{ entries: string[] }>("/readdir", { path })).entries;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.call<{ exists: boolean }>("/exists", { path })).exists;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.call("/mkdir", { path, recursive: options.recursive ?? true });
  }

  async rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.call("/rm", { path, ...options });
  }

  /**
   * The instance's workspace as an absolute path inside the sandbox container.
   *
   * Falls back to asking the shell when the service predates `/workspace`.
   *
   * The two containers are deployed together but do NOT necessarily rebuild
   * together: a redeploy that rebuilt only the control plane left a sandbox
   * image without this endpoint, and every session died at startup with a bare
   * `not found`. Version skew between them is a permanent hazard, so the client
   * degrades instead of failing — `/exec` with no `cwd` already runs in the
   * workspace root, so `pwd` yields the same path on any version of the
   * service. The warning is loud because a stale image will bite again
   * differently.
   */
  async workspacePath(): Promise<string> {
    try {
      return (await this.call<{ path: string }>("/workspace", {})).path;
    } catch (e) {
      if (!/not found/i.test((e as Error).message)) throw e;
      const probe = await this.exec("pwd");
      const path = probe.stdout.trim();
      if (probe.exitCode !== 0 || !path.startsWith("/")) {
        throw new Error(
          `sandbox at ${this.opts.baseUrl} has no /workspace endpoint and \`pwd\` did not return an ` +
            `absolute path (exit ${probe.exitCode}). The sandbox image is likely stale — rebuild it.`,
        );
      }
      console.warn(
        `[sandbox] ${this.opts.baseUrl} predates the /workspace endpoint — falling back to \`pwd\`. ` +
          `The sandbox image is out of date relative to the control plane; rebuild it.`,
      );
      return path;
    }
  }
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v != null)) as Record<string, string>;
}

/** A driver for one instance — also used directly by the runner to clone repos. */
export function remoteSandboxDriver(opts: RemoteSandboxOptions): SandboxDriver & {
  workspacePath(): Promise<string>;
} {
  return new RemoteSandboxDriver(opts);
}

/**
 * A `SandboxFactory` backed by the execution container, for `useSandbox()`.
 *
 * `subdir` names a directory inside the instance's workspace (a repo checkout);
 * omit it to sit at the workspace root.
 *
 * The cwd handed to `sandboxFromDriver` MUST be absolute. Flue resolves every
 * tool path against it with `p.startsWith("/") ? p : cwd + "/" + p`, so a
 * relative cwd makes `resolvePath(".")` normalise to `/` — and then every
 * `bash`, `read`, `grep`, and `glob` call arrives at the service as `/` and is
 * rejected as escaping the workspace. That shipped, and it made a session
 * completely unable to touch its own checkout. Hence the round-trip to ask the
 * container where the workspace actually is, rather than guessing a layout the
 * control plane cannot see.
 */
export function remote(
  opts: Omit<RemoteSandboxOptions, "id"> & { subdir?: string },
): SandboxFactory {
  return {
    async createSandbox({ id }): Promise<Sandbox> {
      const driver = remoteSandboxDriver({ ...opts, id });
      const base = await driver.workspacePath();
      const cwd = opts.subdir ? `${base}/${opts.subdir}` : base;
      // Make sure the working directory exists before the first tool call, so
      // a fresh conversation doesn't fail its first `ls`.
      await driver.mkdir(cwd, { recursive: true });
      return sandboxFromDriver(driver, cwd, {
        onOrphanSettled: (s) =>
          console.warn(`[sandbox] orphaned command settled after abort: ${s.command.slice(0, 120)}`),
      });
    },
  };
}

/**
 * Ensure a repository is checked out inside the sandbox, and return its path
 * relative to the instance workspace.
 *
 * Mirrors `session/repo.ts` — clone once, reuse across turns, never reset (work
 * in progress is preserved) — but runs `git` through the driver so the checkout
 * lands in the isolated container rather than the control plane. The token is
 * passed as per-command env, so it exists in that container only for the
 * duration of the clone.
 *
 * `owner` and `repo` reach the shell here, so they MUST already have been
 * through `parseRepoSpec`, whose pattern excludes every shell metacharacter.
 */
export async function ensureRepoInSandbox(
  driver: SandboxDriver,
  spec: { owner: string; repo: string },
  opts: { githubToken?: string } = {},
): Promise<{ dir: string; cloned: boolean }> {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(spec.owner) || !/^[A-Za-z0-9][\w.-]*$/.test(spec.repo)) {
    throw new Error(`refusing to clone an unvalidated repo spec: ${spec.owner}/${spec.repo}`);
  }
  const dir = spec.repo;
  if (await driver.exists(`${dir}/.git`)) return { dir, cloned: false };

  const env: Record<string, string> = opts.githubToken
    ? { GH_TOKEN: opts.githubToken, GITHUB_TOKEN: opts.githubToken }
    : {};
  const result = await driver.exec(cloneCommand(spec, dir), { env, timeoutMs: 10 * 60 * 1000 });
  if (result.exitCode !== 0) {
    throw new Error(`clone failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return { dir, cloned: true };
}
