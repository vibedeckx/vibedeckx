import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFxAskRun, buildFxAskSpawnConfig, parseFxAskResult } from "./cli.js";
import { parsePromptProvider } from "../../storage/types.js";

describe("fx ask boundary", () => {
  it("parses the real success and noninteractive approval recordings", () => {
    const recording = JSON.parse(readFileSync(new URL("./__fixtures__/task8-ask.json", import.meta.url), "utf8"));
    for (const probe of recording.probes) {
      const result = parseFxAskResult(probe.stdout);
      expect(result.exitCode).toBe(probe.exitCode);
      if (probe.name === "approval") expect(result.finalResult).toBeUndefined();
      else expect(result.finalResult).toBe("FX_ASK_OK");
    }
  });

  it("passes prompt literally and retains unattended permission checks", () => {
    expect(buildFxAskSpawnConfig("/bin/fx", "--full-access $(touch bad)\n'quote'")).toEqual({
      command: "/bin/fx", args: ["ask", "--permission-mode", "full-access", "--json", "--", "--full-access $(touch bad)\n'quote'"],
      env: { FX_AUTO_UPGRADE: "0" }, shell: false,
    });
  });
  it("keeps the final answer separate from accumulated output", () => {
    expect(parseFxAskResult(JSON.stringify({ output: "work\nanswer", final_output: "answer", exit_code: 0 })))
      .toEqual({ output: "work\nanswer", finalResult: "answer", exitCode: 0 });
  });
  it.each(["not json", "{}", '{"output":"","final_output":"","exit_code":9}'])("rejects malformed results: %s", (raw) => {
    expect(() => parseFxAskResult(raw)).toThrow();
  });
  it("defaults only absent providers, never unknown providers", () => {
    expect(parsePromptProvider(null)).toBe("claude");
    expect(parsePromptProvider(undefined)).toBe("claude");
    expect(parsePromptProvider("fx")).toBe("fx");
    expect(() => parsePromptProvider("typo")).toThrow("Unknown prompt provider");
  });
});

describe("fx ask executor run decoder", () => {
  const ok = JSON.stringify({ output: "working\n# Report", final_output: "# Report", exit_code: 0 });

  it("buffers stdout and settles it into output + report on exit", () => {
    const { decoder, stdin } = buildFxAskRun("fx", "hi");
    expect(stdin).toBeNull();
    expect(decoder.stdout(ok.slice(0, 10))).toBeUndefined();
    expect(decoder.stdout(ok.slice(10))).toBeUndefined();
    expect(decoder.stderr("progress\n")).toBe("progress\n");
    expect(decoder.finish({ code: 0, stopped: false })).toEqual({ output: "working\n# Report", finalResult: "# Report", exitCode: 0 });
  });

  it("fails a run without a valid final JSON, but stays quiet when the user stopped it", () => {
    const run = buildFxAskRun("fx", "hi");
    run.decoder.stdout("{\"partial");
    expect(run.decoder.finish({ code: 0, stopped: false })).toMatchObject({ exitCode: 1, error: expect.stringContaining("valid final JSON") });
    const stopped = buildFxAskRun("fx", "hi");
    stopped.decoder.stdout("{\"partial");
    expect(stopped.decoder.finish({ code: null, stopped: true })).toEqual({ exitCode: 1, error: undefined });
  });
});
