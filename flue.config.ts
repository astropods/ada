/**
 * Flue project configuration.
 *
 * Ada keeps its historical `agent/` source tree rather than Flue's default
 * `src/`, so both entry paths are explicit. The `'use agent'` scan is narrowed
 * to `agent/agents/` — everything else under `agent/` is transport, auth, and
 * persistence that must never be treated as an agent module.
 *
 * Only the `anthropic` built-in provider ships in the build; the Astro AI
 * Gateway is a CUSTOM provider registered at runtime with `setProvider()` in
 * `agent/app.ts` (see agent/config/model.ts).
 */

import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  target: "node",
  app: "./agent/app.ts",
  db: "./agent/db.ts",
  agents: "agent/agents/*.ts",
  providers: ["anthropic"],
});
