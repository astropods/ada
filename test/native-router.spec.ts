import { test, expect } from "@playwright/test";

/**
 * Flue's native router may READ a conversation. It may not START a turn.
 *
 * `POST /agents/ada/:id` is Flue's prompt dispatch, and it renders the agent
 * without going through SessionRunner. `session-env.ts` is process-local and
 * published by the runner immediately before it dispatches, so a render that
 * skips the runner finds nothing and falls back — which used to mean
 * `local({ cwd: process.cwd() })`. A turn started here ran the model's shell and
 * file tools in the CONTROL PLANE container, on its own source tree, with no
 * per-conversation workspace and none of the sandbox isolation, even with a
 * sandbox container deployed.
 *
 * Both doors are covered here, because closing one would have left the other:
 *
 *   1. The route itself now refuses dispatch (this file's first tests).
 *   2. The FALLBACK is hardened, since a recovery render — the reason that
 *      function exists — reaches it without any HTTP request at all. When a
 *      sandbox is deployed it is now selected, so a context-less render is
 *      degraded in capability, not in containment.
 */

test("refuses native prompt dispatch and says where to go instead", async ({ request }) => {
  const res = await request.post("/agents/ada/sess_native_dispatch", {
    data: { message: "run something in the control plane" },
  });

  expect(res.status(), "dispatch must be refused, not served").toBe(405);
  const body = await res.json();
  // The message has to be actionable: a client hitting this needs to know the
  // supported path, not just that it was refused.
  expect(body.detail).toContain("POST /sessions");
  expect(body.detail).toContain("/sessions/:id/events");
  expect(body.detail, "and why, so it does not read as an arbitrary block").toContain(
    "no sandbox isolation",
  );
});

test("still allows the reads and the abort the router is documented for", async ({ request }) => {
  // Only dispatch is refused. Removing more would break the documented value of
  // the second front door — that a session started over one is readable over
  // the other — for no security gain.
  const read = await request.get("/agents/ada/sess_native_read");
  expect(read.status(), "conversation read must not be refused by our rule").not.toBe(405);

  // `:id` matches a single segment, so the sub-routes are untouched.
  const abort = await request.post("/agents/ada/sess_native_read/abort");
  expect(abort.status(), "abort must not be caught by the dispatch refusal").not.toBe(405);
});

test("a context-less render selects the sandbox when one is deployed", async () => {
  /**
   * The second door. No HTTP involved: Flue recovers interrupted submissions
   * after a restart and renders before any handler has published a context.
   *
   * The assertion that matters is `remote` being set — that is what makes
   * `ada.ts` mount the isolated sandbox instead of `local()`. `cwd` staying at
   * process.cwd() is fine and unused in that branch.
   */
  const { getSessionEnv } = await import("../agent/agents/session-env.ts");

  const prior = process.env.KNOWLEDGE_SANDBOX_HOST;
  try {
    process.env.KNOWLEDGE_SANDBOX_HOST = "sandbox-host";
    const env = getSessionEnv("sess-never-published");
    expect(env.remote, "must not fall back to in-process execution").toBeTruthy();
    expect(env.remote?.baseUrl).toBe("http://sandbox-host:3000");
    // Capability is degraded, containment is not: no credential is resolved on
    // this path, and none may be invented.
    expect(env.githubConnected).toBe(false);
    expect(env.githubConfigured).toBe(false);
    expect(env.sandboxEnv.GH_TOKEN, "no token on a context-less render").toBeUndefined();
  } finally {
    if (prior === undefined) delete process.env.KNOWLEDGE_SANDBOX_HOST;
    else process.env.KNOWLEDGE_SANDBOX_HOST = prior;
  }
});

test("with no sandbox deployed the fallback is local, which is the dev posture", async () => {
  // Not a regression: with nothing to select there is no isolation to be had,
  // and process.cwd() is what `node agent/index.ts` and `flue run` intend on a
  // developer's machine. Pinned so the two modes stay distinguishable.
  const { getSessionEnv } = await import("../agent/agents/session-env.ts");

  const prior = process.env.KNOWLEDGE_SANDBOX_HOST;
  try {
    delete process.env.KNOWLEDGE_SANDBOX_HOST;
    const env = getSessionEnv("sess-never-published-local");
    expect(env.remote).toBeUndefined();
    expect(env.cwd).toBe(process.cwd());
  } finally {
    if (prior !== undefined) process.env.KNOWLEDGE_SANDBOX_HOST = prior;
  }
});

test("the agent mounts the remote sandbox whenever the context names one", async () => {
  // Ties the two halves together: hardening the fallback only helps because
  // ada.ts branches on `env.remote`. If that branch changed, the fallback would
  // go back to executing in the control plane without any test noticing.
  const src = await (await import("node:fs/promises")).readFile("agent/agents/ada.ts", "utf8");

  // Ordering rather than proximity: the branch carries comments, and a
  // character-distance regex would break every time they are edited.
  const guard = src.indexOf("if (env.remote)");
  const mountRemote = src.indexOf("useSandbox(remote(");
  const elseBranch = src.indexOf("} else {", guard);
  const mountLocal = src.indexOf("useSandbox(local(");

  expect(guard, "the remote branch must be guarded on env.remote").toBeGreaterThan(-1);
  expect(mountRemote, "remote() is mounted inside that guard").toBeGreaterThan(guard);
  expect(mountRemote, "…and before the else").toBeLessThan(elseBranch);
  expect(mountLocal, "local() only ever in the else branch").toBeGreaterThan(elseBranch);
});
