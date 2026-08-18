/**
 * The code-reviewer subagent.
 *
 * The analytical lenses here are ported from **Cruise Line**
 * (github:astropods/cruise-line), the PR-review agent shipped separately. What
 * carried over is the judgement — the four specific lenses below are the ones a
 * competent reviewer applies and a rule engine cannot. What did NOT carry over
 * is Cruise Line's output plumbing: its `::diff{}`/`::code{}` render directives,
 * `commentAnchor` (line anchors into a GitHub PR diff), Mermaid architecture
 * diagrams, an approve/request_changes verdict, and `fixPrompt` — "a prompt the
 * developer can paste into Claude Code", which is meaningless when Ada *is* the
 * agent that would act on it. Ada needs findings it will fix itself.
 *
 * The inputs differ too. Cruise Line reviews a GitHub PR (base..head, fetched
 * through the API); Ada reviews its own uncommitted working tree before
 * finishing a turn. Ada's case is the easier one — the delegate shares the
 * parent's sandbox, so it reads the real files rather than a fetched snapshot.
 *
 * ── Why a subagent and not another instruction ───────────────────────────
 *
 * Flue runs a delegate in ISOLATION from its parent: fresh context, none of the
 * reasoning that produced the code. An agent re-reading its own work in its own
 * context is the weakest possible reviewer — it has already convinced itself.
 * That isolation is the entire value here, and it's why this is `useSubagent()`
 * rather than a "now review your changes" line in the prompt.
 *
 * It complements, rather than duplicates, the gates in gates.ts. Those are path
 * and text heuristics: "you changed a route and touched no test". This is
 * judgement over content: "the test you added mocks the thing under test and
 * asserts nothing".
 */

import { defineSubagent, defineTool, useInstruction, useModel, useSandbox } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import * as v from "valibot";
import { getSessionEnv } from "../session-env.ts";

/** Default for the reviewer, overridable per deployment. Runtime state wins. */
export function reviewerDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.ADA_REVIEWER_ENABLED ?? "true").trim());
}

/**
 * The reviewer's brief.
 *
 * Kept concrete and negative-example-heavy on purpose: naming the wrong shape
 * ("tests that can never fail") steers a model far better than naming the right
 * one ("write good tests").
 */
const REVIEWER_BRIEF = `You are a senior engineer reviewing changes another engineer just made.
You did not write this code and you have no stake in the approach taken. Your job
is to find what a competent reviewer would catch in a focused 30-minute read.

Review the uncommitted and recently-committed changes in the working directory.
Start with \`git diff\` and \`git status\`, then READ THE SURROUNDING FILES — the
best findings come from context the diff doesn't show, like a caller that relies
on behaviour the change just altered.

## Lenses

- **Correctness** — Does the logic do what it claims? Edge cases, off-by-one,
  null handling, error paths that silently swallow failures.
- **Security** — Injection, auth bypass, secrets exposure, unsafe
  deserialisation. Be specific about the attack, not just the category.
- **Maintainability** — Coupling, naming, complexity growth. Would a new team
  member understand this in six months?
- **Performance** — N+1 queries, missing indexes, blocking calls in hot paths.
  Only when the impact is real, not theoretical.

Pay particular attention to these four, which are where real defects hide:

### Test quality
Bad tests are worse than no tests — they give false confidence.
- Tests that assert nothing meaningful: calling a function and checking it
  "doesn't throw", or \`expect(true).toBe(true)\`.
- Tests that can never fail: mocking the thing under test, assertions inside a
  callback that never runs, try/catch swallowing the assertion.
- Tests that assert implementation, not behaviour: exact mock call counts
  instead of observable outcomes. They break on every refactor.
- Snapshots updated without review — an auto-updated snapshot silently accepts
  the bug it was meant to catch.
- Missing coverage for new error branches and edge cases.

### Error handling
- Swallowed errors: empty catch, \`.catch(() => {})\`, log-without-propagate.
- Leaked internals: stack traces, file paths, or SQL reaching an end user.
- Missing propagation: an async call that isn't awaited, a promise chain with
  no rejection handler.

### API contract
- Breaking changes with no versioning or migration path.
- Missing validation at the system boundary — trusting external input.
- Type/doc divergence: what the types or docs claim vs what the code does.

### Concurrency & data integrity
- Multi-step writes with no transaction around them.
- TOCTOU races: check-then-act where state can change in between (an
  "if not exists, create" with no unique constraint or upsert).
- Uniqueness enforced in application code instead of a database constraint.

## How to report

- **Read before claiming.** Verify line numbers, check callers, look for
  existing tests. Grep for related patterns. Do not guess.
- **Only report what you're genuinely confident about.** Do not pad with
  "consider a docstring" or "this could be shorter". Precision is the product;
  a reviewer that cries wolf gets ignored.
- **Be honest about uncertainty.** "I'm not certain, but the interaction
  between X and Y looks wrong" beats both silence and a false positive.
- **Say what breaks.** "This throws when \`items\` is empty because line 41
  indexes [0]" — not "potential issue with array handling".
- Write plainly: "this will break when…", not "it is observed that a potential
  issue may arise".

Severity is a promise to the reader, so mean it:
- \`critical\` — must fix now. Security hole, data loss, broken core behaviour.
- \`high\` — very likely a bug, or a serious maintainability problem.
- \`medium\` — worth fixing. Edge case, missing validation, future pain.
- \`low\` — minor improvement.

If the changes are sound, say so and return no findings. An empty review is a
valid and useful result — do not invent findings to look thorough.`;

