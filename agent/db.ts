/**
 * Persistence entry — where Flue keeps durable conversation state.
 *
 * This is what makes a follow-up turn work at all: Flue keys an instance's
 * message history, submission log, and settled replies off the instance id, so
 * a session resumed after a restart continues where it left off. It replaces
 * the old `claudeSessionIds` map (bridge id -> Claude session id, in memory,
 * lost on restart) and the `--resume` flag that map fed.
 *
 * The file lives under WORKSPACE_ROOT, next to the per-session workspaces, so
 * the two halves of a session's state share one lifetime and one volume. Point
 * WORKSPACE_ROOT at a persistent volume in production: on the `tmpdir()`
 * default the process still works, but conversations do NOT survive a restart.
 * ADA_DB_PATH overrides the whole path.
 *
 * The rest of Ada's durable state (GitHub tokens, repo bindings) continues to
 * live in the Postgres `Store`; this database holds only Flue's own records.
 *
 * Read by BOTH server paths: `flue.config.ts` points the generated Node entry
 * here, and `agent/index.ts` passes the same adapter to `start()`.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "@flue/runtime/node";

function dbPath(): string {
  if (process.env.ADA_DB_PATH) return process.env.ADA_DB_PATH;
  const root = process.env.WORKSPACE_ROOT || tmpdir();
  mkdirSync(root, { recursive: true });
  return join(root, "ada-flue.db");
}

export default sqlite(dbPath());
