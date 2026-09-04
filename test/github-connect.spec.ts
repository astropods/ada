import { test, expect } from "@playwright/test";
import { githubPromptGuidance } from "../agent/github-guidance.ts";

/**
 * What `connect github` actually asks a user to do.
 *
 * A GitHub App has two independent grants, and conflating them cost a real user
 * a working afternoon:
 *
 *   INSTALLATION  — an org owner decides which repos the App may touch. Once
 *                   per org, by someone with rights to do it.
 *   AUTHORIZATION — each person authorizes the App to act AS them. Once per
 *                   user, by anyone.
 *
 * A user-to-server token reaches the intersection, so a colleague joining an
 * org where the App is already installed needs ONLY the second. `connect
 * github` sent them to `installations/new` regardless — offering an
 * installation they had no rights to change, which GitHub refused with "access
 * denied" on a step that was never necessary. Choosing their personal account
 * instead produced a token with no access to the org's repos, so the clone
 * failed and Ada reported being unauthenticated: a loop with no exit.
 */

/**
 * The OAuth routes are inert without an App, and credentials come only from the
 * manifest setup flow. Seeded through the test-only hook so these actually RUN:
 * a silently-skipped test on the exact routing that shipped broken is worse
 * than no test at all.
 */
test.beforeAll(async ({ request }) => {
  const res = await request.post("/test/github-app", {
    data: { clientId: "Iv1.test", slug: "ada-test" },
  });
  expect(res.status(), "test hooks must be enabled (ADA_TEST_HOOKS=1)").toBe(200);
  expect((await res.json()).configured).toBe(true);
});

test.afterAll(async ({ request }) => {
  await request.post("/test/github-app", { data: {} }); // back to unconfigured
});

test("connecting sends a user to authorize, not to a repo picker", async ({ request }) => {
  // No redirect-following: the Location header is the assertion.
  const res = await request.get("/auth/github/login", { maxRedirects: 0 });
  expect(res.status()).toBe(302);

  const location = res.headers()["location"] ?? "";
  expect(location, "must go to GitHub's user-authorization endpoint").toContain(
    "github.com/login/oauth/authorize",
  );
  expect(location, "must NOT drop the user on an installation picker").not.toContain(
    "installations/new",
  );
});

test("the install screen is still reachable, but only when asked for", async ({ request }) => {
  // Genuinely needed sometimes: the first install in an org, or adding personal
  // repos. The point is that it is opt-in rather than demanded of everyone.
  const res = await request.get("/auth/github/login?install=1", { maxRedirects: 0 });
  expect(res.status()).toBe(302);

  const location = res.headers()["location"] ?? "";
  expect(location, "explicit install must reach the picker").toContain(
    "github.com/apps/ada-test/installations/new",
  );
  // The signed state has to survive onto the install URL, or the callback
  // cannot tell who came back.
  expect(location).toContain("state=");
});

test("a freshly provisioned App is sent to the installation screen", async () => {
  /**
   * The one caller that genuinely needs the picker.
   *
   * Setup has just created the App; it is installed nowhere, so the admin who
   * provisioned it must choose repositories before it can reach any. Flipping
   * the login route's default to authorization silently turned this redirect
   * into a no-op — the App existed and could reach nothing, with no step left
   * in the flow to fix it.
   *
   * Asserted on the source: reaching the redirect for real needs a valid
   * manifest code and a round-trip to GitHub, and mocking that would test the
   * mock. What can break here is the pairing between the two routes, so that is
   * what this pins.
   */
  const src = await (await import("node:fs/promises")).readFile("agent/app.ts", "utf8");
  const setupCallback = src.slice(src.indexOf('app.get("/api/setup/github/callback"'));
  const redirect = setupCallback.slice(0, setupCallback.indexOf("} catch"));
  expect(redirect, "post-provision must open the installation picker").toContain(
    '/auth/github/login?install=1',
  );
});

test("an install request with no App slug degrades loudly, not silently", async ({ request }) => {
  // The install URL is built from the slug and nothing substitutes for it.
  // GitHub's manifest conversion does return one, so this is the degenerate
  // case — but `?install=1` quietly behaving as authorize is exactly how the
  // regression above hid, so the fallback is asserted rather than assumed.
  const seeded = await request.post("/test/github-app", { data: { clientId: "Iv1.noslug" } });
  expect(seeded.status()).toBe(200);
  try {
    const res = await request.get("/auth/github/login?install=1", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const location = res.headers()["location"] ?? "";
    expect(location, "no slug means no install URL to build").toContain(
      "github.com/login/oauth/authorize",
    );
    expect(location).not.toContain("installations/new");
    expect(location, "and it must not emit a broken URL with an empty slug").not.toContain(
      "apps//installations",
    );
  } finally {
    // Restore the slug the other tests in this file rely on.
    await request.post("/test/github-app", { data: { clientId: "Iv1.test", slug: "ada-test" } });
  }
});

test("guidance never tells a user to grant repo access themselves", () => {
  // The transcript that prompted this said: "finish the authorization
  // (including granting access to the postman-eng/postman-app repo when
  // prompted)". That is the one thing the user could not do and did not need
  // to, and it is the model repeating it that turns a papercut into a loop.
  const connected = githubPromptGuidance({ configured: true, connected: true });
  expect(connected, "a 403 is an org-owner problem, and must be named as one").toMatch(
    /ORG OWNER/,
  );
  expect(connected).toMatch(/not something the user can fix by\s+reconnecting/);
  expect(connected, "must forbid the advice that caused the loop").toMatch(
    /Do NOT tell the user to re-run `connect github` and grant repo access/,
  );

  const unconnected = githubPromptGuidance({ configured: true, connected: false });
  expect(unconnected, "connecting is authorization only").toMatch(
    /does NOT ask them to choose repositories/,
  );
  expect(unconnected).toMatch(/do not tell them to grant access to a repo or to install anything/);
  // The one instruction that has to survive every rewrite of this text.
  for (const g of [connected, unconnected]) {
    expect(g).toMatch(/NEVER ask the user to paste a Personal Access Token/);
  }
});
