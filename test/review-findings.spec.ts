import { test, expect } from "@playwright/test";
import { parseReview } from "../agent/telemetry/otel.ts";

/**
 * Counting what a review concluded.
 *
 * `ada.review.findings` is how you tell whether the reviewer is earning its
 * cost or has quietly started returning nothing. The first version parsed the
 * delegate's whole task result as JSON — but `defineSubagent` takes no output
 * schema, so a delegate returns prose, and the metric silently counted zero
 * forever. A metric that cannot fire is worse than no metric: it reads as
 * "no findings".
 *
 * The reviewer's brief now ends with a fenced json block, and this parses it.
 */

const review = (body: string) => parseReview(body);

test("reads the fenced block at the end of a prose review", () => {
  const out = review(
    [
      "The ownership test added here asserts nothing meaningful.",
      "",
      "```json",
      '{"findings":[{"severity":"high","category":"tests","title":"asserts nothing"},',
      '{"severity":"low","category":"maintainability","title":"naming"}]}',
      "```",
    ].join("\n"),
  );
  expect(out?.findings?.length).toBe(2);
  expect(out?.findings?.[0]?.severity).toBe("high");
});

test("an empty review is a real result, not a parse failure", () => {
  // "I looked and found nothing" must be distinguishable from "I never ran".
  const out = review("Looks sound.\n\n```json\n{\"findings\":[]}\n```");
  expect(out).not.toBeNull();
  expect(out?.findings).toEqual([]);
});

test("prefers the final block when the prose quotes one earlier", () => {
  const out = review(
    [
      "For example a finding looks like:",
      "```json",
      '{"findings":[{"severity":"critical","category":"security","title":"EXAMPLE"}]}',
      "```",
      "My actual review found less.",
      "```json",
      '{"findings":[{"severity":"low","category":"style","title":"real"}]}',
      "```",
    ].join("\n"),
  );
  expect(out?.findings?.length).toBe(1);
  expect(out?.findings?.[0]?.title).toBe("real");
});

test("degrades to null rather than throwing", () => {
  // A model that forgets or mangles the block costs a data point, never a run.
  expect(review("No JSON here at all.")).toBeNull();
  expect(review("```json\n{not json}\n```")).toBeNull();
  expect(parseReview(undefined)).toBeNull();
  expect(parseReview(42)).toBeNull();
});

test("still accepts an already-parsed object", () => {
  expect(parseReview({ findings: [{ severity: "medium", category: "correctness" }] })?.findings?.length).toBe(1);
});
