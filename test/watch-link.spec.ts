import { test, expect } from "@playwright/test";
import {
  buildWatchUrl,
  mintLink,
  verifyLink,
  verifyLinkClaims,
  WATCH_TTL_MS,
} from "../agent/auth/connect.ts";

/**
 * A link a chat user follows to watch their own turn, read-only. The token is
 * the authority — signed, expiring, and scoped to one conversation — because a
 * Slack user clicking through has no platform identity in the browser.
 */

const SECRET = "test-secret";

test("a watch token names the conversation, not just the user", () => {
  const t = mintLink("watch", "U123", SECRET, WATCH_TTL_MS, "sess_a");
  expect(verifyLinkClaims(t, "watch", SECRET)).toEqual({ userId: "U123", sessionId: "sess_a" });
});

test("a token for one conversation cannot be used for another", () => {
  // Scoping to the session is what makes a leaked link cost one conversation
  // rather than everything that user owns.
  const t = mintLink("watch", "U123", SECRET, WATCH_TTL_MS, "sess_a");
  expect(verifyLinkClaims(t, "watch", SECRET)?.sessionId).not.toBe("sess_b");
});

test("a watch token is not accepted anywhere else, and vice versa", () => {
  // Kind-scoping already protected `connect` from being replayed at `setup`;
  // `watch` inherits it.
  const watch = mintLink("watch", "U123", SECRET, WATCH_TTL_MS, "sess_a");
  expect(verifyLink(watch, "connect", SECRET)).toBeNull();
  expect(verifyLink(watch, "setup", SECRET)).toBeNull();
  const connect = mintLink("connect", "U123", SECRET);
  expect(verifyLinkClaims(connect, "watch", SECRET)).toBeNull();
});

test("a connect token still verifies exactly as it did", () => {
  // The payload gained an optional field; existing links must be unaffected.
  const t = mintLink("connect", "U123", SECRET);
  expect(verifyLink(t, "connect", SECRET)).toBe("U123");
  expect(verifyLinkClaims(t, "connect", SECRET)).toEqual({ userId: "U123", sessionId: undefined });
});

test("a tampered or expired token is refused", () => {
  const t = mintLink("watch", "U123", SECRET, WATCH_TTL_MS, "sess_a");
  expect(verifyLinkClaims(t, "watch", "other-secret"), "signed with another secret").toBeNull();
  expect(verifyLinkClaims(t.slice(0, -2) + "xx", "watch", SECRET), "mangled mac").toBeNull();
  // Swapping the body for one naming a different session breaks the mac.
  const forged = Buffer.from(JSON.stringify({ k: "watch", u: "U123", e: Date.now() + 1000, s: "sess_b" }))
    .toString("base64url");
  expect(verifyLinkClaims(`${forged}.${t.slice(t.lastIndexOf(".") + 1)}`, "watch", SECRET)).toBeNull();
  expect(verifyLinkClaims(mintLink("watch", "U123", SECRET, -1, "sess_a"), "watch", SECRET), "expired").toBeNull();
});

test("the url carries the token and points at the watch route", () => {
  const url = buildWatchUrl("U123", "sess_a", SECRET, "https://ada.example.com");
  expect(url.startsWith("https://ada.example.com/watch?link=")).toBe(true);
  const token = decodeURIComponent(new URL(url).searchParams.get("link")!);
  expect(verifyLinkClaims(token, "watch", SECRET)).toEqual({ userId: "U123", sessionId: "sess_a" });
});

test("a watch link outlives a chat link, since a turn can be long", () => {
  expect(WATCH_TTL_MS).toBeGreaterThan(10 * 60 * 1000);
});
