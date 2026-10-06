import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * `EVALUATION.yaml` is only checked by `ast eval validate`, which runs by hand.
 * These assert the parts that would break silently: a `prompt_file` that does
 * not exist still validates as a document, and an evaluator whose rubric has
 * drifted from its `description` judges something other than what it claims.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = parse(readFileSync(join(ROOT, "EVALUATION.yaml"), "utf8")) as {
  schema: string;
  evaluators: Array<{
    key: string;
    label: string;
    description?: string;
    type: string;
    prompt?: string;
    prompt_file?: string;
    output: { type: string; options?: string[]; max_length?: number };
  }>;
};

test("the document declares the schema the parser requires", () => {
  expect(doc.schema).toBe("evaluation/v1");
  expect(doc.evaluators.length).toBeGreaterThan(0);
});

test("every evaluator satisfies the spec's own constraints", () => {
  const keys = new Set<string>();
  for (const e of doc.evaluators) {
    expect(e.key, `${e.key}: key pattern`).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    expect(keys.has(e.key), `${e.key}: keys must be unique`).toBe(false);
    keys.add(e.key);
    expect(e.label.length, `${e.key}: label 1-50 chars`).toBeGreaterThan(0);
    expect(e.label.length).toBeLessThanOrEqual(50);
    expect(e.type, `${e.key}: llm is the only type`).toBe("llm");
    // Exactly one of prompt / prompt_file.
    expect(Boolean(e.prompt) !== Boolean(e.prompt_file), `${e.key}: one prompt source`).toBe(true);
    expect(["boolean", "enum", "number", "string"]).toContain(e.output.type);
    if (e.output.type === "enum") {
      expect(e.output.options?.length ?? 0, `${e.key}: 2-20 enum options`).toBeGreaterThanOrEqual(2);
      expect(e.output.options?.length ?? 0).toBeLessThanOrEqual(20);
    }
  }
});

test("every prompt_file exists and is within the spec's length bounds", () => {
  for (const e of doc.evaluators) {
    if (!e.prompt_file) continue;
    // A missing file still parses as a valid document — this is what catches a
    // rename or a move.
    const body = readFileSync(join(ROOT, e.prompt_file), "utf8");
    expect(body.length, `${e.prompt_file}: 1-8000 chars`).toBeGreaterThan(0);
    expect(body.length, `${e.prompt_file}: 1-8000 chars`).toBeLessThanOrEqual(8_000);
  }
});

test("a boolean rubric says what each verdict means", () => {
  // An LLM judge given a boolean and no definition of either side will invent
  // one, and the score will drift without anything changing in the agent.
  for (const e of doc.evaluators) {
    if (e.output.type !== "boolean" || !e.prompt_file) continue;
    const body = readFileSync(join(ROOT, e.prompt_file), "utf8");
    expect(body, `${e.prompt_file}: defines true`).toMatch(/`true`/);
    expect(body, `${e.prompt_file}: defines false`).toMatch(/`false`/);
  }
});

test("the answer-not-narration rubric holds the examples it is judging against", () => {
  // The rubric is the whole evaluator. Losing the worked examples would leave
  // a judge with only an abstraction to match on.
  const body = readFileSync(join(ROOT, "evaluation/answer-not-narration.md"), "utf8");
  expect(body, "the narration pattern it exists to catch").toContain("Let me");
  // Honesty must never be scored as padding — the opposite would teach Ada to
  // drop its caveats.
  expect(body.toLowerCase()).toContain("caveat");
  expect(body, "length alone is not the test").toMatch(/word count/);
});
