import { flue } from "@flue/vite";
import { defineConfig } from "vite";

// The Flue plugin discovers flue.config.ts, scans the `'use agent'` modules,
// and generates the Node server entry from agent/app.ts.
export default defineConfig({
  plugins: [flue()],
});
