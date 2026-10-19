import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeWorker,
  installService,
  lifecycleDisable,
  lifecycleEnable,
  lifecycleRestart,
  lifecycleStart,
  lifecycleStop,
  runSetup,
  sanitizeServicePath,
  uninstallService,
} from "./connect-lifecycle.js";
import {
  daemonStatePath,
  type ConnectDaemonState,
} from "./connect-daemon.js";
import { readLinuxProcessStartTicks } from "./process-identity.js";
import {
  CONNECT_TOKEN_ENV,
  isRepinRequested,
  readSavedConfig,
  savedTokenPath,
  writeSavedConfig,
  writeSavedToken,
} from "./connect-config.js";
import { workerStatusPath, type WorkerStatus } from "./connect-heartbeat.js";
import { readServiceRecord, serviceRecordPath, type Exec, type ExecResult } from "./connect-service.js";
import { readCurrentVersion, validateRuntimeSource } from "./connect-runtime.js";

let workDir: string;
let dataDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-lifecycle-"));
  dataDir = path.join(workDir, "data");
  fs.mkdirSync(dataDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeRunState(overrides: Partial<ConnectDaemonState> = {}): ConnectDaemonState {
  const state: ConnectDaemonState = {
    schemaVersion: 1,
    pid: process.pid,
    processStartTicks: readLinuxProcessStartTicks(process.pid)!,
    startedAt: new Date().toISOString(),
    connectTo: "https://hub.example",
    version: "0.5.4",
    ...overrides,
  };
  fs.mkdirSync(path.dirname(daemonStatePath(dataDir)), { recursive: true });
  fs.writeFileSync(daemonStatePath(dataDir), JSON.stringify(state));
  return state;
}

function writeStatus(overrides: Partial<WorkerStatus> = {}): void {
  const now = new Date().toISOString();
  const status: WorkerStatus = {
    schemaVersion: 1,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    version: "0.5.4",
    connectTo: "https://hub.example",
    state: "connected",
    installMode: "manual",
    ...overrides,
  };
  fs.mkdirSync(path.dirname(workerStatusPath(dataDir)), { recursive: true });
  fs.writeFileSync(workerStatusPath(dataDir), JSON.stringify(status));
}

describe("runSetup", () => {
  it("saves the hub and a token read from a file", async () => {
    const tokenFile = path.join(workDir, "t");
    fs.writeFileSync(tokenFile, "tok-file\n");
    const outcome = await runSetup({ dataDir, connectTo: "https://hub.example", tokenFile, env: {} });

    expect(outcome).toMatchObject({ connectTo: "https://hub.example", tokenUpdated: true });
    expect(readSavedConfig(dataDir)?.connectTo).toBe("https://hub.example");
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("tok-file");
  });

  it("takes a token pasted on the command line and never prompts", async () => {
    writeSavedToken(dataDir, "old");
    const promptToken = vi.fn(async () => "never");
    const outcome = await runSetup({
      dataDir,
      connectTo: "https://hub.example",
      token: "  tok-inline ",
      env: {},
      promptToken,
    });
    expect(outcome.tokenUpdated).toBe(true);
    expect(promptToken).not.toHaveBeenCalled();
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("tok-inline");
  });

  it("refuses more than one token source", async () => {
    await expect(
      runSetup({ dataDir, connectTo: "https://hub.example", token: "a", tokenFile: "/x", env: {} }),
    ).rejects.toThrow("Use only one of --token, --token-file");
    await expect(
      runSetup({ dataDir, connectTo: "https://hub.example", token: "a", tokenStdin: true, env: {} }),
    ).rejects.toThrow("--token, --token-stdin");
  });

  it("reads the token from stdin, the environment, or a hidden prompt", async () => {
    await runSetup({
      dataDir,
      connectTo: "https://hub.example",
      tokenStdin: true,
      readStdin: async () => "tok-stdin\n",
      env: {},
    });
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("tok-stdin");

    await runSetup({ dataDir, env: { [CONNECT_TOKEN_ENV]: "tok-env" } });
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("tok-env");

    fs.rmSync(savedTokenPath(dataDir));
    const promptToken = vi.fn(async () => "tok-prompt");
    await runSetup({ dataDir, env: {}, promptToken });
    expect(promptToken).toHaveBeenCalledOnce();
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("tok-prompt");
  });

  it("keeps an already-saved token when no new one is given", async () => {
    writeSavedToken(dataDir, "kept");
    const outcome = await runSetup({ dataDir, connectTo: "https://new.example", env: {} });
    expect(outcome.tokenUpdated).toBe(false);
    expect(readSavedConfig(dataDir)?.connectTo).toBe("https://new.example");

    // Interactive: Enter keeps it, an answer replaces it (rotation).
    const keep = vi.fn(async () => "");
    expect((await runSetup({ dataDir, env: {}, promptToken: keep })).tokenUpdated).toBe(false);
    expect(keep).toHaveBeenCalledWith(true);
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("kept");

    const rotate = vi.fn(async () => "rotated");
    expect((await runSetup({ dataDir, env: {}, promptToken: rotate })).tokenUpdated).toBe(true);
    expect(fs.readFileSync(savedTokenPath(dataDir), "utf8").trim()).toBe("rotated");
  });

  it("refuses to run without a hub URL or a way to get a token", async () => {
    await expect(runSetup({ dataDir, env: {} })).rejects.toThrow(/--connect-to/);
    await expect(runSetup({ dataDir, connectTo: "https://hub.example", env: {} })).rejects.toThrow(
      /--token-file.*--token-stdin/,
    );
  });

  it("records a re-pin request with --force", async () => {
    writeSavedToken(dataDir, "t");
    await runSetup({ dataDir, connectTo: "https://hub.example", force: true, env: {} });
    expect(isRepinRequested(dataDir)).toBe(true);
  });
});

describe.runIf(process.platform === "linux")("describeWorker", () => {
  it("reports a live, connected worker without touching the network", async () => {
    writeRunState({ version: "0.5.4", connectTo: "https://connect.example.com" });
    writeStatus({ state: "connected", supervisor: "systemd" });
    const fetchLatestVersion = vi.fn(async () => "9.9.9");

    const result = await describeWorker(dataDir, { fetchLatestVersion });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`Running (PID ${process.pid}`);
    expect(result.message).toContain("Connection: connected");
    expect(result.message).toMatch(/Heartbeat: \d+s ago/);
    expect(result.message).toContain("Version: 0.5.4\n");
    expect(result.message).toContain("Target: https://connect.example.com");
    expect(result.message).toContain("Supervisor: systemd");
    expect(result.message).toContain(`Logs: ${path.join(dataDir, "logs", "vibedeckx.log")}`);
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("checks for updates only when asked", async () => {
    writeRunState({ version: "0.5.2" });
    const result = await describeWorker(dataDir, {
      checkUpdate: true,
      fetchLatestVersion: async () => "0.5.4",
    });
    expect(result.message).toContain("Version: 0.5.2 (update available: 0.5.4)");

    const offline = await describeWorker(dataDir, { checkUpdate: true, fetchLatestVersion: async () => undefined });
    expect(offline.message).toContain("Version: 0.5.2 (update check failed)");
  });

  it("shows why a worker is offline and how to fix it", async () => {
    writeRunState();
    writeStatus({ state: "auth-failed", detail: "token rejected", fix: "run connect setup" });
    const result = await describeWorker(dataDir);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Connection: auth-failed — token rejected");
    expect(result.message).toContain("Fix: run connect setup");

    expect((await describeWorker(dataDir, { requireConnected: true })).exitCode).toBe(1);
  });

  it("fails liveness on a stale heartbeat", async () => {
    writeRunState();
    writeStatus({ updatedAt: new Date(Date.now() - 120_000).toISOString() });
    const result = await describeWorker(dataDir);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/Heartbeat: STALE — none for 2m/);
  });

  it("treats a worker without a heartbeat (older version) as alive with unknown connection", async () => {
    writeRunState();
    const result = await describeWorker(dataDir);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Connection: unknown");
    expect(result.message).not.toContain("Heartbeat");
  });

  it("returns non-zero for a missing, stale or invalid worker without deleting state", async () => {
    expect(await describeWorker(dataDir)).toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/not running/),
    });
    writeRunState({ processStartTicks: "0" });
    expect(await describeWorker(dataDir)).toMatchObject({ exitCode: 1, message: expect.stringMatching(/stale.*PID/) });
    fs.writeFileSync(daemonStatePath(dataDir), "{");
    const invalid = await describeWorker(dataDir);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.message).toContain(daemonStatePath(dataDir));
    expect(fs.existsSync(daemonStatePath(dataDir))).toBe(true);
  });
});

