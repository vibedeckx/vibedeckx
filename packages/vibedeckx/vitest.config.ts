import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live compat probes spawn real agent CLIs and cost API usage — they run
    // only via `pnpm test:compat` (vitest.live.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts"],
  },
});
