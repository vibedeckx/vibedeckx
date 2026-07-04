import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupLogging, restoreConsole, shutdownLogging, getLogger } from "./logger.js";

const LOG_FILE = "vibedeckx.log";

async function readLogFile(dataDir: string): Promise<string> {
  const file = path.join(dataDir, "logs", LOG_FILE);
  // rotating-file-stream writes asynchronously; poll until content appears.
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      if (content.length > 0) return content;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

describe("logger", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    restoreConsole();
    await shutdownLogging();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("bridges console.* into a rotating NDJSON file", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-log-"));
    setupLogging({ dataDir: tmpDir, level: "info", crashHandlers: false });

    console.log("hello %s", "world");
    console.error("boom:", new Error("kaput"));

    const content = await readLogFile(tmpDir);
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    const info = lines.find((l) => l.msg === "hello world");
    expect(info).toBeDefined();
    expect(info.level).toBe(30);
    expect(info.time).toBeTypeOf("number");

    const error = lines.find((l) => typeof l.msg === "string" && l.msg.startsWith("boom:"));
    expect(error).toBeDefined();
    expect(error.level).toBe(50);
    // util.format renders Errors with their stack trace
    expect(error.msg).toContain("Error: kaput");
  });

  it("drops lines below the configured level", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-log-"));
    setupLogging({ dataDir: tmpDir, level: "warn", crashHandlers: false });

    console.log("invisible info");
    console.warn("visible warning");

    const content = await readLogFile(tmpDir);
    expect(content).toContain("visible warning");
    expect(content).not.toContain("invisible info");
  });

  it("getLogger works without setupLogging", () => {
    const logger = getLogger();
    expect(logger.level).toBeDefined();
    // must not throw
    logger.info("pre-init logging is safe");
  });
});