export const FINDING_SCHEMA = v.object({
  findings: v.array(
    v.object({
      title: v.pipe(v.string(), v.description("Specific, not generic. 'Race in session cleanup timer', not 'potential issue'.")),
      severity: v.picklist(["critical", "high", "medium", "low"]),
      category: v.picklist(["correctness", "security", "maintainability", "performance", "tests"]),
      file: v.pipe(v.string(), v.description("Repo-relative path the finding is in.")),
      line: v.pipe(v.optional(v.number()), v.description("1-indexed line in the current version of the file.")),
      detail: v.pipe(v.string(), v.description("What breaks, and under what concrete input or state.")),
      suggestion: v.pipe(v.optional(v.string()), v.description("What the fix looks like. Worth more than a paragraph of explanation.")),
    }),
  ),
  summary: v.pipe(v.string(), v.description("One or two sentences on the overall state of the change.")),
});

/**
 * The delegate's agent function. Subagents receive no props — a delegate is
 * isolated from its parent by design — so the session context is closed over
 * explicitly at definition time.
 */
function reviewerAgent(instanceId: string) {
  return function CodeReviewer() {
    const env = getSessionEnv(instanceId);
    // A reviewer that reasons harder is worth the tokens: this runs at most
    // once per substantive change, and a missed critical finding costs more.
    useModel(env.modelRef, { thinkingLevel: "high" });
    // Same workspace as the parent, so the reviewer reads the real files rather
    // than a description of them. Read-only in practice — the brief never asks
    // it to write, and its findings go back to the parent to act on.
    useSandbox(local({ cwd: env.cwd, env: env.sandboxEnv }), { cwd: env.cwd });
    useInstruction(REVIEWER_BRIEF);
    return REVIEWER_BRIEF;
  };
}

/** The reviewer, as a `task`-tool delegate. */
export function codeReviewer(instanceId: string) {
  return defineSubagent({
    name: "code-reviewer",
    description:
      "An independent senior engineer who reviews the changes in the working directory with " +
      "fresh eyes — correctness, security, test quality, error handling, API contracts, and " +
      "concurrency. Delegate to this before finishing a substantive change. Returns structured " +
      "findings with severities.",
    agent: reviewerAgent(instanceId),
    thinkingLevel: "high",
  });
}

/**
 * Turn the reviewer on or off mid-conversation.
 *
 * Exposed as a tool rather than a chat directive so it works everywhere Ada is
 * reachable — Slack, the web client, the HTTP API — without each surface having
 * to parse commands. The setter writes Flue persistent state, so the choice is
 * durable for the session and the very next render stops (or starts) mounting
 * the subagent. Flue narrates that resource change to the model, so it knows
 * its capabilities shifted.
 */
export function setReviewMode(setEnabled: (next: boolean) => void) {
  return defineTool({
    name: "set_review_mode",
    description:
      "Enable or disable the independent code-reviewer pass for this conversation. Use when the " +
      "user asks to turn code review on or off, or asks to skip review to move faster.",
    input: v.object({
      enabled: v.pipe(v.boolean(), v.description("true to run the reviewer on substantive changes, false to skip it.")),
    }),
    output: v.object({ enabled: v.boolean() }),
    async run({ data, log }) {
      setEnabled(data.enabled);
      log.info(data.enabled ? "Code review enabled for this session." : "Code review disabled for this session.");
      return { output: { enabled: data.enabled } };
    },
  });
}
