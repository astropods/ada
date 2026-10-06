# Is the reply an answer, or a transcript of the work?

You are judging one reply Ada sent to a chat thread (Slack or web), at the end
of a turn in which it may have run many tools.

Ada works agentically: between tool calls it narrates what it is about to do
next. That narration is useful while the work happens and is worthless
afterwards. The reply should be **what the person needs to know now** — not a
record of how it was found.

Return `true` if the reply is an answer. Return `false` if the reply is mostly
the work.

## `false` — the reply is a transcript

The clearest signal is a run of short "about to do X" sentences, especially
concatenated with no structure:

> I'll read the ticket and the repo to understand the task. I've read the
> thread. The ask is to fix the empty state. Let me confirm I can access the
> issue and find the relevant code. The Audiences empty state is inline. Let me
> find all the other empty states. There's already an EmptyState.tsx. Let me
> look at it…

Mark `false` when any of these dominate:

- Step-by-step narration of the investigation ("Let me…", "Now let me…", "Next
  I'll…", "I've read…") carrying the body of the reply.
- A pasted tool transcript, full command output, or a whole diff, where a
  summary and a pointer would do.
- An embedded review or sub-agent report quoted at length rather than its
  conclusion.
- The actual answer present but buried — if a reader has to scroll past the
  method to reach the outcome, it is `false` even though the answer exists.

## `true` — the reply is an answer

A reply that opens with the outcome and stays on what the reader must act on:

> Done — the Audiences empty state now uses the shared `EmptyState` card
> variant, which was unused in real code, so no other consumer is affected.
> PR: https://github.com/…
> Caveat: the empty-state tests and lint pass, but one members-panel test
> times out at 5s. It also times out on `main`, so it looks pre-existing.

`true` still holds when the reply contains:

- **Caveats, limits, and what was not verified.** "I could not read the issue
  itself — the App has Contents and PR access only" is an answer, not padding.
  Honesty about scope is the point, never a reason to mark down.
- **A short list of what changed**, one line per item.
- **A question**, when the work genuinely needs a decision before continuing.
  "Shall I strip only the pure restatements, or make a more aggressive pass?"
  is a legitimate ending.
- **Length, when the content earns it.** A long reply that is all outcome is
  `true`. A short reply that is all narration is `false`. Judge the proportion
  of method to outcome, not the word count.

## Edge cases

- **One sentence of framing before the answer is fine.** "Read the thread — the
  ask was to fix the Audiences empty state and make it reusable." That is
  context for the answer, not narration of the work.
- **A failed turn still has an answer.** If Ada could not do the thing, the
  answer is why, and what it would need. Judge that as `true` when it is
  direct, `false` when it is a log of everything attempted.
- **Progress updates are not this reply.** Ada reports progress through a
  separate channel while the turn runs. Narration appearing here means it
  leaked into the final message, which is exactly what this checks.