describe("lifecycle commands", () => {
  const dockerEnv = { VIBEDECKX_INSTALL_MODE: "docker" };

  it("refuses to manage a Docker worker from inside the container", async () => {
    for (const action of [lifecycleStart, lifecycleStop, lifecycleRestart, lifecycleEnable, lifecycleDisable, uninstallService]) {
      const result = await action({ dataDir, env: dockerEnv });
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/docker update --restart=no/);
    }
    const install = await installService({ dataDir, env: dockerEnv });
    expect(install.exitCode).toBe(1);
  });

  it("requires a service for enable/disable", async () => {
    expect((await lifecycleEnable({ dataDir, env: {} })).message).toMatch(/connect install/);
    expect((await lifecycleDisable({ dataDir, env: {} })).message).toMatch(/connect install/);
  });

  it("routes through the installed service", async () => {
    fs.mkdirSync(path.dirname(serviceRecordPath(dataDir)), { recursive: true });
    fs.writeFileSync(
      serviceRecordPath(dataDir),
      JSON.stringify({
        schemaVersion: 1,
        kind: "systemd",
        name: "vibedeckx-connect-x.service",
        definitionPath: "/x",
        installedAt: new Date().toISOString(),
      }),
    );
    const calls: string[] = [];
    const exec: Exec = (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    };
    const stop = await lifecycleStop({ dataDir, env: {}, exec });
    expect(stop.exitCode).toBe(0);
    expect(stop.message).toMatch(/starts again at the next boot/);
    await lifecycleDisable({ dataDir, env: {}, exec });
    expect(calls.some((call) => call.startsWith("systemctl --user stop "))).toBe(true);
    expect(calls.some((call) => call.startsWith("systemctl --user disable --now "))).toBe(true);
  });

  it("refuses a manual background start outside Linux", async () => {
    const result = await lifecycleStart({ dataDir, env: {}, platform: "darwin" });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/connect install/);
  });

  it("uninstall without a service is a no-op success", async () => {
    expect(await uninstallService({ dataDir, env: {} })).toMatchObject({ exitCode: 0 });
  });
});

