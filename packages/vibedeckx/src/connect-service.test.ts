import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LaunchdAgentAdapter,
  parseSystemdVersion,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceSuffix,
  SystemdUserAdapter,
  systemdQuote,
  type Exec,
  type ExecResult,
  type ServiceSpec,
} from "./connect-service.js";
import { VIBEDECKX_HOME } from "./constants.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-service-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function recordingExec(
  responses: (command: string, args: string[]) => Partial<ExecResult> | undefined = () => undefined,
): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec: (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "", ...responses(command, args) };
    },
  };
}

const spec = (overrides: Partial<ServiceSpec> = {}): ServiceSpec => ({
  dataDir: "/home/u/.vibedeckx",
  launcher: "/home/u/.vibedeckx/runtime/launcher",
  home: "/home/u",
  ...overrides,
});

describe("systemd unit", () => {
  it("never parks a crash loop in failed and restarts on any exit", () => {
    const unit = renderSystemdUnit(spec(), 255);
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("RestartSteps=6");
    expect(unit).toContain("RestartMaxDelaySec=300");
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain('Environment="VIBEDECKX_SUPERVISOR=systemd"');
    expect(unit).toContain('Environment="VIBEDECKX_INSTALL_MODE=native-service"');
    expect(unit).toContain(
      'ExecStart="/home/u/.vibedeckx/runtime/launcher" "--service-env" "connect" "--data-dir" "/home/u/.vibedeckx"',
    );
    // PATH comes from runtime/service.env, so a new PATH never changes the unit.
    expect(unit).not.toContain("PATH=");
  });

  it("falls back to a fixed restart delay before systemd 254", () => {
    const unit = renderSystemdUnit(spec(), 249);
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).not.toContain("RestartSteps");
  });

  it("escapes specifiers, variables, quotes and spaces", () => {
    expect(systemdQuote('/a b/%h/$HOME/"x"\\y')).toBe('"/a b/%%h/$$HOME/\\"x\\"\\\\y"');
    const unit = renderSystemdUnit(spec({ dataDir: "/data 100%" }), 255);
    expect(unit).toContain('"--data-dir" "/data 100%%"');
  });

  it("parses the systemd version", () => {
    expect(parseSystemdVersion("systemd 255 (255.4-1ubuntu8)\n+PAM")).toBe(255);
    expect(parseSystemdVersion("nope")).toBeUndefined();
  });
});

