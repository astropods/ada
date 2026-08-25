import { test, expect } from "@playwright/test";
import { resolveBaseUrl, callbackPath } from "../agent/auth/base-url.ts";

/**
 * The agent's public base URL.
 *
 * Untested until now, despite being the module behind a production failure: a
 * GitHub App was provisioned with `http://localhost:80`, because the container
 * sets PORT=80 while the frontend is mapped to 8080, so every OAuth callback
 * landed on a port nothing was listening on. These are pure functions of an
 * env and a header — there was no excuse for not covering them.
 */

test("explicit config wins over everything", () => {
  expect(resolveBaseUrl(undefined, { PUBLIC_BASE_URL: "https://a.example" })).toBe("https://a.example");
  expect(
    resolveBaseUrl(undefined, {
      PUBLIC_BASE_URL: "https://a.example",
      ASTRO_EXTERNAL_AGENT_URL: "https://b.example",
    }),
    "PUBLIC_BASE_URL outranks the platform's own variable",
  ).toBe("https://a.example");
  expect(resolveBaseUrl(undefined, { ASTRO_EXTERNAL_AGENT_URL: "https://b.example/" })).toBe(
    "https://b.example",
  );
});

test("uses the request's own origin for loopback, whatever the port", () => {
  // The production bug: PORT=80 inside the container, browser on 8080.
  const env = { PORT: "80" };
  expect(resolveBaseUrl({ headers: { host: "localhost:8080" } }, env)).toBe("http://localhost:8080");
  expect(resolveBaseUrl({ headers: { host: "127.0.0.1:3000" } }, env)).toBe("http://127.0.0.1:3000");
  expect(resolveBaseUrl({ headers: { host: "[::1]:9999" } }, env)).toBe("http://[::1]:9999");
});

test("never trusts a non-loopback Host", () => {
  // Host is client-controlled; building an OAuth redirect_uri from it would let
  // a poisoned header deliver a victim's authorization code elsewhere. The
  // near-miss spellings matter: a prefix/suffix match would pass them.
  const env = { PORT: "80" };
  for (const host of ["evil.example.net", "localhost.evil.net", "127.0.0.1.evil.net", "notlocalhost"]) {
    expect(resolveBaseUrl({ headers: { host } }, env), `${host} must not be trusted`).toBe(
      "http://localhost:80",
    );
  }
  expect(
    resolveBaseUrl({ headers: { host: "evil.example.net" } }, { ASTRO_EXTERNAL_AGENT_URL: "https://ok.example" }),
    "and config still wins, so a real deployment never reaches this path",
  ).toBe("https://ok.example");
});

test("falls back to the configured port with no request", () => {
  // Chat-minted connect links have no HTTP request to derive an origin from.
  expect(resolveBaseUrl(undefined, {})).toBe("http://localhost:8080");
  expect(resolveBaseUrl(undefined, { PORT: "3200" })).toBe("http://localhost:3200");
});

test("builds the callback path GitHub was told about", () => {
  expect(callbackPath("https://ada.example")).toBe("https://ada.example/auth/github/callback");
  expect(callbackPath("https://ada.example/")).toBe("https://ada.example/auth/github/callback");
});
