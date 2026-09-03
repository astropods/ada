/**
 * Persistence entry — where Flue keeps durable conversation state.
 *
 * This is what makes a follow-up turn work: Flue keys an instance's message
 * history, submission log, and settled replies off the instance id, so a
 * session resumed later continues where it left off. It replaces the old
 * `claudeSessionIds` map (bridge id -> Claude session id, in memory, lost on
 * restart) and the `--resume` flag that map fed.
 *
 * POSTGRES when the platform injects one, SQLite otherwise.
 *
 * The Postgres path is what makes conversations survive a restart or redeploy —
 * previously the SQLite file sat on the control-plane container, which has no
 * volume, so a resumed Slack thread kept its repo checkout (on the sandbox
 * volume) but lost its history. It uses `@flue/postgres`, the framework's own
 * adapter, which owns its schema: seven `flue_`-prefixed tables created and
 * version-checked by `migrate()`, which the runtime calls at startup. Nothing
 * here writes DDL.
 *
 * The driver is deliberately ours. `@flue/postgres` takes a runner rather than
 * bundling a client, so pooling, TLS, and timeouts stay under this project's
 * control — and it uses the same connection settings as Ada's own `Store`
 * (agent/store/pg-config.ts), against the same database. Flue's tables are
 * `flue_`-prefixed and Ada's are not, so they coexist.
 *
 * SQLite remains the local default: `flue run` and `node agent/index.ts` work
 * with no database. Point ADA_DB_PATH or WORKSPACE_ROOT at a persistent volume
 * if you want local conversations to survive a restart.
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "@flue/runtime/node";
import { postgres, type PostgresParameter, type PostgresQuery } from "@flue/postgres";
import type { PersistenceAdapter } from "@flue/runtime/adapter";
import { pgConfig, postgresConfigured } from "./store/pg-config.ts";

interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/**
 * The pool is created on first use rather than at import.
 *
 * This module is imported at startup by both server entries and by
 * `flue.config.ts`, and its default export must be a value — so connecting
 * eagerly would turn a slow or unreachable database into a failure to load the
 * module at all, before any logging exists to explain it. `pg` itself is
 * imported dynamically for the same reason the Store does it: the process must
 * run without the dependency present.
 */
export function postgresAdapter(): PersistenceAdapter {
  let poolPromise: Promise<PgPool> | null = null;

  async function pool(): Promise<PgPool> {
    poolPromise ??= (async () => {
      const pg = (await import("pg")).default as unknown as {
        Pool: new (cfg: Record<string, unknown>) => PgPool;
      };
      return new pg.Pool({ ...pgConfig(), max: Number(process.env.ADA_DB_POOL_MAX ?? 10) });
    })();
    return poolPromise;
  }

  const query: PostgresQuery = async (text, params) =>
    (await (await pool()).query(text, params as unknown[])).rows;

  return postgres({
    query,
    async transaction<T>(fn: (tx: { query: PostgresQuery }) => Promise<T>): Promise<T> {
      // One transaction on ONE connection, per the runner contract — the
      // adapter's fence algorithm depends on row locks, which do not hold
      // across pooled connections.
      const client = await (await pool()).connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (text, params?: PostgresParameter[]) =>
            (await client.query(text, params as unknown[])).rows,
        });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A rollback failure means the connection is already broken; surface
          // the ORIGINAL error, which is the one that explains what happened.
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      if (poolPromise) await (await poolPromise).end();
      poolPromise = null;
    },
  });
}

/**
 * Where the local SQLite conversation database lives.
 *
 * In a `db/` SUBDIRECTORY of WORKSPACE_ROOT, not at its root, because that root
 * is also the per-session workspace namespace swept by
 * `session/workspace.ts sweepWorkspaces()`. That sweep reclaims entries
 * beginning with `ada-` and older than its TTL — which matched `ada-flue.db`
 * and its `-wal`/`-shm`/`-journal` siblings exactly. A deployment idle past the
 * TTL deleted its own conversation history. `db/` does not begin with `ada-`,
 * so it is outside the swept namespace entirely; the sweep is separately fixed
 * to touch only directories, and either fix alone closes the hole.
 *
 * A database ALREADY at the old location keeps being used. Preferring the new
 * path unconditionally would leave an existing deployment's history on disk but
 * orphaned, starting an empty database beside it — silent data loss of the same
 * kind, arriving on upgrade instead of on idle. Moving it is not attempted:
 * relocating a live SQLite file plus its WAL is a worse risk than one extra
 * branch here, and the sweep fix protects it where it is.
 */
export function sqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADA_DB_PATH) return env.ADA_DB_PATH;
  const root = env.WORKSPACE_ROOT || tmpdir();
  mkdirSync(root, { recursive: true });
  const legacy = join(root, "ada-flue.db");
  if (existsSync(legacy)) return legacy;
  const dir = join(root, "db");
  mkdirSync(dir, { recursive: true });
  return join(dir, "ada-flue.db");
}

/** Which backend this process will use. Exported for startup logging and tests. */
export function persistenceMode(env: NodeJS.ProcessEnv = process.env): "postgres" | "sqlite" {
  return postgresConfigured(env) ? "postgres" : "sqlite";
}

export default postgresConfigured() ? postgresAdapter() : sqlite(sqlitePath());
