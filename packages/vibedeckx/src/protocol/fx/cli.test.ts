import { describe, expect, it } from "vitest";
import { buildFxSpawnConfig } from "./cli.js";

describe("fx spawn", () => {
  it("starts ACP in full-access with the requested model and the original login profile", () => {
    expect(buildFxSpawnConfig("/bin/fx", " vendor/model ")).toEqual({ command: "/bin/fx", args: ["acp", "--permission-mode", "full-access", "--model", "vendor/model"], env: { FX_AUTO_UPGRADE: "0" }, shell: false });
  });
  it.each([undefined, null, "", "   "])("omits --model for the CLI default (%s)", model => {
    expect(buildFxSpawnConfig(null, model)).toMatchObject({ command: "fx", args: ["acp", "--permission-mode", "full-access"] });
  });
});
