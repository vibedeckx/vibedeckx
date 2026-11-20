import { describe, expect, it } from "vitest";
import { buildFxModelsSpawnConfig, buildFxSpawnConfig, parseFxModelsResult } from "./cli.js";

describe("fx spawn", () => {
  it("starts ACP in full-access with the requested model and the original login profile", () => {
    expect(buildFxSpawnConfig("/bin/fx", " vendor/model ")).toEqual({ command: "/bin/fx", args: ["acp", "--permission-mode", "full-access", "--model", "vendor/model"], env: { FX_AUTO_UPGRADE: "0" }, shell: false });
  });
  it.each([undefined, null, "", "   "])("omits --model for the CLI default (%s)", model => {
    expect(buildFxSpawnConfig(null, model)).toMatchObject({ command: "fx", args: ["acp", "--permission-mode", "full-access"] });
  });
});

describe("fx models", () => {
  it("lists models as JSON without auto-upgrading", () => {
    expect(buildFxModelsSpawnConfig("/bin/fx")).toEqual({ command: "/bin/fx", args: ["models", "--json"], env: { FX_AUTO_UPGRADE: "0" }, shell: false });
  });
  it("returns the ids in order, trimmed and deduped (fx 0.0.17 shape)", () => {
    const stdout = JSON.stringify({
      kind: "models", count: 3, shown_count: 3, more_count: 0, private_models_hidden: false,
      ids: ["anthropic/claude-sonnet-5.5", " openai/gpt-5.4-mini ", "anthropic/claude-sonnet-5.5", ""],
      models: [{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", efforts: ["low"], fast: false, ultrafast: false }],
    });
    expect(parseFxModelsResult(stdout)).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-5.4-mini"]);
  });
  it.each(["not json", "{}", JSON.stringify({ kind: "status", ids: [] }), JSON.stringify({ kind: "models", ids: [1] })])("rejects other output: %s", stdout => {
    expect(() => parseFxModelsResult(stdout)).toThrow();
  });
});
