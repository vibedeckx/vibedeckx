import { generateHelpTextForAllCommands } from "@stricli/core";
import { describe, expect, it } from "vitest";
import { program } from "./command.js";

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
