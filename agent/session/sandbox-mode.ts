/**
 * Which sandbox runs the model's commands: `astro` (a platform MicroVM per
 * conversation), `container` (the service in `sandbox/`), or `local` (Flue's
 * in-process sandbox, which is the control plane itself).
 *
 * Unset falls through to what the platform injected, so nothing that predates
 * this switch changes. `astro` is opt-in while it is proven.
 *
 * NEITHER REMOTE MODE FALLS BACK. Dropping to `local` on a misconfiguration
 * would run the model's commands in the control plane, which holds the
 * database credentials, the App secret and the HMAC key.
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
  // `auto` (the declared default), unset, and anything unrecognised: fall
  // through to what the platform injected.
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
  const asked = env.ADA_SANDBOX?.trim().toLowerCase();
  // Mark an inferred mode, so `auto` in the config and this line agree.
  const via = !asked || asked === "auto" ? " (auto)" : "";
  if (mode === "container") return `container at ${sandboxHost(env)}${via}`;
  return `local (in-process; not an isolation boundary)${via}`;
}
