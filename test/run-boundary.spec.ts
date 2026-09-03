import { test, expect } from "@playwright/test";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { init, observe, useAgentFinish, useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { Translator } from "../agent/translate/translator.ts";
import { EventType } from "../agent/types/agui.ts";

/**
 * An AG-UI run must span one DELIVERY, not one agent segment.
 *
 * `agent_end` fires at every would-stop point, and a `useAgentFinish` hook that
 * appends a signal — exactly what the security gates do — starts a fresh
 * `agent_start`/`agent_end` pair within the same delivery. Closing the run on
 * `agent_end` therefore ended it while the agent was still working. In
 * production that looked like: the AG-UI client showed the conversation
 * finished, Ada posted its reply to Slack, and then carried on writing into the
 * thread it had already closed.
 *
 * The delivery boundary is `submission_settled` — exactly once, last.
 */

test("a gate sending the model back does not end the run early", async () => {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "f1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  faux.setResponses([
    fauxAssistantMessage([fauxText("first pass. ")], { stopReason: "stop" }),
    fauxAssistantMessage([fauxText("second pass after the gate.")], { stopReason: "stop" }),
  ]);

  let gateFired = 0;
  function Host() {
    useModel("faux/f1");
    useAgentFinish((ctx) => {
      // One nudge, like an advisory security gate.
      if (gateFired++ === 0) ctx.append({ kind: "signal", type: "gate", body: "Not done — keep going." });
    });
    return "host";
  }
  Host.agentName = "boundary-host";

  const translator = new Translator({ includeRawEvent: false });
  const emitted: string[] = [];
  const unobserve = observe((e) => {
    if (e.instanceId !== "b1") return;
    for (const a of translator.handle(e)) emitted.push(a.type);
  });

  const flue = await start({ agents: [Host], providers: [faux.provider] });
  try {
    const handle = init(Host, { id: "b1" });
    await handle.read(await handle.dispatch("go"));
  } finally {
    await flue.stop();
    unobserve();
  }

  const starts = emitted.filter((t) => t === EventType.RUN_STARTED).length;
  const finishes = emitted.filter((t) => t === EventType.RUN_FINISHED).length;

  // The regression: two of each, because agent_end fired twice.
  expect(starts, "one RUN_STARTED per delivery").toBe(1);
  expect(finishes, "one RUN_FINISHED per delivery").toBe(1);

  // And nothing may follow the close — this is what leaked into Slack.
  const last = emitted.lastIndexOf(EventType.RUN_FINISHED);
  expect(emitted.slice(last + 1), "RUN_FINISHED is the final event").toEqual([]);

  // Both passes of the agent's text must still reach the client.
  const chunks = emitted.filter((t) => t === EventType.TEXT_MESSAGE_CONTENT).length;
  expect(chunks, "text from both segments is streamed").toBeGreaterThanOrEqual(2);
});

test("a run that never settles is still closed by the flush", async () => {
  // Safety net for the reverse failure: if `submission_settled` never reaches
  // the observer, a client would wait forever on a run that never ends. The
  // runner calls flush() once read() returns.
  const translator = new Translator({ includeRawEvent: false });
  translator.handle({
    v: 3, eventIndex: 0, timestamp: "2026-01-01T00:00:00.000Z",
    instanceId: "x1", type: "agent_start",
  } as never);

  const flushed = translator.flush("completed");
  expect(flushed.map((e) => e.type)).toContain(EventType.RUN_FINISHED);
  // Idempotent — the runner flushes unconditionally, so a normally-settled run
  // must not get a second terminal event.
  expect(translator.flush("completed"), "flush is idempotent").toEqual([]);
});