/** A fake systemd whose `start` brings up a "worker" (this process) that heartbeats. */
function fakeSystemd(
  options: {
    startFails?: boolean;
    neverHeartbeats?: boolean;
    /** The service is already running. */
    active?: boolean;
    status?: Partial<WorkerStatus>;
  } = {},
): {
  exec: Exec;
  calls: string[];
} {
  const calls: string[] = [];
  const exec: Exec = (command, args): ExecResult => {
    calls.push([command, ...args].join(" "));
    const ok = { status: 0, stdout: "", stderr: "" };
    if (command === "systemctl" && args[0] === "--version") return { ...ok, stdout: "systemd 255 (255.4)" };
    if (command === "systemctl" && args.includes("is-active")) return { ...ok, status: options.active ? 0 : 3 };
    if (command === "loginctl") return { ...ok, stdout: "Linger=yes" };
    if (command === "systemctl" && (args[1] === "start" || args[1] === "restart")) {
      if (options.startFails) return { status: 1, stdout: "", stderr: "Job failed" };
      if (!options.neverHeartbeats) {
        writeRunState();
        writeStatus({
          state: "connecting",
          version: "3.0.0",
          startedAt: new Date(Date.now() + 5).toISOString(),
          ...options.status,
        });
      }
    }
    return ok;
  };
  return { exec, calls };
}

function fakeRelease(version = "3.0.0"): ReturnType<typeof validateRuntimeSource> {
  const root = path.join(workDir, `pkg-${version}`);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "dist", "bin.js"), "");
  for (const nativeModule of ["better-sqlite3", "node-pty"]) {
    fs.mkdirSync(path.join(root, "node_modules", nativeModule), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", nativeModule, "index.js"), "");
  }
  const node = path.join(workDir, "node");
  fs.writeFileSync(node, "#!/bin/sh\n");
  fs.chmodSync(node, 0o755);
  return validateRuntimeSource(root, node);
}

