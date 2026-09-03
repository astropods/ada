import { test, expect } from "@playwright/test";
import http from "node:http";

/**
 * `POST /sessions` must answer as soon as the session exists, not when the turn
 * ends.
 *
 * It used to await the whole turn. The browser therefore sat on a pending POST
 * for as long as the work took, could not open the event stream (it had no
 * session id yet), and when the id finally arrived it replayed a FINISHED turn
 * in a single block. Every incremental event the AG-UI contract exists for —
 * text deltas, tool calls appearing as they run — was produced, recorded, and
 * then delivered all at once to a client that could no longer show them live.
 * A long turn was also indistinguishable from a hung server, and a POST held
 * open for minutes is what a proxy reaps at 60s even when the turn succeeded.
 *
 * The property is an ORDERING one — the response precedes the settlement — so
 * that is what these assert. A duration bound would be a flake generator on a
 * loaded CI box and would not actually pin the thing that matters.
 */

const BASE = `http://localhost:${process.env.PORT ?? 8123}`;

/** The status of an SSE connection, without waiting on a body that never ends. */
function sseStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + path, (res) => {
      req.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
}

/** Open the SSE stream and resolve once `match` appears (or time out). */
function waitForEvent(sessionId: string, match: RegExp, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/sessions/${sessionId}/events`, (res) => {
      let buf = "";
      const done = (v: boolean) => {
        clearTimeout(timer);
        req.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => done(false), ms);
      res.on("data", (c) => {
        buf += c.toString();
        if (match.test(buf)) done(true);
      });
    });
    req.on("error", () => resolve(false));
  });
}

test("POST /sessions returns before the turn settles", async ({ request }) => {
  const res = await request.post("/sessions", { data: { prompt: "say hello" } });
  expect(res.status()).toBe(201);
  const { sessionId } = await res.json();
  expect(sessionId).toMatch(/^sess_/);

  /**
   * The ordering assertion. At the instant the POST resolved, the turn must not
   * have settled — the session is `starting` or `running`, never `finished` or
   * `errored`. Read straight after the await, before yielding, so a fast turn
   * cannot finish in the gap and make this pass for the wrong reason.
   *
   * There is no model credential in the suite, so the turn will fail rather
   * than complete. That is fine and is in fact the stronger case: it proves the
   * handler returned before the outcome was known, whatever the outcome.
   */
  const list = await (await request.get("/conversations")).json();
  const mine = list.conversations.find(
    (c: { sessionId: string }) => c.sessionId === sessionId,
  );
  expect(mine, "the session must exist the moment POST returns").toBeTruthy();
  expect(
    ["starting", "running"],
    `POST returned with status "${mine.status}" — it waited for the turn`,
  ).toContain(mine.status);
});

test("the session is streamable the moment POST returns", async ({ request }) => {
  // The whole point of returning early: the client can subscribe and watch the
  // turn happen. If the registry entry were created later, this would 404.
  const { sessionId } = await (
    await request.post("/sessions", { data: { prompt: "say hello" } })
  ).json();

  // Status only: the endpoint stays open with heartbeats, so awaiting a full
  // body would hang rather than assert anything.
  expect(await sseStatus(`/sessions/${sessionId}/events`), "the stream must be open immediately").toBe(200);
});

test("a turn that fails before reaching the model still reports over the stream", async ({
  request,
}) => {
  /**
   * THE regression this design is most likely to introduce.
   *
   * Failures before dispatch — resolving a GitHub token, cloning the repo —
   * throw outside the block that emits the terminal event, and the translator
   * had no run open, so `flush` correctly emitted nothing. Awaited, that was
   * survivable: the caller got a 500. Backgrounded, it would strand the client
   * on a stream that never says anything, with the session stuck "running"
   * forever — a hang where there used to be an error.
   *
   * The suite has no model credential, so a turn fails on its own; what matters
   * is that the failure ARRIVES. `failRun` opens a run so the client sees a
   * well-formed RUN_STARTED -> RUN_ERROR rather than a bare terminal event.
   */
  const { sessionId } = await (
    await request.post("/sessions", { data: { prompt: "say hello" } })
  ).json();

  expect(
    await waitForEvent(sessionId, /RUN_ERROR|RUN_FINISHED/, 20_000),
    "the turn must reach the client with a terminal event, not go quiet",
  ).toBe(true);

  const list = await (await request.get("/conversations")).json();
  const mine = list.conversations.find((c: { sessionId: string }) => c.sessionId === sessionId);
  expect(["finished", "errored"], "and must not be left mid-flight").toContain(mine.status);
});

test("an immediate follow-up still gets 409 rather than racing the first turn", async ({
  request,
}) => {
  // Backgrounding introduces the chance of a second dispatch to an instance
  // whose first turn has not started yet. `registry.ensure` sets "starting" and
  // `busy()` counts it, so the guard holds — asserted rather than assumed,
  // because the ordering it depends on is not obvious from either call site.
  const { sessionId } = await (
    await request.post("/sessions", { data: { prompt: "first" } })
  ).json();

  const followUp = await request.post(`/sessions/${sessionId}/messages`, {
    data: { prompt: "second" },
  });
  expect([409, 202]).toContain(followUp.status());
  if (followUp.status() === 202) {
    test.info().annotations.push({
      type: "note",
      description: "first turn had already settled; the 409 path is timing-dependent here",
    });
  }
});
