/**
 * Model resolution + provider registration — the ISOLATED swap seam.
 *
 * Everything about "which model, which credentials, what does a token cost"
 * lives here. Under Flue the model call happens IN-PROCESS through a pi-ai
 * provider, so this module no longer builds a child-process env for a `claude`
 * CLI — it registers a provider and hands `useModel()` a `provider/model` ref.
 *
 * Three auth modes, in precedence order:
 *   1. ANTHROPIC_BASE_URL  — an explicit OpenAI/Anthropic-compatible gateway.
 *   2. ANTHROPIC_API_KEY   — direct to Anthropic (opts out of the Astro gateway).
 *   3. ASTRO_GATEWAY_URL   — the Astro AI Gateway (Bifrost, Bedrock-backed).
 *
 * NB: never log the resolved secret. `describeAuth()` gives a redacted summary.
 */

import { setProvider } from "@flue/runtime";
import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

/** Provider id for the Astro AI Gateway. Distinct from the built-in `anthropic`. */
export const ASTRO_PROVIDER_ID = "astro-gateway";

export interface ResolvedModel {
  /** Bare model id as configured, e.g. `claude-opus-4-8`. */
  id: string;
  /** Provider the model is served by (`anthropic` or `astro-gateway`). */
  provider: string;
  /** What `useModel()` takes: `provider/<catalog id>`. */
  ref: string;
}

/** Strip a leading `bedrock/` so ANTHROPIC_MODEL accepts either form. */
function bareId(id: string): string {
  return id.startsWith("bedrock/") ? id.slice("bedrock/".length) : id;
}

/**
 * Which model Ada runs. Precedence: explicit ANTHROPIC_MODEL wins, else a sane
 * default. The PROVIDER is derived from the auth mode, not configured
 * separately — a personal ANTHROPIC_API_KEY means Anthropic direct, otherwise
 * the Astro gateway when it's injected.
 *
 * NB the gateway's catalog ids carry a `bedrock/` prefix (see gatewayModels),
 * and Flue resolves a `useModel()` ref against `Model.id` — so the ref must
 * carry it too: `astro-gateway/bedrock/claude-opus-4-8`. Flue splits the
 * specifier on the FIRST slash, so the provider is still `astro-gateway`.
 * ANTHROPIC_MODEL itself stays prefix-agnostic.
 */
export function resolveModel(env: NodeJS.ProcessEnv = process.env): ResolvedModel {
  const id = bareId(env.ANTHROPIC_MODEL ?? "claude-opus-4-8");
  if (gatewayUrl(env)) {
    return { id, provider: ASTRO_PROVIDER_ID, ref: `${ASTRO_PROVIDER_ID}/bedrock/${id}` };
  }
  return { id, provider: "anthropic", ref: `anthropic/${id}` };
}

/**
 * The Astro gateway endpoint, or undefined when we should talk to Anthropic
 * directly. Supplying your own ANTHROPIC_API_KEY OPTS OUT of the gateway; an
 * explicit ANTHROPIC_BASE_URL still wins over both.
 */
function gatewayUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ANTHROPIC_BASE_URL) return env.ANTHROPIC_BASE_URL;
  if (env.ANTHROPIC_API_KEY) return undefined; // personal key → direct
  // Bifrost's `/anthropic` endpoint accepts native Anthropic Messages requests.
  return env.ASTRO_GATEWAY_URL ? `${env.ASTRO_GATEWAY_URL}/anthropic` : undefined;
}

function gatewayToken(env: NodeJS.ProcessEnv): string | undefined {
  // `||` so empty strings fall through to the next credential source.
  return env.ANTHROPIC_AUTH_TOKEN || env.ASTRO_GATEWAY_API_KEY || env.ANTHROPIC_API_KEY || undefined;
}

/**
 * The gateway's model catalog: the built-in Anthropic models re-pointed at the
 * gateway.
 *
 * Bifrost is Bedrock-backed and serves Claude under `bedrock/<short-name>` ids,
 * with the virtual key scoped to those exact names — bare `claude-*` and fully
 * qualified `bedrock/anthropic.claude-*` both 401. `Model.id` is BOTH the wire
 * id and the catalog key Flue resolves a `useModel()` ref against, so the
 * prefix has to live here and in the ref (see resolveModel).
 *
 * Costs carry over from the pi-ai catalog, so usage/cost reporting needs no
 * hand-maintained pricing table (the previous `PRICING` map is gone).
 */
function gatewayModels(baseUrl: string): Model<"anthropic-messages">[] {
  return Object.values(ANTHROPIC_MODELS).map((m) => ({
    ...m,
    provider: ASTRO_PROVIDER_ID,
    baseUrl,
    // The id pi-ai puts on the wire; the catalog is keyed by the bare name.
    id: m.id.startsWith("bedrock/") ? m.id : `bedrock/${m.id}`,
  })) as Model<"anthropic-messages">[];
}

/**
 * The Astro AI Gateway as a pi-ai provider, or null in direct mode (where the
 * built-in `anthropic` provider reads ANTHROPIC_API_KEY itself).
 */
