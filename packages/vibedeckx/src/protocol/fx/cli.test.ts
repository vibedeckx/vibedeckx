import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFxSpawnConfig } from "./cli.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
describe("fx spawn", () => {
  afterEach(() => vi.resetAllMocks());
  it("uses a verified ACP permission override and keeps the original login profile", () => {
    vi.mocked(execFileSync).mockReturnValue("fx acp [--permission-mode <mode>]");
    expect(buildFxSpawnConfig("/bin/fx", " vendor/model ")).toEqual({ command: "/bin/fx", args: ["acp", "--permission-mode", "full-access", "--model", "vendor/model"], env: { FX_AUTO_UPGRADE: "0" }, shell: false });
    buildFxSpawnConfig("/bin/fx", "another-model");
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith("/bin/fx", ["acp", "--help"], expect.objectContaining({ timeout: 5000 }));
  });
  it.each([undefined, null, "", "   "])("omits --model for the CLI default (%s)", model => {
    expect(buildFxSpawnConfig(null, model).args).toEqual(["acp"]);
  });
  it("does not assume older ACP supports interactive permission flags", () => {
    vi.mocked(execFileSync).mockReturnValue("fx acp [--model <id>] [--log-file <path>]");
    expect(buildFxSpawnConfig("/bin/fx-old").args).toEqual(["acp"]);
  });
  it("leaves safety enforcement to the handshake if probing fails", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("timeout"); });
    expect(buildFxSpawnConfig("/bin/fx-timeout").args).toEqual(["acp"]);
  });
  it("re-probes when the binary changes on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "fx-capabilities-"));
    const binary = join(dir, "fx");
    try {
      writeFileSync(binary, "old");
      vi.mocked(execFileSync).mockReturnValue("fx acp");
      expect(buildFxSpawnConfig(binary).args).toEqual(["acp"]);
      writeFileSync(binary, "new binary version");
      vi.mocked(execFileSync).mockReturnValue("fx acp --permission-mode <mode>");
      expect(buildFxSpawnConfig(binary).args).toEqual(["acp", "--permission-mode", "full-access"]);
      expect(execFileSync).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not probe an unavailable binary", () => {
    expect(buildFxSpawnConfig(null).command).toBe("fx");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
