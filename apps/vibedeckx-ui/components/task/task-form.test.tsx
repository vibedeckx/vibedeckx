import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("TaskForm", () => {
  it("does not show the default focus ring on the create task textarea", async () => {
    const source = readFileSync(resolve(__dirname, "task-form.tsx"), "utf8");

    expect(source).toContain("focus-visible:border-input");
    expect(source).toContain("focus-visible:ring-0");
  });
});
