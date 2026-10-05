/**
 * Signed links for the chat-driven GitHub flows: a per-user "connect" link and
 * an operator "setup" link (App provisioning). Both are minted in the messaging
 * adapter after the relevant chat-side check (DM-only; setup also admin-only)
 * and clicked in a browser to complete the OAuth / App-Manifest round-trip.
 *
 * The browser frontend keys a user's GitHub token by the `bridge_uid` cookie.
 * Messaging users have no such cookie — the sidecar identifies them by
 * StreamOptions.userId instead. So a Slack user must connect GitHub under THAT
 * identity: the adapter hands them a link that carries their userId, signed so
 * it can't be forged to bind someone else's identity.
 *
 * The link points at the normal /auth/github/login with a `link` param; the
 * server verifies it and runs the same OAuth flow, but stores the resulting
 * token under the carried userId (see index.ts githubLogin). Signing uses an
 * auto-generated server secret persisted in the Store (no operator config),
 * with node:crypto to stay dependency-free.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store.ts";
import { resolveBaseUrl } from "./base-url.ts";

const SECRET_NS = "server";
const SECRET_KEY = "hmac_secret";
const LINK_TTL_MS = 10 * 60 * 1000;

/** What a signed link authorizes: a per-user connect, or operator App setup. */
export type LinkKind = "connect" | "setup" | "watch";

/**
 * A watch link outlives a chat link because it is followed WHILE a turn runs,
 * and a turn can take a long time. Still bounded: it is a bearer token.
 */
export const WATCH_TTL_MS = 2 * 60 * 60 * 1000;

let cachedSecret: string | null = null;

/**
 * Load the server HMAC secret, generating and persisting one on first use.
 * Call once at boot so the secret is stable before any link is minted.
 */
export async function getServerSecret(store: Store): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const existing = (await store.kvGet(SECRET_NS, SECRET_KEY)) as string | null;
  if (existing) {
    cachedSecret = existing;
    return existing;
  }
  const secret = randomBytes(32).toString("hex");
  await store.kvPut(SECRET_NS, SECRET_KEY, secret);
  cachedSecret = secret;
  return secret;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Mint a signed, time-limited link token of a given kind, binding a userId.
 *
 * `ttlMs` overrides the default lifetime. The OAuth `state` uses a longer one
 * than a chat link: that round-trip includes GitHub's install + repo-picker
 * screens, which a user can easily sit on for more than ten minutes.
 */
export function mintLink(
  kind: LinkKind,
  userId: string,
  secret: string,
  ttlMs = LINK_TTL_MS,
  sessionId?: string,
): string {
  const claims = { k: kind, u: userId, e: Date.now() + ttlMs, ...(sessionId ? { s: sessionId } : {}) };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

/**
 * Verify a link token: checks the HMAC, the expiry, AND that it was minted for
 * the expected kind — so a `connect` link can't be replayed at the `setup`
 * endpoint (which would let any user provision the App) or vice versa. Returns
 * the bound userId, or null.
 */
export interface LinkClaims {
  userId: string;
  /** Present on a link scoped to one conversation, e.g. a watch link. */
  sessionId?: string;
}

/** As `verifyLink`, but also returns what the token was scoped to. */
export function verifyLinkClaims(
  token: string | null | undefined,
  kind: LinkKind,
  secret: string,
): LinkClaims | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  if (!safeEqual(mac, expected)) return null;
  try {
    const { k, u, e, s } = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { k?: string; u?: string; e?: number; s?: string };
    if (k !== kind || typeof u !== "string" || typeof e !== "number" || e <= Date.now()) return null;
    return { userId: u, sessionId: typeof s === "string" ? s : undefined };
  } catch {
    return null;
  }
}

export function verifyLink(token: string | null | undefined, kind: LinkKind, secret: string): string | null {
  return verifyLinkClaims(token, kind, secret)?.userId ?? null;
}

/**
 * Link a messaging user clicks to connect their own GitHub account.
 *
 * Usually minted from chat, where there is no HTTP request to derive an origin
 * from — so this relies on `PUBLIC_BASE_URL` / `ASTRO_EXTERNAL_AGENT_URL` being
 * set, which is the case in any deployment that has Slack attached. `baseUrl`
 * is accepted for the browser-initiated path. See auth/base-url.ts.
 */
export function buildConnectUrl(userId: string, secret: string, baseUrl?: string): string {
  const base = baseUrl ?? resolveBaseUrl();
  return `${base}/auth/github/login?link=${encodeURIComponent(mintLink("connect", userId, secret))}`;
}

/**
 * Link a chat user follows to watch their own turn run, read-only.
 *
 * Scoped to ONE conversation as well as the user, so a leaked link exposes the
 * conversation it was minted for and nothing else the user owns.
 */
export function buildWatchUrl(
  userId: string,
  sessionId: string,
  secret: string,
  baseUrl?: string,
): string {
  const base = baseUrl ?? resolveBaseUrl();
  const token = mintLink("watch", userId, secret, WATCH_TTL_MS, sessionId);
  return `${base}/watch?link=${encodeURIComponent(token)}`;
}
