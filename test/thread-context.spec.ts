import { test, expect } from "@playwright/test";
import { AdaMessagingAdapter } from "../agent/messaging/adapter.ts";
import { InMemoryStore } from "../agent/store/store.ts";
import type { SessionRunner } from "../agent/session/runner.ts";
import type { StreamHooks, StreamOptions } from "@astropods/adapter-core";

/**
 * Being able to say "Ada fix this" in a thread.
 *
 * The sidecar delivers only the message that triggered the turn. Someone
 * @-mentioning Ada halfway down a Slack thread has usually said everything that
 * matters ABOVE the mention — the error, the link, the decision — and the
 * mention itself is a pronoun. Without the thread Ada has to ask what "this"
 * is, which is the friction the mention was meant to avoid.
 *
 * `options.getThreadHistory()` (adapter-core ≥ 0.10) hydrates the source thread
 * from the platform. These drive the real adapter with a fake sidecar and a
 * stub runner, and assert on the prompt the runner is handed — which is the
 * thing that decides whether the model can resolve "this".
 */

/** Captures the prompt the adapter dispatches, without running an agent. */
function stubRunner(): { runner: SessionRunner; prompts: string[]; titles: (string | undefined)[] } {
  const prompts: string[] = [];
  const titles: (string | undefined)[] = [];
  const runner = {
    async continueSession(_id: string, opts: { prompt: string; meta?: { title?: string } }) {
      prompts.push(opts.prompt);
      titles.push(opts.meta?.title);
    },
  } as unknown as SessionRunner;
  return { runner, prompts, titles };
}

const noopHooks = (): StreamHooks =>
  ({
    onChunk() {},
    onStatusUpdate() {},
    onError() {},
    onFinish() {},
    onTranscript() {},
    onAudioChunk() {},
    onAudioEnd() {},
    onFile() {},
  }) as unknown as StreamHooks;

interface FakeMsg {
  messageId: string;
  user: { id: string; username?: string };
  content: string;
  isDeleted?: boolean;
}

function opts(
  over: Partial<StreamOptions> & { history?: FakeMsg[] | (() => Promise<FakeMsg[]>) } = {},
): StreamOptions {
  const { history, ...rest } = over;
  return {
    conversationId: "thread-1",
    userId: "U-human",
    platformContext: { messageId: "m-trigger", channelId: "C1", botUserId: "U-ada" },
    ...(history
      ? {
          getThreadHistory: async () =>
            typeof history === "function" ? await history() : history,
        }
      : {}),
    ...rest,
  } as unknown as StreamOptions;
}

const THREAD: FakeMsg[] = [
  { messageId: "m1", user: { id: "U-alice", username: "alice" }, content: "The /orders endpoint is 500ing since this morning's deploy" },
  { messageId: "m2", user: { id: "U-bob", username: "bob" }, content: "Looks like the retry wrapper swallows the error" },
  { messageId: "m-ada", user: { id: "U-ada", username: "ada" }, content: "I already replied here earlier" },
  { messageId: "m-trigger", user: { id: "U-human", username: "sam" }, content: "Ada fix this" },
];

test("reads the thread in, so a bare 'fix this' has something to refer to", async () => {
  const { runner, prompts } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);

  await adapter.stream("Ada fix this", noopHooks(), opts({ history: THREAD }));

  expect(prompts).toHaveLength(1);
  const sent = prompts[0];

  // The context that makes the pronoun resolvable.
  expect(sent, "the thread must reach the model").toContain("/orders endpoint is 500ing");
  expect(sent).toContain("retry wrapper swallows the error");
  expect(sent).toContain("alice:");
  // …and the user's actual request is still the request.
  expect(sent.endsWith("Ada fix this"), "the prompt must end with what the user said").toBe(true);

  // Ada's own replies are already in the Flue conversation; echoing them back
  // is the model reading itself.
  expect(sent, "own messages excluded").not.toContain("I already replied here earlier");
  // The triggering message is the prompt — including it would duplicate it.
  expect(sent.match(/Ada fix this/g), "the trigger appears once, as the prompt").toHaveLength(1);
});