describe("SystemdUserAdapter", () => {
  const env = () => ({ XDG_CONFIG_HOME: path.join(workDir, "config") });

  it("refuses systemd older than 240", () => {
    const { exec } = recordingExec((command, args) =>
      args[0] === "--version" ? { stdout: "systemd 237 (237)" } : undefined,
    );
    expect(() => new SystemdUserAdapter("/d", exec, env(), "u").preflight()).toThrow(/240/);
  });

  it("explains an unreachable user manager", () => {
    const { exec } = recordingExec((command, args) =>
      args[0] === "--version"
        ? { stdout: "systemd 255" }
        : args.includes("show-environment")
          ? { status: 1, stderr: "Failed to connect to bus" }
          : undefined,
    );
    expect(() => new SystemdUserAdapter("/d", exec, env(), "u").preflight()).toThrow(/login session/);
  });

  it("installs, then maps stop/disable/enable onto systemctl --user", () => {
    const { exec, calls } = recordingExec((command, args) =>
      args[0] === "--version" ? { stdout: "systemd 255" } : undefined,
    );
    const adapter = new SystemdUserAdapter(VIBEDECKX_HOME, exec, env(), "u");
    adapter.preflight();
    adapter.install(spec());

    expect(adapter.name).toBe("vibedeckx-connect.service");
    expect(fs.readFileSync(adapter.definitionPath, "utf8")).toContain("Restart=always");
    expect(calls).toContain("systemctl --user daemon-reload");
    expect(calls).toContain("systemctl --user enable vibedeckx-connect.service");
    expect(calls).not.toContain("systemctl --user start vibedeckx-connect.service");

    calls.length = 0;
    adapter.stop();
    adapter.disable();
    adapter.enable();
    adapter.restart();
    expect(calls).toEqual([
      "systemctl --user stop vibedeckx-connect.service",
      "systemctl --user disable --now vibedeckx-connect.service",
      "systemctl --user enable --now vibedeckx-connect.service",
      "systemctl --user restart vibedeckx-connect.service",
    ]);
  });

  it("surfaces systemctl failures", () => {
    const { exec } = recordingExec(() => ({ status: 1, stderr: "Unit not found" }));
    expect(() => new SystemdUserAdapter("/d", exec, env(), "u").start()).toThrow(/Unit not found/);
  });

  it("warns about linger only when it is off", () => {
    const off = recordingExec(() => ({ stdout: "Linger=no" }));
    expect(new SystemdUserAdapter("/d", off.exec, env(), "u").notes().join("\n")).toMatch(
      /sudo loginctl enable-linger u/,
    );
    const on = recordingExec(() => ({ stdout: "Linger=yes" }));
    expect(new SystemdUserAdapter("/d", on.exec, env(), "u").notes()).toEqual([]);
  });

  it("uninstalls without failing on an already-gone unit", () => {
    const { exec, calls } = recordingExec(() => ({ status: 1 }));
    const adapter = new SystemdUserAdapter("/d", exec, env(), "u");
    fs.mkdirSync(path.dirname(adapter.definitionPath), { recursive: true });
    fs.writeFileSync(adapter.definitionPath, "x");
    adapter.uninstall();
    expect(fs.existsSync(adapter.definitionPath)).toBe(false);
    expect(calls[0]).toBe(`systemctl --user disable --now ${adapter.name}`);
  });
});

describe("service naming", () => {
  it("gives the default data dir the plain name and others a stable suffix", () => {
    expect(serviceSuffix(VIBEDECKX_HOME)).toBe("");
    expect(serviceSuffix("/srv/worker-a")).toMatch(/^-[0-9a-f]{8}$/);
    expect(serviceSuffix("/srv/worker-a")).toBe(serviceSuffix("/srv/worker-a/"));
    expect(serviceSuffix("/srv/worker-a")).not.toBe(serviceSuffix("/srv/worker-b"));
  });
});

