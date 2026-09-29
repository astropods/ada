import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * WHOSE conversation an authorized user may touch.
 *
 * `allowed` and "owner" are different questions, and conflating them was the
 * bug. `allowed` means the grants table lets this person use Ada at all; it says
 * nothing about which sessions are theirs. A session id was the only thing
 * standing between one authorized user and another's conversation — and a
 * session carries a repo checkout, that user's GitHub identity, and their
 * private-repo content.
 *
 * Three holes, fixed together because they are one mistake:
 *
 *   - `/agents/ada/*`, Flue's native router, was mounted with NO gate at all
 *     while every /sessions/* route resolved an identity. It addresses the same
 *     durable instances, so it was an unauthenticated way to read and drive the
 *     conversations the AG-UI path gates.
 *   - `DELETE /sessions/:id` checked only `allowed`, so any authorized user
 *     could destroy any session by id — the least recoverable call in the API.
 *   - `POST /sessions/:id/messages` likewise: driving someone else's
 *     conversation runs a turn in their workspace as their GitHub identity.
 *
 * Driven against a REAL SERVER PROCESS rather than by importing the app, for two
 * reasons. It covers the mounting — a correct rule that isn't wired up is the
 * failure mode most worth catching here — and importing `agent/app.ts` into a
 * test worker starts its eager `boot()`, which installs telemetry globally and
 * breaks whichever spec shares the worker afterwards.
 *
 * The server runs with ADMIN_EMAILS set, because that is what makes the gating
 * real: with no admin list, `mayViewOthers` is true for every authorized user
 * (the documented single-tenant / dev posture, asserted separately below).
 * With no ASTRO_AUTHZ_TOKEN, `authorize()` is a no-op allow and identity falls
 * back to the `bridge_uid` cookie, so each request picks its caller with that.
 */

