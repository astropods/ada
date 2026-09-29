/**
 * Which sandbox this process executes in — resolved once, read everywhere.
 *
 * Three modes now that the platform has its own:
 *
 *  - `astro`     a platform MicroVM per conversation (session/astro-sandbox.ts)
 *  - `container` the bespoke execution service in `sandbox/`
 *  - `local`     Flue's in-process sandbox, which is the control plane itself
 *
 * SELECTION STAYS BY INJECTION, so `node agent/index.ts` and `flue run` keep
 * working with no configuration: a deployment with the sandbox container gets
 * `container`, anything else gets `local`. `astro` is OPT-IN by `ADA_SANDBOX`
 * while it is being proven, which is what lets a deployment move onto it and
 * back off again without a revert.
 *
 * `ADA_SANDBOX=astro` DOES NOT FALL BACK. A deployment that asks for the
 * platform sandbox and has no identity token fails its turns, loudly, on the
 * client's own error. The alternative — quietly dropping to `local` — would
 * run the model's commands in the control-plane process, holding the database
 * credentials, the GitHub App secret and the HMAC key. A misconfiguration must
 * not be able to turn the isolation boundary off.
 */

import { astroSandboxEnabled } from "./astro-sandbox.ts";
import { sandboxHost } from "./remote-sandbox.ts";

export type SandboxMode = "astro" | "container" | "local";

export function sandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  switch (env.ADA_SANDBOX?.trim().toLowerCase()) {
    case "astro":
      return "astro";
    case "container":
      return "container";
    case "local":
      return "local";
  }
  // Unset, or set to something unrecognised: fall through to what the platform
  // injected, which is how every deployment behaved before this switch existed.
  return sandboxHost(env) ? "container" : "local";
}

/** Redacted summary for startup logging, alongside `describePg`/`describeAuth`. */
export function describeSandbox(env: NodeJS.ProcessEnv = process.env): string {
  const mode = sandboxMode(env);
  if (mode === "astro") {
    return astroSandboxEnabled(env)
      ? "astro (platform MicroVM per conversation)"
      : "astro — NO ASTRO_AUTHZ_TOKEN, so every turn will fail to attach";
  }
  if (mode === "container") return `container at ${sandboxHost(env)}`;
  return "local (in-process; not an isolation boundary)";
}