describe("sanitizeServicePath", () => {
  it("drops entries that die with the invoking shell and guarantees system dirs", () => {
    const input = [
      "/home/u/.npm/_npx/3c02/node_modules/.bin",
      "/home/u/project/node_modules/.bin",
      "/home/u/.fnm/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
      "/run/user/1000/fnm_multishells/2560_1792/bin",
      "relative/bin",
      "",
      "/home/u/.local/bin",
      "/home/u/.local/bin",
      "/missing/bin",
      "/usr/bin",
    ].join(":");
    expect(sanitizeServicePath(input, (dir) => dir !== "/missing/bin")).toBe(
      "/home/u/.local/bin:/usr/bin:/usr/local/bin:/bin",
    );
  });
});

describe.runIf(process.platform === "linux")("installService", () => {
  const baseEnv = () => ({
    XDG_CONFIG_HOME: path.join(workDir, "config"),
    PATH: "/usr/bin:/bin",
    HOME: workDir,
  });

  it("saves config, installs the runtime, writes the unit, starts it and waits for its heartbeat", async () => {
    const tokenFile = path.join(workDir, "token");
    fs.writeFileSync(tokenFile, "tok");
    const { exec, calls } = fakeSystemd();
    const log: string[] = [];

    const result = await installService({
      dataDir,
      connectTo: "https://hub.example",
      tokenFile,
      env: baseEnv(),
      exec,
      platform: "linux",
      runtimeSource: fakeRelease(),
      sleep: async () => {},
      log: (line) => log.push(line),
      verifyTimeoutMs: 1_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/Installed and started vibedeckx-connect-[0-9a-f]{8}\.service/);
    expect(readSavedConfig(dataDir)?.connectTo).toBe("https://hub.example");
    expect(readCurrentVersion(dataDir)).toMatch(/^3\.0\.0\+[0-9a-f]{12}$/);
    expect(readServiceRecord(dataDir)).toMatchObject({ kind: "systemd" });
    const unitPath = readServiceRecord(dataDir)!.definitionPath;
    expect(fs.readFileSync(unitPath, "utf8")).toContain(path.join(dataDir, "runtime", "launcher"));
    expect(calls.filter((call) => / (start|enable) /.test(call))).toEqual([
      expect.stringMatching(/^systemctl --user enable vibedeckx-connect-/),
      expect.stringMatching(/^systemctl --user start vibedeckx-connect-/),
    ]);
    expect(log.join("\n")).toMatch(/`claude` is not on PATH/);
    // A non-default data dir gets no `vibedeckx` command, just the launcher path.
    expect(result.message).toContain(`${path.join(dataDir, "runtime", "launcher")} connect status --data-dir ${dataDir}`);
  });

  it("creates the `vibedeckx` command for the default data dir and removes it on uninstall", async () => {
    dataDir = path.join(workDir, ".vibedeckx");
    fs.mkdirSync(dataDir);
    writeSavedConfig(dataDir, "https://hub.example");
    writeSavedToken(dataDir, "tok");
    const { exec } = fakeSystemd();
    const env = { ...baseEnv(), PATH: `${path.join(workDir, ".local", "bin")}:/usr/bin` };

    const result = await installService({
      dataDir,
      env,
      exec,
      platform: "linux",
      runtimeSource: fakeRelease(),
      sleep: async () => {},
      log: () => {},
      verifyTimeoutMs: 1_000,
    });

    const shim = path.join(workDir, ".local", "bin", "vibedeckx");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Manage it with `vibedeckx connect status|stop|start|restart`");
    expect(fs.readFileSync(shim, "utf8")).toContain(path.join(dataDir, "runtime", "launcher"));

    expect((await uninstallService({ dataDir, env, exec })).exitCode).toBe(0);
    expect(fs.existsSync(shim)).toBe(false);
  });

  it("reports a start that never heartbeats and keeps data and runtime intact", async () => {
    writeSavedConfig(dataDir, "https://hub.example");
    writeSavedToken(dataDir, "tok");
    const { exec } = fakeSystemd({ neverHeartbeats: true });

    const result = await installService({
      dataDir,
      env: baseEnv(),
      exec,
      platform: "linux",
      runtimeSource: fakeRelease(),
      sleep: async () => {},
      log: () => {},
      verifyTimeoutMs: 50,
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/did not report a heartbeat.*journalctl --user -u/);
    expect(result.message).toMatch(/re-run `vibedeckx connect install`/);
    expect(readCurrentVersion(dataDir)).toMatch(/^3\.0\.0\+[0-9a-f]{12}$/);
    expect(fs.existsSync(savedTokenPath(dataDir))).toBe(true);
  });

  describe("re-running", () => {
    async function install(
      exec: Exec,
      overrides: Partial<Parameters<typeof installService>[0]> = {},
    ): Promise<Awaited<ReturnType<typeof installService>>> {
      return installService({
        dataDir,
        env: baseEnv(),
        exec,
        platform: "linux",
        runtimeSource: fakeRelease(),
        sleep: async () => {},
        log: () => {},
        verifyTimeoutMs: 1_000,
        ...overrides,
      });
    }
    const startCalls = (calls: string[]) => calls.filter((call) => / (start|restart) vibedeckx/.test(call));

    beforeEach(async () => {
      writeSavedConfig(dataDir, "https://hub.example");
      writeSavedToken(dataDir, "tok");
      expect((await install(fakeSystemd().exec)).exitCode).toBe(0);
    });

    it("leaves a running worker alone when nothing changed", async () => {
      const unit = readServiceRecord(dataDir)!.definitionPath;
      const unitMtime = fs.statSync(unit).mtimeMs;
      const { exec, calls } = fakeSystemd({ active: true });

      const result = await install(exec, { token: "tok", connectTo: "https://hub.example" });

      expect(result.exitCode).toBe(0);
      expect(result.message).toContain("already up to date");
      expect(result.message).toContain(`PID ${process.pid}`);
      expect(startCalls(calls)).toEqual([]);
      expect(calls.some((call) => call.includes("daemon-reload"))).toBe(false);
      expect(fs.statSync(unit).mtimeMs).toBe(unitMtime);
    });

    it("starts a stopped service even when nothing changed", async () => {
      // The worker is gone (its "PID" is this test process: never stop it).
      fs.rmSync(daemonStatePath(dataDir));
      const { exec, calls } = fakeSystemd();
      expect((await install(exec)).exitCode).toBe(0);
      expect(startCalls(calls)).toEqual([expect.stringMatching(/ start /)]);
    });

    it.each([
      ["a new version", () => ({ runtimeSource: fakeRelease("3.0.1") })],
      ["a new token", () => ({ token: "tok-2" })],
      ["a new hub URL", () => ({ connectTo: "https://other.example" })],
      ["a changed unit", () => ({ env: { ...baseEnv(), PATH: `${workDir}:/usr/bin:/bin` } })],
      ["--force", () => ({ force: true })],
    ])("restarts a running worker for %s", async (_label, overrides) => {
      const { exec, calls } = fakeSystemd({ active: true });
      const result = await install(exec, overrides());
      expect(result.exitCode).toBe(0);
      expect(startCalls(calls)).toEqual([expect.stringMatching(/ restart /)]);
    });

    it("restarts a running worker that is still on an older build", async () => {
      writeStatus({ version: "2.9.0" });
      const { exec, calls } = fakeSystemd({ active: true });
      expect((await install(exec)).exitCode).toBe(0);
      expect(startCalls(calls)).toEqual([expect.stringMatching(/ restart /)]);
    });
  });

  it.each(["blocked", "auth-failed"] as const)(
    "fails with the fix when the worker comes up %s, keeping the service",
    async (state) => {
      writeSavedConfig(dataDir, "https://hub.example");
      writeSavedToken(dataDir, "tok");
      const { exec } = fakeSystemd({
        status: { state, detail: "token belongs to another remote", fix: "re-run with --force" },
      });

      const result = await installService({
        dataDir,
        env: baseEnv(),
        exec,
        platform: "linux",
        runtimeSource: fakeRelease(),
        sleep: async () => {},
        log: () => {},
        verifyTimeoutMs: 1_000,
      });

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain(`${state} — token belongs to another remote`);
      expect(result.message).toContain("Fix: re-run with --force");
      expect(readServiceRecord(dataDir)).toMatchObject({ kind: "systemd" });
    },
  );

  it("fails before touching anything when the platform check fails", async () => {
    const exec: Exec = () => ({ status: 1, stdout: "", stderr: "" });
    const result = await installService({ dataDir, env: baseEnv(), exec, platform: "linux", log: () => {} });
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/systemd was not found/);
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
});