export function gatewayProvider(env: NodeJS.ProcessEnv = process.env): Provider | null {
  const baseUrl = gatewayUrl(env);
  if (!baseUrl) return null;
  const token = gatewayToken(env);
  if (!token) {
    throw new Error(
      "Gateway configured (ANTHROPIC_BASE_URL / ASTRO_GATEWAY_URL) but no non-empty credential — provide ANTHROPIC_AUTH_TOKEN, ASTRO_GATEWAY_API_KEY, or ANTHROPIC_API_KEY.",
    );
  }
  return createProvider<"anthropic-messages">({
    id: ASTRO_PROVIDER_ID,
    name: "Astro AI Gateway",
    baseUrl,
    auth: {
      apiKey: {
        name: "Astro AI Gateway virtual key",
        login: async () => ({ type: "api_key", key: token }),
        // BOTH headers, on purpose.
        //
        // `x-bf-vk` is the one that works: Bifrost reads the virtual key ONLY
        // from there and ignores Authorization/x-api-key (probed — both return
        // "virtual key is required", while a bad x-bf-vk returns "virtual key
        // not found", i.e. it is the header actually read).
        //
        // `Authorization` is there to satisfy a CLIENT-side guard: pi-ai's
        // anthropic-messages API throws "No API key for provider" unless it
        // sees `authorization`, `x-api-key`, or `cf-aig-authorization`.
        // Bifrost ignores it. (The old Claude Code path did the same thing by
        // a different route: ANTHROPIC_AUTH_TOKEN for the Bearer header, plus
        // ANTHROPIC_CUSTOM_HEADERS for x-bf-vk.)
        //
        // Deliberately NOT `auth.apiKey`, which pi-ai would send as
        // `x-api-key` — harmless, but misleading about what authenticates.
        resolve: async () => ({
          auth: { headers: { "x-bf-vk": token, Authorization: `Bearer ${token}` } },
          source: "ASTRO_GATEWAY_API_KEY",
        }),
      },
    },
    models: gatewayModels(baseUrl),
    api: anthropicMessagesApi(),
  }) as Provider;
}

/**
 * Register the gateway provider on the AMBIENT registry — the path a
 * Flue-built server entry takes, where `flue.config.ts`'s `providers: ['anthropic']`
 * has already registered the built-in. Idempotent, so it is safe to call from
 * module scope in a process that also calls `start()`.
 */
let gatewayRegistered = false;

export function registerProviders(env: NodeJS.ProcessEnv = process.env): void {
  if (gatewayRegistered) return;
  const provider = gatewayProvider(env);
  if (!provider) return;
  setProvider(provider);
  gatewayRegistered = true;
}

/**
 * The COMPLETE provider set for `start()` (the standalone `node agent/index.ts`
 * entry). `start({ providers })` replaces the registry wholesale rather than
 * adding to it, so the built-in `anthropic` provider must be listed explicitly
 * alongside the gateway — otherwise a direct-mode run finds no provider at all.
 */
export function adaProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const gateway = gatewayProvider(env);
  return gateway ? [anthropicProvider() as Provider, gateway] : [anthropicProvider() as Provider];
}

/** Redacted, log-safe description of the auth situation. Never returns the secret. */
export function describeAuth(env: NodeJS.ProcessEnv = process.env): string {
  const m = resolveModel(env);
  const gateway = gatewayUrl(env);
  if (gateway) {
    const tok = gatewayToken(env);
    return `model=${m.ref} gateway=${gateway} auth=${tok ? `set (****${tok.slice(-4)})` : "MISSING"}`;
  }
  const k = env.ANTHROPIC_API_KEY;
  return `model=${m.ref} apiKey=${k ? `set (${k.length} chars, ****${k.slice(-4)})` : "MISSING"} (direct)`;
}

/* ---------------- sandbox environment ---------------- */

/**
 * Non-secret host vars the SANDBOX genuinely needs, LAYERED ON TOP of Flue's
 * own `DEFAULT_LOCAL_ENV_ALLOWLIST` (PATH/HOME/USER/SHELL/LANG/TMPDIR/…).
 * Everything else in the host env is dropped by `local()`, so a command the
 * model runs — e.g. `bash` → `env` — can't read host secrets (AWS, database,
 * Astro credentials).
 *
 * Unlike the Claude Code era, the MODEL CREDENTIAL is no longer forwarded:
 * Flue calls the provider in-process, so no child needs it.
 */
const SANDBOX_PASSTHROUGH = [
  // networking / TLS — needed by git/gh and package managers behind a proxy
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  // Build-tool config (non-secret paths + limits). Forwarded so the image's
  // baked Go/npm/pip tuning — caches on the /data volume, GOMEMLIMIT/GOMAXPROCS
  // to fit the small container — actually reaches the processes the agent
  // spawns. Without these, builds run unbounded (→ OOM) with ephemeral caches
  // (→ re-download every run).
  "GOMODCACHE", "GOCACHE", "GOFLAGS", "GOMEMLIMIT", "GOMAXPROCS", "GOPATH", "GOTOOLCHAIN",
  "npm_config_cache", "PIP_CACHE_DIR",
] as const;

/**
 * Env for the agent's local sandbox: the allowlisted build/network vars plus,
 * when the user has connected GitHub, their `GH_TOKEN`. A git credential helper
 * baked into the image makes `git`/`gh` act as them.
 */
export function sandboxEnv(
  opts: { githubToken?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of SANDBOX_PASSTHROUGH) if (env[key] != null) out[key] = env[key];
  if (opts.githubToken) {
    out.GH_TOKEN = opts.githubToken;
    out.GITHUB_TOKEN = opts.githubToken;
  }
  return out;
}
