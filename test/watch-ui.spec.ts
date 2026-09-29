import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Following a run from a chat link.
 *
 * The server hands the browser `/?watch=<id>` after trading the signed link for
 * a grant. What the client does with it had no test, and it is the half that
 * broke first: `openConversation` reads state declared throughout the script,
 * so invoking it too early threw a ReferenceError — after the id was already
 * stripped from the URL, leaving a bare frontend and no clue why.
 *
 * Read-only is enforced by the `reviewing` flag at submit, NOT by a disabled
 * input: replaying a finished conversation ends on RUN_FINISHED, which
 * re-enables the composer. So that is what these assert.
 */

async function seedSlackSession(request: APIRequestContext): Promise<string> {
  const res = await request.post("/test/seed", { data: { kind: "slack", userId: "U-human" } });
  expect(res.status(), "seeding must succeed").toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

test("a watch url opens that conversation and replays it", async ({ page, request }) => {
  const sessionId = await seedSlackSession(request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`/?watch=${sessionId}`);

  await expect(page.locator("#timeline")).toContainText("Following this run");
  await expect(page.locator("#timeline .bubble").first(), "the history is replayed").toBeVisible();
  expect(errors, "the client must not throw on the way in").toEqual([]);
});

test("a watcher cannot drive the conversation", async ({ page, request }) => {
  const sessionId = await seedSlackSession(request);
  let posted = false;
  await page.route("**/sessions/**", (route) => {
    if (route.request().method() === "POST") posted = true;
    return route.fallback();
  });

  await page.goto(`/?watch=${sessionId}`);
  await expect(page.locator("#timeline .bubble").first()).toBeVisible();

  await page.locator("#prompt").fill("can I drive this?");
  await page.locator("#send").click();

  await expect(page.locator("#timeline"), "refused, and says why").toContainText("read-only");
  expect(posted, "and nothing was dispatched").toBe(false);
});

test("the id is stripped only once the conversation is open", async ({ page, request }) => {
  // Stripping first is what turned a thrown error into a bare frontend with a
  // clean URL — nothing to reload, nothing to diagnose.
  const sessionId = await seedSlackSession(request);
  await page.goto(`/?watch=${sessionId}`);
  await expect(page.locator("#timeline")).toContainText("Following this run");
  expect(new URL(page.url()).searchParams.get("watch")).toBeNull();
});

test("no watch param is the ordinary client", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeEnabled();
  await expect(page.locator("#sid")).toHaveText("—");
  await expect(page.locator("#timeline")).not.toContainText("Following this run");
});
