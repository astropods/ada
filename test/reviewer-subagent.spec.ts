import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { init, useModel, useSandbox, useSubagent } from "@flue/runtime";
import { local, start } from "@flue/runtime/node";
import { codeReviewer } from "../agent/agents/security/reviewer.ts";

/**
 * Actually INVOKES the code-reviewer delegate.
 *
 * This exists because of a bug that shipped: the delegate's render called
 * `useModel()` and `useSandbox()`, both of which Flue rejects inside a subagent
 * render (a delegate declares its model on the `useSubagent()` definition, and
 * inherits the parent's environment). Every existing check passed — the parent
 * rendered fine, typecheck was clean, 32 tests were green — because nothing
 * ever ran the delegate. The failure only appeared when a real conversation
 * called the task tool:
 *
 *     [flue] useModel() is not available in a subagent render.
 *
 * Rendering the parent proves nothing about the child. This drives the actual
 * `task` tool call against a faux provider, so a restricted hook creeping back
 * into the delegate fails here instead of in someone's session.
 */

test("the code-reviewer delegate runs when invoked via the task tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ada-reviewer-"));
  writeFileSync(join(dir, "subject.ts"), "export const add = (a: number, b: number) => a + b;\n");

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  });

  // 1. the parent delegates -> 2. the delegate answers -> 3. the parent wraps up
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "task",
          { agent: "code-reviewer", description: "review the change", prompt: "Review subject.ts", cwd: dir },
          { id: "call_task" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("No findings. The change is sound.")], { stopReason: "stop" }),
    fauxAssistantMessage([fauxText("Review came back clean.")], { stopReason: "stop" }),
  ]);

  // A minimal parent: just enough to mount the delegate under test.
  function Host() {
    useModel("faux/faux-1");
    useSandbox(local({ cwd: dir, env: {} }), { cwd: dir });
    useSubagent(codeReviewer);
    return "You are a host agent. Delegate review work to the code-reviewer.";
  }
  Host.agentName = "reviewer-host";

  const flue = await start({ agents: [Host], providers: [faux.provider] });
  try {
    const handle = init(Host, { id: "reviewer-host-1" });
    const reply = await handle.read(await handle.dispatch("Review the change."));

    // The delegate must have actually run: a restricted hook inside it surfaces
    // as a task-tool error, not a rejected dispatch, so assert on the content.
    expect(reply.text).not.toContain("not available in a subagent render");
    expect(reply.text).toContain("Review came back clean");

    // All three scripted responses consumed = parent, delegate, parent.
    expect(faux.getPendingResponseCount(), "the delegate consumed a model turn").toBe(0);
  } finally {
    await flue.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the delegate's render declares no hooks Flue forbids in a subagent", async () => {
  // A static guard alongside the runtime one: these ten hooks are rejected
  // inside a delegate render, and the failure mode is a task-tool error deep in
  // a live conversation. Cheap to assert, so assert it.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../agent/agents/security/reviewer.ts", import.meta.url), "utf8"),
  );
  const forbidden = [
    "useModel",
    "useSandbox",
    "usePersistentState",
    "useAgentStart",
    "useAgentFinish",
    "useDataWriter",
    "useDispatchMessage",
    "useResponseStart",
    "useResponseFinish",
    "useMcpConnection",
  ];
  // Strip comments first — the module documents these by name on purpose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const hook of forbidden) {
    expect(code, `${hook}() must not be called in the delegate`).not.toContain(`${hook}(`);
  }
});
