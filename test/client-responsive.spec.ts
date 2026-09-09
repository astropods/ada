import { test, expect, type Page } from "@playwright/test";

/**
 * The client on a phone.
 *
 * The layout was built for a desktop column and had no breakpoints at all, so
 * the failures here are structural rather than cosmetic: a composer pushed
 * off-screen can't be typed into, a settings panel pinned under the header
 * can't be read, and a 380px debug column on a 375px screen leaves nothing for
 * the conversation.
 *
 * These assert on geometry — what is reachable and what overflows — rather than
 * on the CSS, so they keep meaning if the rules are rewritten.
 */

const PHONE = { width: 375, height: 667 }; // iPhone SE/8 — the narrow end of common
const TABLET = { width: 820, height: 1180 };

/** Nothing may push the page sideways: a horizontally scrolling app reads as broken. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(1);
}

test("the composer is reachable and typable on a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");

  const box = await page.locator("#composer").boundingBox();
  expect(box, "the composer is laid out").not.toBeNull();
  // Fully above the fold — the whole point of the dvh column.
  expect(box!.y + box!.height, "the composer sits within the viewport").toBeLessThanOrEqual(PHONE.height + 1);

  await page.locator("#prompt").fill("does this work on a phone");
  await expect(page.locator("#prompt")).toHaveValue("does this work on a phone");

  // Below 16px, iOS Safari zooms the page on focus and leaves the layout
  // scrolled sideways with the composer half off-screen.
  const fontSize = await page
    .locator("#prompt")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize, "iOS zooms inputs under 16px on focus").toBeGreaterThanOrEqual(16);

  await expectNoHorizontalOverflow(page);
});

test("a long unbroken string does not widen the page", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");

  // A stack frame or a signed URL is the realistic version of this.
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "bubble assistant";
    el.innerHTML = '<div class="role">assistant</div><div class="body"></div>';
    el.querySelector(".body")!.textContent =
      "https://example.com/" + "a".repeat(400) + "?token=" + "b".repeat(200);
    document.getElementById("timeline")!.appendChild(el);
  });

  // The page itself never widens — `#timeline` scrolls internally — so assert
  // the property that actually matters: the text wrapped inside the column
  // rather than forcing the column to scroll sideways to read it.
  const overflow = await page.evaluate(() => {
    const t = document.getElementById("timeline")!;
    return t.scrollWidth - t.clientWidth;
  });
  expect(overflow, "the bubble must wrap, not scroll sideways").toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
});

test("the floating panels clear the header, at any header height", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/");

  // The header WRAPS at this width, so it is taller than the 52px the panels
  // used to assume — which is exactly when they used to open underneath it.
  const header = (await page.locator("header").boundingBox())!;
  expect(header.height, "the header wraps on a phone").toBeGreaterThan(52);

  await page.locator("#settings-btn").click();
  const panel = (await page.locator("#settings-panel").boundingBox())!;
  expect(panel.y, "the settings panel opens below the header").toBeGreaterThanOrEqual(header.height);
  expect(panel.width, "and uses the width available").toBeGreaterThan(PHONE.width * 0.8);
  expect(panel.x + panel.width, "without spilling off-screen").toBeLessThanOrEqual(PHONE.width + 1);

  await page.locator("#settings-close").click();

  // Same for the session menu, which opens from the other edge.
  await page.locator("#sid-btn").click();
  const menu = (await page.locator("#session-menu").boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(header.height);
  expect(menu.x + menu.width).toBeLessThanOrEqual(PHONE.width + 1);
});

test("the debug pane stacks instead of squeezing the conversation", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/?debug");

  const timeline = (await page.locator("#timeline").boundingBox())!;
  const side = (await page.locator("#side").boundingBox())!;

  // Side-by-side, the 380px column would leave the conversation nothing.
  expect(timeline.width, "the conversation keeps the full width").toBeGreaterThan(PHONE.width * 0.85);
  expect(side.y, "the debug pane sits below it").toBeGreaterThanOrEqual(timeline.y + timeline.height - 1);
  await expectNoHorizontalOverflow(page);
});

test("the desktop two-column layout is untouched", async ({ page }) => {
  // The breakpoints are additive; the layout this was built for must not move.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?debug");

  const timeline = (await page.locator("#timeline").boundingBox())!;
  const side = (await page.locator("#side").boundingBox())!;
  expect(side.x, "the debug pane is still a right-hand column").toBeGreaterThan(timeline.x + timeline.width - 1);
  expect(Math.round(side.width), "still 380px wide").toBe(380);
  // Every chip is still shown at desktop width.
  await expect(page.locator("#model-chip")).toBeVisible();
  await expect(page.locator("#conn-chip")).toBeVisible();
});

test("a tablet keeps the desktop layout", async ({ page }) => {
  // 820px is above the breakpoint: the phone rules must not catch an iPad.
  await page.setViewportSize(TABLET);
  await page.goto("/?debug");

  const timeline = (await page.locator("#timeline").boundingBox())!;
  const side = (await page.locator("#side").boundingBox())!;
  expect(side.x).toBeGreaterThan(timeline.x + timeline.width - 1);
  await expectNoHorizontalOverflow(page);
});

test("the welcome screen fits a narrow phone", async ({ page }) => {
  // The ASCII wordmark is `white-space: pre`, so it cannot reflow — it either
  // fits or it widens the page.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  await expect(page.locator(".welcome .ascii")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
