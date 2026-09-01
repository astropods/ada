import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { persistenceMode, postgresAdapter, sqlitePath } from "../agent/db.ts";
import { sweepWorkspaces } from "../agent/session/workspace.ts";
import { pgConfig, postgresConfigured, describePg } from "../agent/store/pg-config.ts";

/**
 * Durable conversation storage.
 *
 * The property under test is the one that was broken: a conversation must
 * survive a restart. Before this, Flue's SQLite file sat on the control-plane
 * container, which has no volume — so a resumed Slack thread kept its repo
 * checkout (on the sandbox volume) and lost every message.
 *
 * Split deliberately in two:
 *
 *   - The SELECTION and CONFIG tests always run. Choosing SQLite when a
 *     database was injected is a silent data-loss bug, and it needs no
 *     infrastructure to catch.
 *   - The RESTART test needs a real Postgres, because the thing worth proving
 *     is that history comes back through actual SQL, and a mocked driver would
 *     prove only that the mock works. It is opt-in via ADA_TEST_POSTGRES_HOST
 *     rather than skipped silently on failure — a conditional that hides a
 *     genuine breakage is worse than no test.
 *
 *     To run it:
 *       docker run -d --name ada-pg -e POSTGRES_PASSWORD=test \
 *         -e POSTGRES_USER=ada -e POSTGRES_DB=ada -p 55432:5432 postgres:16-alpine
 *       ADA_TEST_POSTGRES_HOST=127.0.0.1 ADA_TEST_POSTGRES_PORT=55432 \
 *         ADA_TEST_POSTGRES_USER=ada ADA_TEST_POSTGRES_PASSWORD=test \
 *         ADA_TEST_POSTGRES_DB=ada npx playwright test test/persistence.spec.ts
 */

test("uses Postgres when the platform injects one, SQLite otherwise", () => {
  expect(persistenceMode({}), "no database -> local SQLite").toBe("sqlite");
  expect(persistenceMode({ POSTGRES_HOST: "db" }), "injected -> durable Postgres").toBe("postgres");
  // The platform has injected both spellings depending on how the store is
  // declared; missing the second would silently downgrade to SQLite.
  expect(persistenceMode({ KNOWLEDGE_DB_HOST: "db" })).toBe("postgres");
});

