import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/protocol/live/**/*.live.test.ts"],
    // One CLI at a time: keeps cost/auth behavior predictable and failures readable.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    retry: 1,
    passWithNoTests: true,
  },
});
