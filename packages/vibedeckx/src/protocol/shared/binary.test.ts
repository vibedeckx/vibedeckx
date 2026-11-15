import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
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

  it("fresh spawn checks discover installations and removals after a cached lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "binary-refresh-"));
    const name = "vibedeckx-binary-refresh-test";
    const binary = join(dir, name + (process.platform === "win32" ? ".cmd" : ""));
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
    try {
      expect(detectBinary(name)).toBeNull();
      writeFileSync(binary, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
      expect(detectBinary(name)).toBeNull();
      expect(detectBinary(name, { refresh: true })).toBe(binary);
      rmSync(binary);
      expect(detectBinary(name, { refresh: true })).toBeNull();
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("probes a binary's --version output", () => {
    const version = getBinaryVersion(detectBinary("node")!);
    expect(version).toMatch(/^v\d+/);
  });

  it("returns null version for a broken command", () => {
    expect(getBinaryVersion("/nonexistent/binary")).toBeNull();
  });
});