test("keeps the local database out of the swept workspace namespace", () => {
  /**
   * The local SQLite database used to sit at `${WORKSPACE_ROOT}/ada-flue.db`,
   * and the per-session workspace GC reclaims entries under WORKSPACE_ROOT that
   * begin with `ada-` and are older than its TTL. `ada-flue.db` begins with
   * `ada-`. So a deployment idle past the TTL deleted its own conversation
   * history — the exact durability this module exists to provide, removed by
   * another module's housekeeping.
   */
  const root = mkdtempSync(join(tmpdir(), "ada-dbpath-"));
  try {
    const path = sqlitePath({ WORKSPACE_ROOT: root });
    const relative = path.slice(root.length + 1);
    const firstSegment = relative.split(sep)[0];

    expect(firstSegment, "must not sit in the swept `ada-` namespace").not.toMatch(/^ada-/);
    expect(relative, "should live in its own subdirectory").toBe(join("db", "ada-flue.db"));
    expect(existsSync(dirname(path)), "the directory is created eagerly").toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps using a database already at the old location", () => {
  // Preferring the new path unconditionally would orphan an existing
  // deployment's history — still on disk, but with an empty database started
  // beside it. That is the same data loss, arriving on upgrade instead of on
  // idle.
  const root = mkdtempSync(join(tmpdir(), "ada-dblegacy-"));
  try {
    const legacy = join(root, "ada-flue.db");
    writeFileSync(legacy, "existing history");
    expect(sqlitePath({ WORKSPACE_ROOT: root })).toBe(legacy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit ADA_DB_PATH still wins", () => {
  expect(sqlitePath({ ADA_DB_PATH: "/tmp/explicit.db", WORKSPACE_ROOT: "/tmp/ignored" })).toBe(
    "/tmp/explicit.db",
  );
});

test("the workspace GC reclaims stale workspaces but never the database", () => {
  // The end-to-end property, asserted against the real sweep rather than by
  // reading the prefix logic: both halves of the fix have to hold together.
  const root = mkdtempSync(join(tmpdir(), "ada-gc-"));
  try {
    // A database at the LEGACY path — the case the sweep guard has to cover,
    // since that is where an existing deployment's data actually is.
    const dbFiles = ["ada-flue.db", "ada-flue.db-wal", "ada-flue.db-shm", "ada-flue.db-journal"];
    for (const f of dbFiles) writeFileSync(join(root, f), "conversation history");
    const stale = mkdtempSync(join(root, "ada-"));
    writeFileSync(join(stale, "checkout.txt"), "a repo checkout");

    // Age everything past the cutoff.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const f of dbFiles) utimesSync(join(root, f), old, old);
    utimesSync(stale, old, old);

    const removed = sweepWorkspaces(24 * 60 * 60 * 1000, Date.now(), root);

    expect(removed, "only the workspace directory is reclaimed").toBe(1);
    expect(existsSync(stale), "the stale workspace is still collected").toBe(false);
    for (const f of dbFiles) {
      expect(existsSync(join(root, f)), `${f} must survive the sweep`).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads one connection config for both Flue and Ada's own store", () => {
  const env = {
    POSTGRES_HOST: "db",
    POSTGRES_PORT: "6543",
    POSTGRES_USER: "ada",
    POSTGRES_PASSWORD: "secret",
    POSTGRES_DB: "adadb",
  };
  expect(pgConfig(env)).toEqual({
    host: "db",
    port: 6543,
    user: "ada",
    password: "secret",
    database: "adadb",
  });
  // Postgres's own convention, and what this deployment has always done.
  expect(pgConfig({ POSTGRES_HOST: "db", POSTGRES_USER: "ada" }).database).toBe("ada");
  expect(postgresConfigured({})).toBe(false);
  // A startup log must never carry the password.
  expect(describePg(env)).toContain("ada@db:6543/adadb");
  expect(describePg(env)).not.toContain("secret");
});

const PG_HOST = process.env.ADA_TEST_POSTGRES_HOST;

test.describe("against a real Postgres", () => {
  test.skip(!PG_HOST, "set ADA_TEST_POSTGRES_HOST to run (see the note at the top of this file)");

  test("a conversation survives a full restart", async () => {
    // Point the adapter at the test database.
    Object.assign(process.env, {
      POSTGRES_HOST: PG_HOST,
      POSTGRES_PORT: process.env.ADA_TEST_POSTGRES_PORT ?? "5432",
      POSTGRES_USER: process.env.ADA_TEST_POSTGRES_USER,
      POSTGRES_PASSWORD: process.env.ADA_TEST_POSTGRES_PASSWORD,
      POSTGRES_DB: process.env.ADA_TEST_POSTGRES_DB,
    });

    const { fauxProvider, fauxAssistantMessage, fauxText } = await import(
      "@earendil-works/pi-ai/providers/faux"
    );
    const { init, observe, useModel } = await import("@flue/runtime");
    const { start } = await import("@flue/runtime/node");

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "f1", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    function Probe() {
      useModel("faux/f1");
      return "You are a test agent.";
    }
    Probe.agentName = "persist-probe";

    const instanceId = `conv-${Math.random().toString(36).slice(2, 10)}`;

    /** One process lifetime: fresh adapter, fresh runtime, same instance id. */
    async function runTurn(message: string): Promise<string> {
      let sent: Array<{ content?: unknown }> = [];
      const unobserve = observe((e) => {
        if (e.type === "turn_request") sent = (e.request?.input?.messages ?? []) as typeof sent;
      });
      // A NEW adapter every time — this is what makes it a restart rather than
      // a second turn on a warm runtime.
      const flue = await start({ agents: [Probe], db: postgresAdapter(), providers: [faux.provider] });
      try {
        faux.setResponses([fauxAssistantMessage([fauxText(`ack: ${message}`)], { stopReason: "stop" })]);
        const handle = init(Probe, { id: instanceId });
        await handle.read(await handle.dispatch(message));
      } finally {
        await flue.stop();
        unobserve();
      }
      return sent
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ text?: string }>) : []))
        .map((c) => c.text)
        .filter(Boolean)
        .join(" | ");
    }

    const first = await runTurn("remember the number 4172");
    expect(first, "a new conversation starts empty").not.toContain("4172 | ");

    const second = await runTurn("what number did I ask you to remember?");
    expect(second, "the earlier turn is replayed to the model after a restart").toContain("4172");
  });
});
