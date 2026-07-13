import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUiRoot } from "./ui-root.js";

let tmp: string;

function makeUiDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

// A baked dir that never exists, so tests exercise the fallback chain.
const missingBaked = () => path.join(tmp, "no-such-baked-ui");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-root-test-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.VIBEDECKX_UI_DIR;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveUiRoot", () => {
  it("returns null with --no-ui without touching anything else", async () => {
    const download = vi.fn();
    const result = await resolveUiRoot({ noUi: true, uiDir: makeUiDir("explicit"), download });
    expect(result).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("prefers an explicit --ui-dir over everything else", async () => {
    const explicit = makeUiDir("explicit");
    const baked = makeUiDir("baked");
    const result = await resolveUiRoot({ uiDir: explicit, bakedDir: baked });
    expect(result).toBe(explicit);
  });

  it("throws when an explicit --ui-dir is missing index.html", async () => {
    const bad = path.join(tmp, "not-a-ui");
    fs.mkdirSync(bad);
    await expect(resolveUiRoot({ uiDir: bad })).rejects.toThrow(/index\.html/);
  });

  it("reads VIBEDECKX_UI_DIR from the environment", async () => {
    const explicit = makeUiDir("from-env");
    process.env.VIBEDECKX_UI_DIR = explicit;
    const result = await resolveUiRoot({ bakedDir: makeUiDir("baked") });
    expect(result).toBe(explicit);
  });

  it("uses the baked dist/ui when present", async () => {
    const baked = makeUiDir("baked");
    const result = await resolveUiRoot({ bakedDir: baked, installedDir: makeUiDir("installed") });
    expect(result).toBe(baked);
  });

  it("falls back to an installed @vibedeckx/ui-dist", async () => {
    const installed = makeUiDir("installed");
    const result = await resolveUiRoot({ bakedDir: missingBaked(), installedDir: installed });
    expect(result).toBe(installed);
  });

  it("uses the version cache before downloading", async () => {
    const cacheRoot = path.join(tmp, "cache");
    fs.mkdirSync(path.join(cacheRoot, "1.2.3"), { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, "1.2.3", "index.html"), "<html></html>");
    const download = vi.fn();
    const result = await resolveUiRoot({
      bakedDir: missingBaked(),
      installedDir: null,
      cacheRoot,
      version: "1.2.3",
      download,
    });
    expect(result).toBe(path.join(cacheRoot, "1.2.3"));
    expect(download).not.toHaveBeenCalled();
  });

  it("downloads into the cache when nothing is found locally", async () => {
    const cacheRoot = path.join(tmp, "cache");
    const download = vi.fn(async (_version: string, cacheDir: string) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "index.html"), "<html></html>");
    });
    const result = await resolveUiRoot({
      bakedDir: missingBaked(),
      installedDir: null,
      cacheRoot,
      version: "1.2.3",
      download,
    });
    expect(download).toHaveBeenCalledWith("1.2.3", path.join(cacheRoot, "1.2.3"));
    expect(result).toBe(path.join(cacheRoot, "1.2.3"));
  });

  it("returns null (API-only) when the download fails", async () => {
    const download = vi.fn(async () => {
      throw new Error("registry unreachable");
    });
    const result = await resolveUiRoot({
      bakedDir: missingBaked(),
      installedDir: null,
      cacheRoot: path.join(tmp, "cache"),
      version: "1.2.3",
      download,
    });
    expect(result).toBeNull();
  });

  it("skips the download when allowDownload is false", async () => {
    const download = vi.fn();
    const result = await resolveUiRoot({
      bakedDir: missingBaked(),
      installedDir: null,
      cacheRoot: path.join(tmp, "cache"),
      version: "1.2.3",
      allowDownload: false,
      download,
    });
    expect(result).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("refuses to download for a non-semver version string", async () => {
    const download = vi.fn();
    const result = await resolveUiRoot({
      bakedDir: missingBaked(),
      installedDir: null,
      cacheRoot: path.join(tmp, "cache"),
      version: "1.2.3; rm -rf /",
      download,
    });
    expect(result).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
});
