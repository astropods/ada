import { test, expect } from "@playwright/test";
import { INVESTIGATE_CI_FAILURE, WORKFLOW_SKILLS } from "../agent/agents/ci-skills.ts";

/**
 * A skill is prompt text, so there is no behaviour to assert — what CAN be
 * asserted is the economics the layering depends on, and the few specifics
 * that are load-bearing because they encode constraints the model cannot infer
 * from the repo it is pointed at.
 */

test("the description is what pays for the body, so it stays one line", () => {
  // Only the description sits in the prompt permanently. A long one would cost
  // tokens on every turn, which is the thing skills exist to avoid.
  const { description, instructions } = INVESTIGATE_CI_FAILURE;
  expect(description.length, "catalog line").toBeLessThan(320);
  expect(instructions.length, "the body is free until activated").toBeGreaterThan(description.length * 4);
});

test("the description names the trigger in the words a user would use", () => {
  // The model matches on this to decide the skill applies at all.
  const d = INVESTIGATE_CI_FAILURE.description.toLowerCase();
  for (const word of ["build", "workflow", "check", "pipeline", "fail"]) {
    expect(d, `a user says "${word}"`).toContain(word);
  }
});

test("it carries the two constraints the model cannot work out for itself", () => {
  const body = INVESTIGATE_CI_FAILURE.instructions;
  // Ada's sandbox caps command output at ~1 MiB, so a full CI log comes back a
  // truncated prefix of setup steps. Nothing in a repo tells the model that.
  expect(body).toContain("--log-failed");
  expect(body).toMatch(/1\s*MiB/);
  // And the "View workflow" button in a chat notification is an HTML page
  // behind auth, not a log.
  expect(body).toContain("gh run list");
  expect(body.toLowerCase()).toContain("do not fetch the run's web url".toLowerCase());
});

test("it says what the wrong answer looks like, not just the right one", () => {
  // The authoring rule from security/skills.ts: a labelled anti-pattern is the
  // most reliable way to steer a model away from one.
  const body = INVESTIGATE_CI_FAILURE.instructions.toLowerCase();
  expect(body).toContain("pre-existing");
  expect(body, "a timeout is not a defect in the change").toContain("environmental");
  expect(body, "re-running burns minutes and proves nothing").toContain("rerun");
});

test("it is registered, or it is just a file", () => {
  expect(WORKFLOW_SKILLS).toContain(INVESTIGATE_CI_FAILURE);
  expect(INVESTIGATE_CI_FAILURE.name).toBe("investigate-ci-failure");
});
