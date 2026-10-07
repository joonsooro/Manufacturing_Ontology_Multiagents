/**
 * Frontend build/dev configuration. Read root environment values, inject COURSE_NOW,
 * and proxy local API calls to the ontology server during development.
 */
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  // Read the workspace .env, but inject only the course date into the browser bundle.
  const env = loadEnv(mode, repoRoot, "");
  return {
    plugins: [react()],
    optimizeDeps: {
      // Bundle the supplied locale up front instead of Blueprint's dynamic import.
      include: ["date-fns/locale/en-US/index.js"],
    },
    // Browser calculations use this fixed build/dev value; the server maintains its own advancing course clock.
    define: {
      "import.meta.env.COURSE_NOW": JSON.stringify(env.COURSE_NOW ?? ""),
    },
    server: {
      // Relative /api requests share the frontend origin while the dev server forwards them to Hono.
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
  };
});
