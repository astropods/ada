import { test, expect } from "@playwright/test";
import http from "node:http";

/**
 * Server-side counterparts to the client tests, using the test-only POST /test/seed
 * hook (ADA_TEST_HOOKS=1) to build a finished, replayable session without a model
 * call. Covers the resume-precedence fix (Last-Event-ID header beats the sticky
 * ?lastEventId query) and the DELETE /sessions/:id semantics.
 */

const BASE = `http://localhost:${process.env.PORT ?? 8123}`;

/** Open an SSE connection, collect the initial replay burst, then tear it down.
 *  (The endpoint stays open with heartbeats, so we can't await the full body.) */
function collectSse(path: string, headers: Record<string, string>, ms = 700): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, { headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c.toString()));
      const timer = setTimeout(() => {
        req.destroy();
        resolve(buf);
      }, ms);
      res.on("end", () => {
        clearTimeout(timer);
        resolve(buf);
      });
    });
    req.on("error", reject);
  });
}

test("SSE resume prefers the Last-Event-ID header over the ?lastEventId query", async ({ request }) => {
  const seed = await (await request.post("/test/seed")).json();
  expect(seed.lastSeq).toBeGreaterThan(10);

  // Header (10) must win over the sticky query (-1): only seq > 10 replay. This is
  // the exact reconnect scenario — a stale ?lastEventId=-1 in the URL plus a live
  // Last-Event-ID header — that previously re-replayed the whole log.
  const resumed = await collectSse(`/sessions/${seed.sessionId}/events?lastEventId=-1`, {
    "Last-Event-ID": "10",
  });
  expect(resumed).toContain("id: 11");
  expect(resumed).toContain(`id: ${seed.lastSeq}`);
  expect(resumed).not.toMatch(/\bid: 1\n/);
  expect(resumed).not.toMatch(/\bid: 10\n/);

  // Control: a fresh connection with no header replays everything (id: 1 present).
  const full = await collectSse(`/sessions/${seed.sessionId}/events?lastEventId=-1`, {});
  expect(full).toMatch(/\bid: 1\n/);
});

test("DELETE /sessions/:id drops the session (204, then 404) and events 404 afterwards", async ({ request }) => {
  const seed = await (await request.post("/test/seed")).json();

  expect((await request.delete(`/sessions/${seed.sessionId}`)).status()).toBe(204);
  expect((await request.delete(`/sessions/${seed.sessionId}`)).status()).toBe(404);
  expect((await request.get(`/sessions/${seed.sessionId}/events`)).status()).toBe(404);
});

test("POST /test/seed returns a finished, replayable session", async ({ request }) => {
  const res = await request.post("/test/seed");
  expect(res.status()).toBe(201);
  const seed = await res.json();
  expect(seed.sessionId).toMatch(/^sess_seed_/);
  expect(seed.lastSeq).toBe(23); // the recorded fixture yields 23 AG-UI events

  /**
   * FINISHED means the AG-UI run is CLOSED, not just that the fixture ran out.
   *
   * The count alone used to be the whole assertion, and it drifted to 22
   * without anyone being able to tell whether the translator had regressed or
   * the recording was incomplete. It was the recording: the fixture ended at
   * `agent_end` with no `submission_settled`, and `agent_end` deliberately does
   * NOT end the run (a useAgentFinish gate may send the model straight back).
   * So the seeded run stayed open and a client replaying it would wait forever
   * for a terminal event.
   *
   * Asserting the terminal event is what makes the number meaningful, so this
   * pins the property and lets the count stay as a cheap tripwire.
   */
  const replay = await collectSse(`/sessions/${seed.sessionId}/events`, {});
  expect(replay, "the run must be closed, not merely out of events").toContain("RUN_FINISHED");
  expect(replay).not.toContain("RUN_ERROR");
  // …and it must be LAST: a terminal event mid-stream would mean the run closed
  // early and the rest of the turn streamed into a run the client had ended.
  const types = [...replay.matchAll(/"type":"(RUN_\w+)"/g)].map((m) => m[1]);
  expect(types).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
});
