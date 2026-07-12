import { beforeEach, describe, expect, it } from "vitest";
import { clearBinaryCaches, detectBinary, getBinaryVersion } from "./binary.js";

describe("protocol/shared/binary", () => {
  beforeEach(() => clearBinaryCaches());

  it("finds a binary that exists on PATH", () => {
    // node is guaranteed present in the test environment
    const path = detectBinary("node");
    expect(path).toBeTruthy();
    expect(path).toContain("node");
  });

  it("returns null for a binary that does not exist", () => {
    expect(detectBinary("definitely-not-a-real-binary-x9z")).toBeNull();
  });

  it("caches results across calls", () => {
    const first = detectBinary("node");
    const second = detectBinary("node");
    expect(second).toBe(first);
  });

  it("probes a binary's --version output", () => {
    const version = getBinaryVersion(detectBinary("node")!);
    expect(version).toMatch(/^v\d+/);
  });

  it("returns null version for a broken command", () => {
    expect(getBinaryVersion("/nonexistent/binary")).toBeNull();
  });
});
