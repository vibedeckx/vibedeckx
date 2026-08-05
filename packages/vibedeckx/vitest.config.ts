import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live compat probes spawn real agent CLIs and cost API usage — they run
    // only via `pnpm test:compat` (vitest.live.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts"],
    // Operator secrets are read once at module load, so a developer who has
    // this exported for curl-ing their own deployment would otherwise flip the
    // admin routes into operator mode and fail their tests. Tests state the
    // gate they mean; they never inherit it from the shell.
    env: { VIBEDECKX_API_KEY: "" },
  },
});