const ADMIN = "admin@example.com";
const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn("node", ["agent/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADA_TEST_HOOKS: "1",
      ADMIN_EMAILS: ADMIN,
      // This suite forges the ALB's identity headers to exercise a
      // DEPLOYMENT's rules, so it declines the local-admin default. Its
      // non-admin caller is modelled as one with no verified email, which is
      // indistinguishable from a local browser — the distinction has to be
      // stated here rather than inferred from the request.
      ADA_LOCAL_ADMIN: "0",
      // Keep this server's SQLite database out of the default workspace root so
      // it cannot interfere with the shared dev server's state.
      WORKSPACE_ROOT: join(ROOT, "test-results", "authz-workspace"),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      // Any HTTP status means it is listening; `/` itself is auth-gated.
      await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("authz test server did not start");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

test.afterAll(() => {
  server?.kill("SIGKILL");
});

/** Forge the ALB's identity JWT. Unsigned by design — the ALB strips client copies. */
function oidcData(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url");
  return `header.${payload}.sig`;
}

/** Headers that make a request act as `user`, optionally as the admin. */
function as(user: string, opts: { admin?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = { cookie: `bridge_uid=${user}` };
  if (opts.admin) headers["x-amzn-oidc-data"] = oidcData(ADMIN);
  return headers;
}

/** Seed a finished session owned by `userId`, via the test-only hook. */
async function seed(kind: "browser" | "slack", userId?: string): Promise<string> {
  const res = await fetch(`${BASE}/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json", ...as("seeder", { admin: true }) },
    body: JSON.stringify({ kind, userId }),
  });
  expect(res.status, "seeding must succeed").toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

/** Status of a request, without leaving an SSE body streaming. */
async function status(path: string, init: RequestInit = {}): Promise<number> {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel();
  return res.status;
}

test("gates Flue's native agent router", async () => {
  // It was mounted bare. Both spellings matter: registering only
  // `/agents/ada/*` would leave `/agents/ada` itself open.
  expect(await status("/agents/ada", { headers: as("user-a") })).toBe(403);
  expect(await status("/agents/ada/sess_whatever", { headers: as("user-a") })).toBe(403);
  expect(
    await status("/agents/ada/sess_whatever", { method: "POST", headers: as("user-a") }),
  ).toBe(403);
  // An admin still gets through to the router (not blocked by our gate).
  expect(await status("/agents/ada/sess_whatever", { headers: as("user-a", { admin: true }) })).not.toBe(403);
});

test("lets a user read their own session but not another's", async () => {
  const mine = await seed("browser", "user-a");
  const theirs = await seed("browser", "user-b");
  expect(await status(`/sessions/${mine}/events`, { headers: as("user-a") })).toBe(200);
  expect(await status(`/sessions/${theirs}/events`, { headers: as("user-a") })).toBe(403);
});

test("keeps Slack conversations admin-only", async () => {
  // The pre-existing rule, which must not have been weakened.
  const slack = await seed("slack", "user-b");
  expect(await status(`/sessions/${slack}/events`, { headers: as("user-b") })).toBe(403);
  expect(await status(`/sessions/${slack}/events`, { headers: as("user-b", { admin: true }) })).toBe(200);
});

test("treats a session with no recorded owner as nobody's", async () => {
  const orphan = await seed("browser");
  expect(await status(`/sessions/${orphan}/events`, { headers: as("user-a") })).toBe(403);
  expect(await status(`/sessions/${orphan}/events`, { headers: as("user-a", { admin: true }) })).toBe(200);
});

test("refuses to delete another user's session, and leaves it intact", async () => {
  const theirs = await seed("browser", "user-b");
  expect(await status(`/sessions/${theirs}`, { method: "DELETE", headers: as("user-a") })).toBe(403);
  // Still readable by its owner afterwards, so the refusal was total.
  expect(await status(`/sessions/${theirs}/events`, { headers: as("user-b") })).toBe(200);
});

test("lets a user delete their own session", async () => {
  const mine = await seed("browser", "user-a");
  expect(await status(`/sessions/${mine}`, { method: "DELETE", headers: as("user-a") })).toBe(204);
  expect(await status(`/sessions/${mine}/events`, { headers: as("user-a") })).toBe(404);
});

test("refuses to drive another user's session", async () => {
  const theirs = await seed("browser", "user-b");
  expect(
    await status(`/sessions/${theirs}/messages`, {
      method: "POST",
      headers: { ...as("user-a"), "content-type": "application/json" },
      body: JSON.stringify({ prompt: "act as user-b" }),
    }),
  ).toBe(403);
});

test("answers 404 for an unknown session, not 403", async () => {
  // "No such session" must stay distinguishable from "not yours", or a user's
  // own tooling cannot tell a stale id from a permissions problem.
  expect(await status("/sessions/sess_nope/events", { headers: as("user-a") })).toBe(404);
  expect(await status("/sessions/sess_nope", { method: "DELETE", headers: as("user-a") })).toBe(404);
});

test("authorizes before revealing whether a session exists or is busy", async () => {
  // The gate used to sit BELOW the existence and busy checks on /messages, so a
  // non-owner probing ids still learned which ones existed and which were
  // mid-turn. A non-owner must get the same 403 either way.
  const theirs = await seed("browser", "user-b");
  const body = JSON.stringify({ prompt: "x" });
  const headers = { ...as("user-a"), "content-type": "application/json" };
  expect(await status(`/sessions/${theirs}/messages`, { method: "POST", headers, body })).toBe(403);
  // No prompt at all: still 403 rather than 400, so the shape of the request
  // cannot be used to distinguish a real session from a missing one.
  expect(
    await status(`/sessions/${theirs}/messages`, { method: "POST", headers, body: "{}" }),
  ).toBe(403);
});

/**
 * The other half of the contract: gating must not break a deployment that never
 * configures an admin list.
 *
 * Run against the suite's SHARED server (no ADMIN_EMAILS), where
 * `mayViewOthers` is true for any authorized user — the same posture
 * /conversations documents. Local dev and single-tenant deployments live here,
 * so a regression that 403s them would be worse than the hole being fixed.
 */
test("without an admin list, the documented open posture is unchanged", async ({ baseURL }) => {
  const seedOn = async (owner: string): Promise<string> => {
    const res = await fetch(`${baseURL}/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "browser", userId: owner }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { sessionId: string }).sessionId;
  };
  const statusOn = async (path: string, init: RequestInit = {}): Promise<number> => {
    const res = await fetch(`${baseURL}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
    return res.status;
  };

  const theirs = await seedOn("someone-else");
  // Another user's session is readable and deletable, as before this change.
  expect(await statusOn(`/sessions/${theirs}/events`, { headers: as("user-a") })).toBe(200);
  // The native router reaches its handler rather than being refused by our gate.
  expect(await statusOn("/agents/ada/sess_whatever", { headers: as("user-a") })).not.toBe(403);
  expect(await statusOn(`/sessions/${theirs}`, { method: "DELETE", headers: as("user-a") })).toBe(204);
});

/* ── Which token kind gates the web UI ─────────────────────────────────── */

/**
 * `ASTRO_AUTHZ_TOKEN` carries two different credentials.
 *
 * A DEPLOY token is a deployment's identity, and web requests to it arrive
 * through an ALB that has already established who the caller is — so the grants
 * table is the right authority. A DEV-SESSION token is the developer's own,
 * minted by `ast project start` so a local agent can attach a sandbox. There is
 * no ALB in front of local dev, so every request is anonymous, and asking the
 * grants table about it denies — which failed closed into a themed 401 and
 * locked developers out of their own frontend.
 *
 * The kinds are distinguishable rather than guessable: a dev session carries
 * `typ: "dev"`, a deploy token carries no `typ` (astropods/astro#2724).
 */
function token(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `h.${payload}.sig`;
}

test("a deploy token gates the web UI", async () => {
  const { Authorizer } = await import("../agent/auth/authz.ts");
  const a = new Authorizer({ ASTRO_AUTHZ_TOKEN: token({ iss: "https://astropods.com", sub: "dep_1" }) } as NodeJS.ProcessEnv);
  expect(a.enabled).toBe(true);
  expect(a.describe()).toContain("enforced via https://astropods.com");
});

test("a dev-session token does NOT gate the web UI", async () => {
  const { Authorizer } = await import("../agent/auth/authz.ts");
  const a = new Authorizer({
    ASTRO_AUTHZ_TOKEN: token({ iss: "https://astropods.com", sub: "sess_1", typ: "dev" }),
  } as NodeJS.ProcessEnv);
  // Declaring a `sandbox` section is enough to make this token appear locally,
  // so treating it as a deployment credential is what broke the frontend.
  expect(a.enabled).toBe(false);
  expect(await a.authorize(""), "and the request is allowed, not denied").toMatchObject({ allowed: true });
  expect(a.describe()).toContain("dev session");
});

test("no token at all still means ungated, as it always did", async () => {
  const { Authorizer } = await import("../agent/auth/authz.ts");
  const a = new Authorizer({} as NodeJS.ProcessEnv);
  expect(a.enabled).toBe(false);
  expect(await a.authorize("")).toMatchObject({ allowed: true });
  expect(a.describe()).toContain("not configured");
});

test("a token with no issuer cannot gate anything, whatever its kind", async () => {
  const { Authorizer } = await import("../agent/auth/authz.ts");
  // `iss` is where the authorize call would be sent; without it there is
  // nowhere to ask, so enforcing would deny every request with no recourse.
  const a = new Authorizer({ ASTRO_AUTHZ_TOKEN: token({ sub: "dep_1" }) } as NodeJS.ProcessEnv);
  expect(a.enabled).toBe(false);
});

test("the startup line never contains the token", async () => {
  const { Authorizer } = await import("../agent/auth/authz.ts");
  const secret = token({ iss: "https://astropods.com", sub: "dep_1" });
  expect(new Authorizer({ ASTRO_AUTHZ_TOKEN: secret } as NodeJS.ProcessEnv).describe()).not.toContain(secret);
});

/* ── Admin off a deployment ────────────────────────────────────────────── */

/**
 * `isAdmin` matches a verified email the ALB supplies, and only a deployment
 * has an ALB. So off one the email is always empty and ADMIN_EMAILS can only
 * ever deny — setting it to grant yourself admin locally did the opposite,
 * flipping `mayViewOthers` from "no list, so open" to "a list, and nothing can
 * match it".
 */
test("local development is admin, even with an allowlist set", async () => {
  const { isAdmin, adminListConfigured } = await import("../agent/auth/setup.ts");
  const local = { ADMIN_EMAILS: "simon@example.com" } as NodeJS.ProcessEnv;
  // The allowlist is still configured — that is what used to close the gate.
  expect(adminListConfigured(local)).toBe(true);
  expect(isAdmin("", local), "no ALB, so no email to match").toBe(true);
});

test("local admin can be declined, which is how this suite tests a deployment", async () => {
  const { isAdmin } = await import("../agent/auth/setup.ts");
  // Not inferable: a non-admin caller here is modelled as one with no verified
  // email, which looks exactly like a local browser.
  const off = { ADMIN_EMAILS: "simon@example.com", ADA_LOCAL_ADMIN: "0" } as NodeJS.ProcessEnv;
  expect(isAdmin("", off)).toBe(false);
  expect(isAdmin("simon@example.com", off), "the allowlist still works").toBe(true);
});

test("a dev-session token is still local, not a deployment", async () => {
  const { isAdmin } = await import("../agent/auth/setup.ts");
  const dev = {
    ADMIN_EMAILS: "simon@example.com",
    ASTRO_AUTHZ_TOKEN: token({ iss: "https://astropods.com", sub: "sess_1", typ: "dev" }),
  } as NodeJS.ProcessEnv;
  // `ast project start` injects one of these for sandbox attach; it does not
  // make the run a deployment.
  expect(isAdmin("", dev)).toBe(true);
});

test("a real deployment still enforces the allowlist", async () => {
  const { isAdmin } = await import("../agent/auth/setup.ts");
  const deployed = {
    ADMIN_EMAILS: "simon@example.com",
    ASTRO_AUTHZ_TOKEN: token({ iss: "https://astropods.com", sub: "dep_1" }),
  } as NodeJS.ProcessEnv;
  expect(isAdmin("simon@example.com", deployed), "on the list").toBe(true);
  expect(isAdmin("SIMON@EXAMPLE.COM", deployed), "case-insensitive").toBe(true);
  expect(isAdmin("someone@else.com", deployed), "not on the list").toBe(false);
  expect(isAdmin("", deployed), "no verified email is not an admin").toBe(false);
});
