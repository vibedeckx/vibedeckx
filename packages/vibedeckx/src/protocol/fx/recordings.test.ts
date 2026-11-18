import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Contract checks live in schema.test.ts and product replay in
// providers/fx-provider.recordings.test.ts; this only guards what gets committed.
const fixtures = new URL("./__fixtures__/", import.meta.url);

describe("fx recordings", () => {
  it("are parseable and carry no credential fields or original home paths", () => {
    for (const file of readdirSync(fixtures).filter(f => f.endsWith(".jsonl"))) {
      const content = readFileSync(new URL(file, fixtures), "utf8");
      for (const line of content.trim().split("\n")) expect(() => JSON.parse(line), file).not.toThrow();
      expect(content, file).not.toMatch(/access_token|refresh_token|\/home\/ubuntu\//);
    }
  });
});
