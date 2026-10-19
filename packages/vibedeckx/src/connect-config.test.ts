import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECT_TO_ENV,
  CONNECT_TOKEN_ENV,
  CONNECT_TOKEN_FILE_ENV,
  DATA_DIR_ENV,
  clearRepinRequest,
  isRepinRequested,
  readSavedConfig,
  readToken,
  requestRepin,
  resolveConnectTo,
  resolveDataDir,
  resolveInstallMode,
  resolveTokenSource,
  savedConfigPath,
  savedTokenPath,
  TokenUnavailableError,
  writeSavedConfig,
  writeSavedToken,
} from "./connect-config.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-config-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function tokenFile(contents: string): string {
  const file = path.join(dataDir, `token-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, contents);
  return file;
}

describe("saved config", () => {
  it("round-trips the hub URL and stores the token privately", () => {
    writeSavedConfig(dataDir, "https://hub.example");
    writeSavedToken(dataDir, "  tok-123\n");

    expect(readSavedConfig(dataDir)).toEqual({ schemaVersion: 1, connectTo: "https://hub.example" });
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8")).toBe("tok-123\n");
    expect(fs.statSync(savedTokenPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(savedConfigPath(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("rejects an invalid hub URL and an empty or spaced token", () => {
    expect(() => writeSavedConfig(dataDir, "ftp://hub")).toThrow(/http/);
    expect(() => writeSavedToken(dataDir, "   ")).toThrow(/empty/);
    expect(() => writeSavedToken(dataDir, "a b")).toThrow(/whitespace/);
  });

  it("reports malformed saved config instead of ignoring it", () => {
    fs.mkdirSync(path.dirname(savedConfigPath(dataDir)), { recursive: true });
    fs.writeFileSync(savedConfigPath(dataDir), "{");
    expect(() => readSavedConfig(dataDir)).toThrow(/not valid JSON/);
    fs.writeFileSync(savedConfigPath(dataDir), "{}");
    expect(() => readSavedConfig(dataDir)).toThrow(/malformed/);
  });

  it("tracks a pending re-pin request", () => {
    expect(isRepinRequested(dataDir)).toBe(false);
    requestRepin(dataDir);
    expect(isRepinRequested(dataDir)).toBe(true);
    clearRepinRequest(dataDir);
    expect(isRepinRequested(dataDir)).toBe(false);
  });
});

describe("token source precedence", () => {
  it("prefers CLI over environment over saved config", () => {
    writeSavedToken(dataDir, "saved");
    const env = { [CONNECT_TOKEN_ENV]: "from-env" };

    expect(resolveTokenSource({ dataDir, flagToken: "cli", env })).toMatchObject({
      kind: "literal",
      value: "cli",
    });
    expect(resolveTokenSource({ dataDir, env })).toMatchObject({
      kind: "literal",
      value: "from-env",
      origin: CONNECT_TOKEN_ENV,
    });
    expect(resolveTokenSource({ dataDir, env: {} })).toMatchObject({
      kind: "file",
      path: savedTokenPath(dataDir),
    });
  });

  it("treats a daemon child's handed-over token as the CLI level", () => {
    expect(
      resolveTokenSource({ dataDir, daemonChildToken: "child", env: { [CONNECT_TOKEN_ENV]: "env" } }),
    ).toMatchObject({ kind: "literal", value: "child" });
  });

  it("refuses two token sources at the same level", () => {
    expect(() =>
      resolveTokenSource({ dataDir, flagToken: "a", flagTokenFile: "/x", env: {} }),
    ).toThrow(/either --token or --token-file/);
    expect(() =>
      resolveTokenSource({
        dataDir,
        env: { [CONNECT_TOKEN_ENV]: "a", [CONNECT_TOKEN_FILE_ENV]: "/x" },
      }),
    ).toThrow(new RegExp(CONNECT_TOKEN_FILE_ENV));
  });

  it("does not consider lower levels conflicting with a higher one", () => {
    expect(
      resolveTokenSource({
        dataDir,
        flagTokenFile: "/cli-file",
        env: { [CONNECT_TOKEN_ENV]: "a", [CONNECT_TOKEN_FILE_ENV]: "/x" },
      }),
    ).toMatchObject({ kind: "file", path: path.resolve("/cli-file") });
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveTokenSource({ dataDir, env: {} })).toBeUndefined();
  });
});

describe("readToken", () => {
  it("re-reads file sources on every call and trims", () => {
    const file = tokenFile("one\n");
    const source = { kind: "file" as const, path: file, origin: "test" };
    expect(readToken(source)).toBe("one");
    fs.writeFileSync(file, "two");
    expect(readToken(source)).toBe("two");
  });

  it("raises TokenUnavailableError for a missing or empty file", () => {
    const missing = { kind: "file" as const, path: path.join(dataDir, "nope"), origin: "test" };
    expect(() => readToken(missing)).toThrow(TokenUnavailableError);
    const empty = { kind: "file" as const, path: tokenFile("\n"), origin: "test" };
    expect(() => readToken(empty)).toThrow(/empty/);
  });
});

describe("hub URL and data dir", () => {
  it("resolves the hub URL by precedence and validates it", () => {
    writeSavedConfig(dataDir, "https://saved.example");
    expect(resolveConnectTo({ dataDir, env: {} })).toBe("https://saved.example");
    expect(resolveConnectTo({ dataDir, env: { [CONNECT_TO_ENV]: "https://env.example" } })).toBe(
      "https://env.example",
    );
    expect(
      resolveConnectTo({ dataDir, flag: "https://flag.example", env: { [CONNECT_TO_ENV]: "https://env.example" } }),
    ).toBe("https://flag.example");
    expect(() => resolveConnectTo({ dataDir, flag: "nope", env: {} })).toThrow(/Invalid/);
  });

  it("resolves the data dir from flag, then environment", () => {
    expect(resolveDataDir("/a", { [DATA_DIR_ENV]: "/b" })).toBe(path.resolve("/a"));
    expect(resolveDataDir(undefined, { [DATA_DIR_ENV]: "/b" })).toBe(path.resolve("/b"));
  });

  it("only recognizes the known install modes", () => {
    expect(resolveInstallMode({})).toBe("manual");
    expect(resolveInstallMode({ VIBEDECKX_INSTALL_MODE: "docker" })).toBe("docker");
    expect(resolveInstallMode({ VIBEDECKX_INSTALL_MODE: "native-service" })).toBe("native-service");
    expect(resolveInstallMode({ VIBEDECKX_INSTALL_MODE: "bogus" })).toBe("manual");
  });
});
