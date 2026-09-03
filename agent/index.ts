/**
 * Node entrypoint for local development and the container image.
 *
 * There are two supported ways to serve Ada, and they differ in ONE respect:
 * who configures the Flue runtime (agent registration, persistence, the
 * durable submission coordinator).
 *
 *   1. `vite build` && `node dist/server.mjs` — the generated Flue Node entry
 *      configures the runtime itself, then serves `agent/app.ts`.
 *   2. `node agent/index.ts` (this file) — no build step; Node's type-stripping
 *      runs the sources directly. Nothing configures the runtime for us, so we
 *      call `start()` before serving. Without it the agent routes fail with
 *      "Agent route invoked before the runtime was configured".
 *
 * `start()` deliberately throws inside a Flue-built server, so these two paths
 * can never both configure the runtime and split its registries.
 *
 * A third way in skips HTTP entirely: `npx flue run agent/agents/ada.ts
 * --message "…"` drives one turn in the terminal, which is the quickest way to
 * check a prompt or tool change.
 */

import { serve } from "@hono/node-server";
import { start } from "@flue/runtime/node";
import app from "./app.ts";
import db from "./db.ts";
import { Ada } from "./agents/ada.ts";
import { adaProviders } from "./config/model.ts";
import { startTelemetrySdk, shutdownTelemetrySdk } from "./telemetry/bootstrap.ts";

const PORT = Number(process.env.PORT ?? 8080);

async function main(): Promise<void> {
  await startTelemetrySdk();

  // Same agent and same database the built entry would register, so a session
  // started under one server path is readable under the other.
  //
  // `providers` REPLACES the registry rather than adding to it, so we pass the
  // complete set (built-in anthropic + the gateway). That also makes this
  // deterministic against app.ts's own idempotent registration, which races
  // this call: whichever runs last, the registry ends up with both.
  const flue = await start({ agents: [Ada], db, providers: adaProviders() });

  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`[ada] listening on http://localhost:${PORT}`);
    console.log(`[ada] open the test client at http://localhost:${PORT}/`);
  });

  const shutdown = async () => {
    server.close();
    await flue.stop(); // drain in-flight turns, then disconnect persistence
    await shutdownTelemetrySdk();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[ada] fatal:", e);
  process.exit(1);
});
