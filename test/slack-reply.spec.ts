import { test, expect } from "@playwright/test";
import { AdaMessagingAdapter } from "../agent/messaging/adapter.ts";
import { InMemoryStore } from "../agent/store/store.ts";
import type { SessionRunner } from "../agent/session/runner.ts";
import type { StreamHooks, StreamOptions } from "@astropods/adapter-core";
import type { AguiEvent } from "../agent/types/agui.ts";

/**
 * What a chat thread receives from a turn.
 *
 * An agentic run emits an assistant message between every pair of tool calls —
 * "Let me read the ticket…", "Now let me check…". Streaming all of them buried
 * the answer under the narration for the length of the run. Only the last
 * message is the answer; the rest become a transient status.
 */

const text = (id: string, body: string): AguiEvent[] =>
  [
    { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: body },
    { type: "TEXT_MESSAGE_END", messageId: id },
  ] as unknown as AguiEvent[];

const toolCall = (name: string): AguiEvent[] =>
  [{ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: name }] as unknown as AguiEvent[];

function scriptedRunner(events: AguiEvent[]): SessionRunner {
  return {
    async continueSession(
      _id: string,
      _opts: unknown,
      hooks?: { onAguiEvent?: (e: AguiEvent) => void },
    ) {
      for (const e of events) hooks?.onAguiEvent?.(e);
    },
  } as unknown as SessionRunner;
}

function capture() {
  const chunks: string[] = [];
  const statuses: string[] = [];
  const hooks = {
    onChunk(t: string) { chunks.push(t); },
    onStatusUpdate(s: { customMessage?: string }) { if (s.customMessage) statuses.push(s.customMessage); },
    onError() {}, onFinish() {}, onTranscript() {}, onAudioChunk() {}, onAudioEnd() {}, onFile() {},
  } as unknown as StreamHooks;
  return { hooks, chunks, statuses, said: () => chunks.join("") };
}

const opts = (): StreamOptions =>
  ({
    conversationId: "thread-1",
    userId: "U-human",
    platformContext: { messageId: "m", channelId: "C1", botUserId: "U-ada" },
  }) as unknown as StreamOptions;

const RUN: AguiEvent[] = [
  ...text("m1", "Let me read the ticket and the repo to understand the task."),
  ...toolCall("read_file"),
  ...text("m2", "I've read the thread. Let me find the Audiences empty state."),
  ...toolCall("grep"),
  ...text("m3", "Done. Reshaped the shared EmptyState card variant.\nPR: https://example.com/pr/1"),
  { type: "RUN_FINISHED" } as unknown as AguiEvent,
];

test("only the final message reaches the thread", async () => {
  const cap = capture();
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(RUN)).stream("fix this", cap.hooks, opts());

  expect(cap.said(), "the answer is posted").toContain("Reshaped the shared EmptyState card variant");
  expect(cap.said(), "the answer keeps its own formatting").toContain("PR: https://example.com/pr/1");
  // The narration is what made the thread unreadable.
  expect(cap.said()).not.toContain("Let me read the ticket");
  expect(cap.said()).not.toContain("Let me find the Audiences");
});

test("narration is still visible, as a status that the next one replaces", async () => {
  const cap = capture();
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(RUN)).stream("fix this", cap.hooks, opts());

  // Dropping it entirely would leave a long run looking like nothing happened.
  expect(cap.statuses.some((s) => s.startsWith("Let me read the ticket"))).toBe(true);
  expect(cap.statuses, "tool calls still show too").toContain("Using read_file…");
});

test("a run with no tool calls still answers", async () => {
  const cap = capture();
  const only = [...text("m1", "Yes, that endpoint is rate limited."), { type: "RUN_FINISHED" } as unknown as AguiEvent];
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(only)).stream("hi", cap.hooks, opts());
  expect(cap.said()).toContain("that endpoint is rate limited");
});

test("a message left unterminated when the run closes is still the answer", async () => {
  // No TEXT_MESSAGE_END before RUN_FINISHED — otherwise the reply is lost.
  const cap = capture();
  const truncated = [
    { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Partial answer" },
    { type: "RUN_FINISHED" },
  ] as unknown as AguiEvent[];
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(truncated)).stream("hi", cap.hooks, opts());
  expect(cap.said()).toContain("Partial answer");
});

test("a run ending on an empty message falls back to the last real one", async () => {
  const cap = capture();
  const trailing = [
    ...text("m1", "Here is the answer."),
    ...text("m2", "   "),
    { type: "RUN_FINISHED" } as unknown as AguiEvent,
  ];
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(trailing)).stream("hi", cap.hooks, opts());
  expect(cap.said()).toContain("Here is the answer.");
});

test("the follow-along link goes out live, not only with the reply", async () => {
  // `onChunk` accumulates into the reply, which the thread sees only when the
  // turn ENDS — a link delivered that way alone arrived exactly when it had
  // stopped being useful. The status hook is the only one that shows during.
  const cap = capture();
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(RUN)).stream("fix this", cap.hooks, opts());

  expect(cap.statuses[0], "first thing the thread hears").toContain("/watch?link=");
  // And kept in the reply for anyone arriving after the run, since the next
  // status overwrites the live one.
  expect(cap.chunks[0]).toContain("/watch?link=");
});

test("a slow sandbox says so, instead of leaving the thread silent", async () => {
  // A first attach installs the declaration and takes minutes. Without this the
  // user watches an idle thread for all of it.
  const cap = capture();
  const warming = [
    {
      type: "CUSTOM",
      name: "sandbox_warming",
      value: { message: "Starting your sandbox — a first run installs its toolchain." },
    },
    ...text("m1", "Done."),
    { type: "RUN_FINISHED" },
  ] as unknown as AguiEvent[];
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(warming)).stream("hi", cap.hooks, opts());

  expect(cap.statuses.some((s) => s.includes("Starting your sandbox"))).toBe(true);
  // A status, not a chunk: it is progress, and the next one replaces it.
  expect(cap.said()).not.toContain("Starting your sandbox");
});

test("an unrecognised custom event is ignored rather than rendered", async () => {
  const cap = capture();
  const noisy = [
    { type: "CUSTOM", name: "something_else", value: { message: "internal" } },
    ...text("m1", "Done."),
    { type: "RUN_FINISHED" },
  ] as unknown as AguiEvent[];
  await new AdaMessagingAdapter(new InMemoryStore(), scriptedRunner(noisy)).stream("hi", cap.hooks, opts());
  expect(cap.statuses.some((s) => s.includes("internal"))).toBe(false);
});
