import { defineConfig } from "evalite/config";

export default defineConfig({
  // Commander confirmation/revision cases span several model turns.
  testTimeout: 400_000,
  maxConcurrency: 1,
});
