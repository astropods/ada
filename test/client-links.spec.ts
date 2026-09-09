import { test, expect } from "@playwright/test";

/**
 * Links in a reply open in a new tab.
 *
 * Following one in place tears down the page, and the page IS the live turn —
 * the EventSource closes and coming back is a fresh load that has to
 * re-establish the stream and replay. Ada's links are things you open while it
 * keeps working: a PR it just pushed, a failing CI run, a doc it cited.
 *
 * The markdown is rendered through marked + DOMPurify from a pinned CDN, so
 * these drive the real page and assert on the DOM that renderMarkdown produced.
 */

/** Render markdown through the page's own pipeline and hand back the anchors. */
async function anchorsFor(page: import("@playwright/test").Page, markdown: string) {
  return page.evaluate((md) => {
    const html = (window as unknown as { renderMarkdown(s: string): string | null }).renderMarkdown(md);
    if (html == null) return null;
    const host = document.createElement("div");
    host.innerHTML = html;
    return [...host.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
      rel: a.getAttribute("rel"),
      text: a.textContent,
    }));
  }, markdown);
}

test("a link in a reply opens in a new tab, with the opener severed", async ({ page }) => {
  await page.goto("/");

  const anchors = await anchorsFor(page, "opened [PR #12](https://github.com/astropods/ada/pull/12) for you");
  expect(anchors, "the CDN markdown pipeline is available").not.toBeNull();
  expect(anchors).toHaveLength(1);
  expect(anchors![0].href).toBe("https://github.com/astropods/ada/pull/12");
  expect(anchors![0].target, "the live turn must survive the click").toBe("_blank");
  // noopener: the destination gets no handle on our window.
  // noreferrer: this is model- and repo-derived content, so it does not get
  // the URL the user was on either.
  expect(anchors![0].rel).toContain("noopener");
  expect(anchors![0].rel).toContain("noreferrer");
});

test("bare URLs and relative links get the same treatment", async ({ page }) => {
  await page.goto("/");

  // marked autolinks a bare URL, which is how most of Ada's links actually
  // arrive — it pastes the URL rather than writing link syntax.
  const auto = await anchorsFor(page, "see https://example.com/ci/run/9 for the failure");
  expect(auto![0].target).toBe("_blank");

  // Same-origin links too: the connect link Ada hands out is one of these, and
  // navigating away from a live turn is no better for being same-origin.
  const rel = await anchorsFor(page, "[connect github](/auth/github/login)");
  expect(rel![0].href).toBe("/auth/github/login");
  expect(rel![0].target).toBe("_blank");
});

test("the hook adds a target — it does not decide what survives sanitizing", async ({ page }) => {
  await page.goto("/");

  // DOMPurify strips the dangerous scheme before the hook ever sees the node.
  // Asserted here because "we now set target on every anchor" is exactly the
  // kind of change that can look like it re-opens a hole.
  const js = await anchorsFor(page, "[click me](javascript:alert(1))");
  expect(js!.every((a) => !(a.href ?? "").toLowerCase().startsWith("javascript:"))).toBe(true);

  // Inline HTML in model output is still sanitized: no event handlers survive.
  const injected = await page.evaluate(() => {
    const html = (window as unknown as { renderMarkdown(s: string): string | null }).renderMarkdown(
      '<a href="https://example.com" onclick="alert(1)">x</a><script>alert(2)</script>',
    );
    return html ?? "";
  });
  expect(injected).not.toContain("onclick");
  expect(injected).not.toContain("<script");
  expect(injected, "and the surviving link still opens in a new tab").toContain('target="_blank"');
});

test("a rendered assistant message carries the attributes end to end", async ({ page }) => {
  await page.goto("/");

  // Through the real event path rather than the helper, so a change to how
  // messages are rendered is caught too.
  await page.evaluate(() => {
    (window as unknown as { handle(e: unknown): void }).handle({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "m-link",
      delta: "done: https://github.com/astropods/ada/pull/12",
    });
  });

  const link = page.locator(".bubble.assistant .body a").first();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});
