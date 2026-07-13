import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateHelpTextForAllCommands,
  run,
  type StricliProcess,
} from "@stricli/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { program } from "./command.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDataDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runCommand(inputs: string[]): Promise<{
  exitCode: number | string | null | undefined;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const process: StricliProcess = {
    env: { STRICLI_NO_COLOR: "1" },
    exitCode: undefined,
    stdout: { write: (text) => void stdout.push(text) },
    stderr: { write: (text) => void stderr.push(text) },
  };

  await run(program, inputs, { process });
  return {
    exitCode: process.exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

function commandHelp(route: string): string {
  const help = new Map(generateHelpTextForAllCommands(program));
  const text = help.get(route);
  if (!text) {
    throw new Error(
      `No generated help for ${route}; found ${[...help.keys()].join(", ")}`,
    );
  }
  return text;
}

describe("connect command help", () => {
  it("documents the foreground credentials and daemon flag on the default run command", () => {
    const help = commandHelp("vibedeckx connect run");

    expect(help).toContain("--connect-to");
    expect(help).toContain("--token");
    expect(help).toContain("--daemon");
  });

  it.each(["vibedeckx connect status", "vibedeckx connect stop"])(
    "exposes %s without connection credentials",
    (route) => {
      const help = commandHelp(route);

      expect(help).toContain("--data-dir");
      expect(help).not.toContain("--connect-to");
      expect(help).not.toContain("--token");
    },
  );
});

describe.runIf(process.platform === "linux")("connect management results", () => {
  it("preserves a failing status result as exit code 1 without duplicate output", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runCommand([
      "connect",
      "status",
      "--data-dir",
      temporaryDataDir(),
    ]);
    const output = [
      result.stdout,
      result.stderr,
      ...consoleLog.mock.calls.flat().map(String),
    ].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output.match(/Vibedeckx connect is not running/g)).toHaveLength(1);
  });

  it("keeps stopping a missing daemon idempotently successful", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runCommand([
      "connect",
      "stop",
      "--data-dir",
      temporaryDataDir(),
    ]);

    expect(result.exitCode).toBe(0);
    expect(consoleLog).toHaveBeenCalledOnce();
    expect(consoleLog).toHaveBeenCalledWith(
      "Vibedeckx connect is not running",
    );
    expect(result.stderr).toBe("");
  });
});
