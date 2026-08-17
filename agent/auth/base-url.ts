/**
 * The agent's own public base URL — one source of truth for every URL we hand
 * to a browser or register with GitHub.
 *
 * This matters more than it looks. Three separate places need to agree on it,
 * and if any two disagree the OAuth flow breaks in a way that surfaces as a
 * confusing 404:
 *
 *   - the App manifest's `callback_urls` / `redirect_url` (auth/setup.ts),
 *     registered with GitHub once at App-creation time;
 *   - the `redirect_uri` on the authorize redirect AND on the code exchange
 *     (auth/github-app.ts) — GitHub rejects the exchange if they differ, and
 *     rejects the authorize if it isn't a registered callback URL;
 *   - the connect link handed to a chat user (auth/connect.ts).
 *
 * Previously each of those computed `ASTRO_EXTERNAL_AGENT_URL ?? localhost:$PORT`
 * for itself. That is correct when deployed (the env var is set) but wrong under
 * `ast project start`: the container sets PORT=80, so the manifest registered
 * `http://localhost:80/...` while the frontend is actually mapped to 8080 on the
 * host. GitHub then sent the browser to port 80, where the agent isn't
 * listening — the reported 404.
 *
 * Resolution order:
 *   1. `PUBLIC_BASE_URL`, then `ASTRO_EXTERNAL_AGENT_URL` — explicit config wins.
 *   2. The request's own `Host`, but ONLY for loopback hosts (see below).
 *   3. `http://localhost:${PORT ?? 8080}` — the historical fallback.
 *
 * SECURITY — why `Host` is only trusted for loopback. The Host header is
 * client-controlled, and building an OAuth `redirect_uri` or a signed connect
 * link from it is a known injection vector: an attacker who can make a request
 * with a poisoned Host could get a victim's authorization code delivered to
 * their own origin. Restricting it to `localhost`/`127.0.0.1`/`[::1]` keeps the
 * fix to exactly the case that was broken — a developer's own browser talking
 * to their own machine on a non-default port — and leaves every reachable
 * deployment on explicit config. A developer needing a non-loopback origin
 * (ngrok, a LAN IP) sets `PUBLIC_BASE_URL` and gets the same guarantee.
 */

/** Anything carrying request headers — a `node:http` request or a plain record. */
export interface HeaderBearing {
  headers: Record<string, string | string[] | undefined>;
}

/** Loopback authorities, with an optional port. Nothing else is trusted. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function headerValue(req: HeaderBearing | undefined, name: string): string {
  const v = req?.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * The base URL (scheme + authority, no trailing slash) that a browser should
 * use to reach this agent. Pass the current request where one exists so local
 * runs resolve to the port the browser actually used.
 */
export function resolveBaseUrl(
  req?: HeaderBearing,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PUBLIC_BASE_URL || env.ASTRO_EXTERNAL_AGENT_URL;
  if (configured) return stripTrailingSlash(configured);

  const host = headerValue(req, "host").trim();
  if (host && LOOPBACK_HOST.test(host)) return `http://${host}`;

  return `http://localhost:${env.PORT ?? 8080}`;
}

/** The OAuth callback GitHub redirects to. Must match what the App registered. */
export function callbackPath(baseUrl: string): string {
  return `${stripTrailingSlash(baseUrl)}/auth/github/callback`;
}