describe("launchd", () => {
  it("renders a KeepAlive LaunchAgent with escaped values", () => {
    const plist = renderLaunchdPlist("dev.vibedeckx.connect", spec({ dataDir: "/Users/a&b" }));
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>");
    expect(plist).toContain("<string>/Users/a&amp;b</string>");
    expect(plist).toContain("<key>VIBEDECKX_SUPERVISOR</key>\n      <string>launchd</string>");
    // PATH comes from runtime/service.env, so a new PATH never changes the plist.
    expect(plist).not.toContain("<key>PATH</key>");
  });

  it("maps lifecycle onto launchctl in the gui domain", () => {
    let loaded = false;
    const { exec, calls } = recordingExec((command, args) => {
      if (args[0] === "print" && args[1]?.includes("/dev.vibedeckx")) return { status: loaded ? 0 : 113 };
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return undefined;
    });
    const adapter = new LaunchdAgentAdapter(VIBEDECKX_HOME, exec, 501, path.join(workDir, "home"));
    adapter.install(spec({ dataDir: path.join(workDir, "data") }));
    expect(fs.existsSync(adapter.definitionPath)).toBe(true);
    expect(calls).toContain("launchctl enable gui/501/dev.vibedeckx.connect");

    calls.length = 0;
    adapter.start();
    adapter.restart();
    adapter.stop();
    adapter.disable();
    expect(calls).toEqual([
      "launchctl print gui/501/dev.vibedeckx.connect",
      "launchctl print-disabled gui/501",
      `launchctl bootstrap gui/501 ${adapter.definitionPath}`,
      "launchctl print gui/501/dev.vibedeckx.connect",
      "launchctl kickstart -k gui/501/dev.vibedeckx.connect",
      "launchctl print gui/501/dev.vibedeckx.connect",
      "launchctl bootout gui/501/dev.vibedeckx.connect",
      "launchctl print gui/501/dev.vibedeckx.connect",
      "launchctl disable gui/501/dev.vibedeckx.connect",
      "launchctl print gui/501/dev.vibedeckx.connect",
    ]);
    // stop keeps the plist, so the agent loads again at the next login.
    expect(fs.existsSync(adapter.definitionPath)).toBe(true);
  });

  it("waits for an asynchronous bootout before loading a changed definition", () => {
    // Real launchd: bootout returns while the job is still listed for a while.
    let loaded = true;
    let lingering = 0;
    const { exec, calls } = recordingExec((command, args) => {
      if (args[0] === "print" && args[1]?.includes("/dev.vibedeckx")) {
        if (lingering > 0) lingering--;
        else if (!loaded) return { status: 113 };
        return { status: 0 };
      }
      if (args[0] === "bootout") {
        loaded = false;
        lingering = 2;
      }
      if (args[0] === "bootstrap") {
        expect(lingering).toBe(0);
        loaded = true;
      }
      return undefined;
    });
    const sleeps: number[] = [];
    const adapter = new LaunchdAgentAdapter(VIBEDECKX_HOME, exec, 501, path.join(workDir, "home"), (ms) =>
      sleeps.push(ms),
    );
    fs.mkdirSync(path.dirname(adapter.definitionPath), { recursive: true });
    fs.writeFileSync(adapter.definitionPath, "old definition");

    expect(adapter.install(spec({ dataDir: path.join(workDir, "data") }))).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
    calls.length = 0;
    adapter.restart();
    expect(calls).toEqual([
      "launchctl print gui/501/dev.vibedeckx.connect",
      "launchctl print gui/501/dev.vibedeckx.connect",
      "launchctl print-disabled gui/501",
      `launchctl bootstrap gui/501 ${adapter.definitionPath}`,
    ]);
  });

  it("gives up on a bootout that never completes", () => {
    const { exec } = recordingExec((_command, args) =>
      args[0] === "bootout" ? { status: 5, stderr: "Boot-out failed: 5: Input/output error" } : undefined,
    );
    const adapter = new LaunchdAgentAdapter(VIBEDECKX_HOME, exec, 501, path.join(workDir, "home"), () => {});
    expect(() => adapter.stop()).toThrow(/bootout .* failed: Boot-out failed: 5/);
  });

  it("refuses to start a disabled agent with a pointer to enable", () => {
    const { exec, calls } = recordingExec((_command, args) => {
      if (args[0] === "print") return { status: 113 };
      if (args[0] === "print-disabled") {
        return { stdout: '\t"dev.vibedeckx.connect-other" => enabled\n\t"dev.vibedeckx.connect" => disabled\n' };
      }
      return undefined;
    });
    const adapter = new LaunchdAgentAdapter(VIBEDECKX_HOME, exec, 501, path.join(workDir, "home"));
    expect(() => adapter.start()).toThrow("dev.vibedeckx.connect is disabled. Run `vibedeckx connect enable` to start it.");
    expect(calls.some((call) => call.includes("bootstrap"))).toBe(false);
  });

  it("reads both print-disabled formats", () => {
    const withOutput = (stdout: string) =>
      new LaunchdAgentAdapter(VIBEDECKX_HOME, recordingExec(() => ({ stdout })).exec, 501, workDir);
    expect(withOutput('"dev.vibedeckx.connect" => disabled').isEnabled()).toBe(false);
    expect(withOutput('"dev.vibedeckx.connect" => true').isEnabled()).toBe(false);
    expect(withOutput('"dev.vibedeckx.connect" => enabled').isEnabled()).toBe(true);
    expect(withOutput('"dev.vibedeckx.connect" => false').isEnabled()).toBe(true);
    // A prefix of another label must not match it.
    expect(withOutput('"dev.vibedeckx.connect-1a2b3c4d" => disabled').isEnabled()).toBe(true);
    expect(withOutput("").isEnabled()).toBe(true);
  });
});