test("reads the thread once per conversation, not on every turn", async () => {
  // A Slack thread IS a Flue instance, so after the first turn the conversation
  // history already carries this. Re-reading would resend the same messages and
  // spend the budget twice.
  const { runner, prompts } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);

  await adapter.stream("Ada fix this", noopHooks(), opts({ history: THREAD }));
  await adapter.stream("and add a test", noopHooks(), opts({ history: THREAD }));

  expect(prompts[0]).toContain("<thread>");
  expect(prompts[1], "the second turn must not repeat the thread").not.toContain("<thread>");
  expect(prompts[1]).toBe("and add a test");
});

test("degrades to today's behaviour when the thread cannot be read", async () => {
  // Three ways this legitimately goes missing, and none may cost the user their
  // turn: the message the user actually sent is still there.
  const cases: Array<[string, Partial<StreamOptions> & { history?: never }]> = [
    ["an older sidecar with no getThreadHistory", {}],
  ];
  for (const [label, over] of cases) {
    const { runner, prompts } = stubRunner();
    const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);
    await adapter.stream("Ada fix this", noopHooks(), opts(over));
    expect(prompts[0], label).toBe("Ada fix this");
  }

  // The platform failing to hydrate the thread.
  const { runner: r2, prompts: p2 } = stubRunner();
  const a2 = new AdaMessagingAdapter(new InMemoryStore(), r2);
  await a2.stream(
    "Ada fix this",
    noopHooks(),
    opts({
      history: async () => {
        throw new Error("slack unavailable");
      },
    }),
  );
  expect(p2[0], "a thread fetch failure must not fail the turn").toBe("Ada fix this");

  // A thread with nothing usable in it (only Ada, only the trigger, deletions).
  const { runner: r3, prompts: p3 } = stubRunner();
  const a3 = new AdaMessagingAdapter(new InMemoryStore(), r3);
  await a3.stream(
    "Ada fix this",
    noopHooks(),
    opts({
      history: [
        { messageId: "m-ada", user: { id: "U-ada" }, content: "mine" },
        { messageId: "m-trigger", user: { id: "U-human" }, content: "Ada fix this" },
        { messageId: "m-del", user: { id: "U-alice" }, content: "oops", isDeleted: true },
        { messageId: "m-blank", user: { id: "U-alice" }, content: "   " },
      ],
    }),
  );
  expect(p3[0], "an empty thread adds no block").toBe("Ada fix this");
});

test("caps a long thread instead of letting it dominate the turn", async () => {
  const { runner, prompts } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);

  const long: FakeMsg[] = Array.from({ length: 60 }, (_, i) => ({
    messageId: `m${i}`,
    user: { id: "U-alice", username: "alice" },
    content: `message ${i} `.padEnd(900, "x"),
  }));
  await adapter.stream("Ada fix this", noopHooks(), opts({ history: long }));

  const sent = prompts[0];
  expect(sent.length, "the block is bounded").toBeLessThan(6000);
  // Individually oversized messages are clipped, and the block says so rather
  // than silently dropping the middle.
  expect(sent).toContain("[truncated]");
  expect(sent).toContain("[…earlier messages omitted]");
  // Trimming keeps the NEWEST: the end of a thread is what a mention refers to.
  expect(sent, "the last message survives").toContain("message 59");
  expect(sent, "the oldest is what gets dropped").not.toContain("message 0 ");
});

test("a directive still short-circuits before any thread is read", async () => {
  // `whoami` and friends never reach the model, so reading a thread for them
  // would be a wasted platform round-trip on every one.
  let fetched = 0;
  const { runner, prompts } = stubRunner();
  const adapter = new AdaMessagingAdapter(new InMemoryStore(), runner);

  await adapter.stream(
    "whoami",
    noopHooks(),
    opts({
      history: async () => {
        fetched += 1;
        return THREAD;
      },
    }),
  );
  expect(fetched, "a directive must not fetch the thread").toBe(0);
  expect(prompts, "and must not run a turn").toHaveLength(0);
});
