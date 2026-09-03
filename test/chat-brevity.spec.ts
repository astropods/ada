import { test, expect } from "@playwright/test";
import { getSessionEnv, setSessionEnv } from "../agent/agents/session-env.ts";

/**
 * Ada answers Slack more briefly than the web client.
 *
 * Feedback was that Slack replies are a wall of text. The cause is not how the
 * adapter renders — it forwards every TEXT_MESSAGE_CONTENT delta verbatim, and
 * should — but what the model writes. So the fix is in the prompt, and the
 * prompt needs to know which surface it is writing for.
 *
 * Two things can silently undo that, and both are what these cover:
 *
 *   - The surface never reaching the prompt at all.
 *   - It reaching the FIRST turn only. A browser follow-up sends no `meta`, so
 *     deriving the surface from the turn's own options would quietly revert
 *     every message after the first — the failure would look like "it works,
 *     then stops working", which is the worst kind to debug.
 *
 * The wording itself is a prompt and not assertable here; what is assertable is
 * that it is applied to Slack, withheld from the browser, and durable across
 * turns.
 */

test("the brevity instruction is applied for Slack and withheld from the browser", async () => {
  const { Ada } = await import("../agent/agents/ada.ts");
  expect(typeof Ada, "the agent module must load").toBe("function");

  // The instruction text lives in the module; assert the contract it encodes
  // rather than the prose, so rewording it does not fail the test.
  const src = await (await import("node:fs/promises")).readFile("agent/agents/ada.ts", "utf8");
  expect(src, "brevity must be conditional on the surface").toMatch(
    /env\.surface === "slack"[\s\S]{0,40}useInstruction\(CHAT_BREVITY\)/,
  );
  // Brevity must never become a licence to hide a failure.
  expect(src, "the instruction must protect candour explicitly").toMatch(
    /Still say plainly what failed/,
  );
});

test("surface survives into the session env and defaults to browser", () => {
  setSessionEnv("brevity-a", {
    modelRef: "m",
    cwd: "/tmp",
    sandboxEnv: {},
    githubConfigured: false,
    githubConnected: false,
    surface: "slack",
  });
  expect(getSessionEnv("brevity-a").surface).toBe("slack");

  // A render with no published context (Flue recovering an interrupted
  // submission after a restart) must not crash, and must not accidentally be
  // treated as Slack.
  expect(getSessionEnv("brevity-never-set").surface).toBeUndefined();
});

test("the runner derives the surface from the registry, not the turn", async () => {
  // A browser FOLLOW-UP carries no meta, so reading the surface from the turn's
  // options would make Ada verbose again from the second message on. The
  // registry holds the session's kind for its whole life, which is why it is
  // the source.
  const src = await (await import("node:fs/promises")).readFile(
    "agent/session/runner.ts",
    "utf8",
  );
  expect(src).toMatch(/surface:\s*this\.registry\.kind\(instanceId\)\s*\?\?\s*"browser"/);
});

test("a Slack thread is recorded as kind slack, which is what drives brevity", async () => {
  const { SessionRegistry } = await import("../agent/session/registry.ts");
  const registry = new SessionRegistry();

  registry.ensure("thread-1");
  registry.setMeta("thread-1", { kind: "slack", userId: "U123" });
  expect(registry.kind("thread-1")).toBe("slack");

  registry.ensure("web-1");
  registry.setMeta("web-1", { kind: "browser", userId: "u" });
  expect(registry.kind("web-1")).toBe("browser");

  // Unknown → the runner's `?? "browser"` applies, i.e. no brevity. Erring
  // toward the fuller answer is the right default: a too-long reply is a
  // nuisance, a silently truncated one loses information.
  expect(registry.kind("never-seen")).toBeUndefined();
});
