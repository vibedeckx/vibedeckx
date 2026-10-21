import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VIBEDECKX_HOME } from "./constants.js";
import { connectConfigDir } from "./connect-config.js";
import { SERVICE_ENV_FLAG } from "./connect-runtime.js";
import {
  clearStopMarker,
  currentStopScope,
  sendSuperviseCommand,
  writeStopMarker,
  type SuperviseCommand,
} from "./connect-windows-supervise.js";
import { writeFileAtomic } from "./utils/atomic-file.js";

/**
 * Supervisor adapters (worker-supervision-design §4). Each maps our lifecycle
 * semantics onto the platform's service manager:
 *
 *   stop     → stopped until the next boot/login or `start`; auto-start kept
 *   disable  → stopped and auto-start paused, across reboots, until `enable`
 *   crash    → restarted with backoff, never parked in a terminal failed state
 *
 * The worker always runs as the installing (non-root) user: it needs that
 * user's agent CLI credentials, HOME, PATH and git config. PATH is not part
 * of the definition: the launcher loads it from runtime/service.env, so a new
 * PATH needs a restart, never a reload.
 */

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[]) => ExecResult;

export const defaultExec: Exec = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) {
    return { status: null, stdout: "", stderr: result.error.message };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export type ServiceKind = "systemd" | "launchd" | "schtasks";

export interface ServiceRecord {
  schemaVersion: 1;
  kind: ServiceKind;
  name: string;
  definitionPath: string;
  installedAt: string;
}

export interface ServiceSpec {
  dataDir: string;
  launcher: string;
  home: string;
}

export interface ServiceAdapter {
  readonly kind: ServiceKind;
  readonly name: string;
  readonly definitionPath: string;
  /** Validate the platform (versions, tools). Throws with an actionable message. */
  preflight(): void;
  /**
   * Write the definition and register auto-start. Does not start the worker.
   * Returns whether the definition on disk changed; an unchanged one is left
   * alone so a running worker keeps running.
   */
  install(spec: ServiceSpec): boolean;
  // Lifecycle calls may be async: on Windows they talk to the supervisor over
  // its control pipe. Callers always await them.
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  restart(): void | Promise<void>;
  enable(): void | Promise<void>;
  disable(): void | Promise<void>;
  uninstall(): void | Promise<void>;
  isActive(): boolean | Promise<boolean>;
  /** Human-readable notes about platform limits (linger, login). */
  notes(): string[];
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function serviceRecordPath(dataDir: string): string {
  return path.join(connectConfigDir(dataDir), "service.json");
}

export function readServiceRecord(dataDir: string): ServiceRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(serviceRecordPath(dataDir), "utf8")) as ServiceRecord;
    if (
      parsed.schemaVersion !== 1 ||
      (parsed.kind !== "systemd" && parsed.kind !== "launchd" && parsed.kind !== "schtasks") ||
      typeof parsed.name !== "string"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeServiceRecord(dataDir: string, adapter: ServiceAdapter): void {
  const record: ServiceRecord = {
    schemaVersion: 1,
    kind: adapter.kind,
    name: adapter.name,
    definitionPath: adapter.definitionPath,
    installedAt: new Date().toISOString(),
  };
  writeFileAtomic(serviceRecordPath(dataDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function removeServiceRecord(dataDir: string): void {
  fs.rmSync(serviceRecordPath(dataDir), { force: true });
}

/** Default data-dir gets the plain name; any other one a stable suffix. */
export function serviceSuffix(dataDir: string): string {
  if (path.resolve(dataDir) === path.resolve(VIBEDECKX_HOME)) return "";
  return `-${createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 8)}`;
}

function fail(action: string, result: ExecResult): never {
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(`${action} failed${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// systemd (user unit)
// ---------------------------------------------------------------------------

export const MIN_SYSTEMD_VERSION = 240;
/** RestartSteps= / RestartMaxDelaySec= (exponential restart backoff). */
export const SYSTEMD_BACKOFF_VERSION = 254;

/** Quote one word for a unit file: specifiers (%) and variables ($) escaped. */
export function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$")}"`;
}

export function renderSystemdUnit(spec: ServiceSpec, systemdVersion: number): string {
  const lines = [
    "# Generated by `vibedeckx connect install`. Do not edit;",
    "# re-run `vibedeckx connect install` to change it.",
    "[Unit]",
    `Description=Vibedeckx reverse-connect worker (${spec.dataDir.replace(/%/g, "%%")})`,
    // Without this, systemd's default start rate limit (5 starts / 10s) parks
    // a crash-looping unit in `failed` and stops retrying for good.
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[spec.launcher, SERVICE_ENV_FLAG, "connect", "--data-dir", spec.dataDir].map(systemdQuote).join(" ")}`,
    `Environment=${systemdQuote(`HOME=${spec.home}`)}`,
    'Environment="VIBEDECKX_SUPERVISOR=systemd"',
    'Environment="VIBEDECKX_INSTALL_MODE=native-service"',
    // Any exit not caused by `systemctl stop` restarts — including a clean
    // code-0 exit after an earlyoom SIGTERM.
    "Restart=always",
    "RestartSec=5",
  ];
  if (systemdVersion >= SYSTEMD_BACKOFF_VERSION) {
    lines.push("RestartSteps=6", "RestartMaxDelaySec=300");
  }
  lines.push(
    // SIGTERM the worker only; it shuts its agent children down itself.
    // Stragglers get SIGKILL when the stop timeout runs out.
    "KillMode=mixed",
    "TimeoutStopSec=20",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

export function parseSystemdVersion(output: string): number | undefined {
  const match = /^systemd\s+(\d+)/m.exec(output);
  return match ? Number(match[1]) : undefined;
}

export class SystemdUserAdapter implements ServiceAdapter {
  readonly kind = "systemd" as const;
  readonly name: string;
  readonly definitionPath: string;
  private version: number | undefined;

  constructor(
    dataDir: string,
    private readonly exec: Exec = defaultExec,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly user: string = os.userInfo().username,
  ) {
    this.name = `vibedeckx-connect${serviceSuffix(dataDir)}.service`;
    const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
    this.definitionPath = path.join(configHome, "systemd", "user", this.name);
  }

  private systemctl(args: string[], action: string): ExecResult {
    const result = this.exec("systemctl", ["--user", ...args]);
    if (result.status !== 0) fail(action, result);
    return result;
  }

  preflight(): void {
    const result = this.exec("systemctl", ["--version"]);
    if (result.status !== 0) {
      throw new Error("systemd was not found (systemctl --version failed); `vibedeckx connect install` needs systemd on Linux");
    }
    const version = parseSystemdVersion(result.stdout);
    if (version === undefined || version < MIN_SYSTEMD_VERSION) {
      throw new Error(
        `systemd ${version ?? "(unknown)"} is too old; \`vibedeckx connect install\` needs systemd ${MIN_SYSTEMD_VERSION} or newer`,
      );
    }
    this.version = version;
    const probe = this.exec("systemctl", ["--user", "show-environment"]);
    if (probe.status !== 0) {
      throw new Error(
        "Cannot reach the systemd user manager (systemctl --user failed). " +
          "Run `vibedeckx connect install` from a login session of this user (SSH works; `sudo -u` does not).",
      );
    }
  }

  install(spec: ServiceSpec): boolean {
    if (this.version === undefined) this.preflight();
    const unit = renderSystemdUnit(spec, this.version!);
    const changed = readIfExists(this.definitionPath) !== unit;
    if (changed) {
      fs.mkdirSync(path.dirname(this.definitionPath), { recursive: true });
      writeFileAtomic(this.definitionPath, unit);
      this.systemctl(["daemon-reload"], "systemctl --user daemon-reload");
    }
    this.systemctl(["enable", this.name], `systemctl --user enable ${this.name}`);
    return changed;
  }

  start(): void {
    this.systemctl(["start", this.name], `systemctl --user start ${this.name}`);
  }

  stop(): void {
    this.systemctl(["stop", this.name], `systemctl --user stop ${this.name}`);
  }

  restart(): void {
    this.systemctl(["restart", this.name], `systemctl --user restart ${this.name}`);
  }

  enable(): void {
    this.systemctl(["enable", "--now", this.name], `systemctl --user enable --now ${this.name}`);
  }

  disable(): void {
    this.systemctl(["disable", "--now", this.name], `systemctl --user disable --now ${this.name}`);
  }

  uninstall(): void {
    // Best effort on the way out: a unit that is already gone is fine.
    this.exec("systemctl", ["--user", "disable", "--now", this.name]);
    fs.rmSync(this.definitionPath, { force: true });
    this.exec("systemctl", ["--user", "daemon-reload"]);
    this.exec("systemctl", ["--user", "reset-failed", this.name]);
  }

  isActive(): boolean {
    return this.exec("systemctl", ["--user", "is-active", "--quiet", this.name]).status === 0;
  }

  isEnabled(): boolean {
    return this.exec("systemctl", ["--user", "is-enabled", "--quiet", this.name]).status === 0;
  }

  lingerEnabled(): boolean | undefined {
    const result = this.exec("loginctl", ["show-user", this.user, "--property=Linger"]);
    if (result.status !== 0) return undefined;
    return /Linger=yes/.test(result.stdout);
  }

  /** Try enabling linger without sudo (allowed by polkit on many distros). */
  tryEnableLinger(): boolean {
    return this.exec("loginctl", ["enable-linger", this.user]).status === 0;
  }

  notes(): string[] {
    const linger = this.lingerEnabled();
    if (linger === true) return [];
    return [
      "Lingering is off for this user, so the worker only runs while you are logged in " +
        "and will NOT start at boot. Enable it once with:",
      `  sudo loginctl enable-linger ${this.user}`,
    ];
  }
}

// ---------------------------------------------------------------------------
// launchd (LaunchAgent)
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderLaunchdPlist(label: string, spec: ServiceSpec): string {
  const args = [spec.launcher, SERVICE_ENV_FLAG, "connect", "--data-dir", spec.dataDir]
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const env: Record<string, string> = {
    HOME: spec.home,
    VIBEDECKX_SUPERVISOR: "launchd",
    VIBEDECKX_INSTALL_MODE: "native-service",
  };
  const envXml = Object.entries(env)
    .map(([key, value]) => `      <key>${key}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const logPath = path.join(spec.dataDir, "logs", "launchd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by \`vibedeckx connect install\`. Do not edit. -->
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Relaunch on any exit; launchd throttles but never gives up. -->
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
  </dict>
</plist>
`;
}

/** Blocks the (synchronous) lifecycle commands while launchd finishes an unload. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const BOOTOUT_WAIT_MS = 15_000;
const BOOTOUT_POLL_MS = 100;

export class LaunchdAgentAdapter implements ServiceAdapter {
  readonly kind = "launchd" as const;
  readonly name: string;
  readonly definitionPath: string;
  private readonly domain: string;

  constructor(
    dataDir: string,
    private readonly exec: Exec = defaultExec,
    uid: number = process.getuid?.() ?? 0,
    home: string = os.homedir(),
    private readonly sleep: (ms: number) => void = sleepSync,
  ) {
    this.name = `dev.vibedeckx.connect${serviceSuffix(dataDir)}`;
    this.definitionPath = path.join(home, "Library", "LaunchAgents", `${this.name}.plist`);
    this.domain = `gui/${uid}`;
  }

  private get target(): string {
    return `${this.domain}/${this.name}`;
  }

  private launchctl(args: string[], action: string): ExecResult {
    const result = this.exec("launchctl", args);
    if (result.status !== 0) fail(action, result);
    return result;
  }

  /**
   * `launchctl bootout` returns while the job is still being torn down: a
   * `kickstart` then finds no service (113) and a `bootstrap` fails with
   * "Input/output error" (5). Wait until the job is really gone.
   */
  private bootout(): void {
    if (!this.isLoaded()) return;
    const result = this.exec("launchctl", ["bootout", this.target]);
    for (let waited = 0; this.isLoaded(); waited += BOOTOUT_POLL_MS) {
      if (waited >= BOOTOUT_WAIT_MS) fail(`launchctl bootout ${this.target}`, result);
      this.sleep(BOOTOUT_POLL_MS);
    }
  }

  /** `print-disabled` says "disabled"/"enabled" (macOS 13+) or "true"/"false" (older). */
  isEnabled(): boolean {
    const result = this.exec("launchctl", ["print-disabled", this.domain]);
    const escaped = this.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`"${escaped}"\\s*=>\\s*(\\w+)`).exec(result.stdout);
    return !match || match[1] === "enabled" || match[1] === "false";
  }

  preflight(): void {
    const result = this.exec("launchctl", ["print", this.domain]);
    if (result.status !== 0) {
      throw new Error(
        `Cannot reach the launchd domain ${this.domain}. Run \`vibedeckx connect install\` from the logged-in user's session.`,
      );
    }
  }

  install(spec: ServiceSpec): boolean {
    fs.mkdirSync(path.dirname(this.definitionPath), { recursive: true });
    fs.mkdirSync(path.join(spec.dataDir, "logs"), { recursive: true });
    const plist = renderLaunchdPlist(this.name, spec);
    const changed = readIfExists(this.definitionPath) !== plist;
    if (changed) {
      // Unload any previous definition so the new one is what gets bootstrapped.
      this.bootout();
      writeFileAtomic(this.definitionPath, plist);
    }
    this.launchctl(["enable", this.target], `launchctl enable ${this.target}`);
    return changed;
  }

  isLoaded(): boolean {
    return this.exec("launchctl", ["print", this.target]).status === 0;
  }

  start(): void {
    if (this.isLoaded()) {
      this.launchctl(["kickstart", this.target], `launchctl kickstart ${this.target}`);
      return;
    }
    // launchd refuses to load a disabled job with a bare "Input/output error".
    if (!this.isEnabled()) {
      throw new Error(`${this.name} is disabled. Run \`vibedeckx connect enable\` to start it.`);
    }
    this.launchctl(["bootstrap", this.domain, this.definitionPath], `launchctl bootstrap ${this.domain}`);
  }

  /** bootout leaves the plist in place, so it loads again at the next login. */
  stop(): void {
    this.bootout();
  }

  restart(): void {
    if (!this.isLoaded()) {
      this.start();
      return;
    }
    this.launchctl(["kickstart", "-k", this.target], `launchctl kickstart -k ${this.target}`);
  }

  enable(): void {
    this.launchctl(["enable", this.target], `launchctl enable ${this.target}`);
    this.start();
  }

  disable(): void {
    this.launchctl(["disable", this.target], `launchctl disable ${this.target}`);
    this.stop();
  }

  uninstall(): void {
    this.bootout();
    fs.rmSync(this.definitionPath, { force: true });
  }

  isActive(): boolean {
    const result = this.exec("launchctl", ["print", this.target]);
    return result.status === 0 && /state = running/.test(result.stdout);
  }

  notes(): string[] {
    return [
      "LaunchAgents start after this user logs in. For an unattended Mac, enable automatic login.",
    ];
  }
}

// ---------------------------------------------------------------------------
// Task Scheduler (Windows): a per-user task that launches `connect supervise`
// ---------------------------------------------------------------------------

/** `conhost --headless` (keeps the tree windowless) arrived with ConPTY in 1809. */
export const MIN_WINDOWS_BUILD = 17763;
const SUPERVISE_START_WAIT_MS = 20_000;
const SUPERVISE_EXIT_WAIT_MS = 60_000;
const SUPERVISE_POLL_MS = 250;

export function parseWindowsBuild(release: string): number | undefined {
  const match = /^\d+\.\d+\.(\d+)/.exec(release);
  return match ? Number(match[1]) : undefined;
}

export interface TaskSpec extends ServiceSpec {
  /** DOMAIN\user the task runs as (the installing user). */
  user: string;
  systemRoot: string;
}

/** Arguments for `cmd /d /s /c`: /s strips the outer quotes, keeping the inner ones. */
export function taskCommandLine(spec: TaskSpec): string {
  const inner = [`"${spec.launcher}"`, SERVICE_ENV_FLAG, "connect", "supervise", "--data-dir", `"${spec.dataDir}"`];
  return `/d /s /c "${inner.join(" ")}"`;
}

export function renderTaskXml(spec: TaskSpec): string {
  const conhost = path.win32.join(spec.systemRoot, "System32", "conhost.exe");
  const cmd = path.win32.join(spec.systemRoot, "System32", "cmd.exe");
  // The repetition relaunches `supervise` within a minute of it dying; while
  // it runs, IgnoreNew drops the launches (and its pipe turns away a duplicate).
  const repetition = "<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>";
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- Generated by \`vibedeckx connect install\`. Do not edit. -->
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`Vibedeckx reverse-connect worker (${spec.dataDir})`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <!-- Schema order: the base trigger elements (Repetition) precede UserId. -->
    <LogonTrigger><Enabled>true</Enabled>${repetition}<UserId>${xmlEscape(spec.user)}</UserId></LogonTrigger>
    <TimeTrigger><Enabled>true</Enabled><StartBoundary>2020-01-01T00:00:00</StartBoundary>${repetition}</TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(spec.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(conhost)}</Command>
      <Arguments>${xmlEscape(`--headless "${cmd}" ${taskCommandLine(spec)}`)}</Arguments>
      <WorkingDirectory>${xmlEscape(spec.dataDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** `<Enabled>` of the task's Settings (not of a trigger) in `schtasks /Query /XML` output. */
export function parseTaskEnabled(xml: string): boolean | undefined {
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(xml);
  if (!settings) return undefined;
  const withoutIdle = settings[1].replace(/<IdleSettings>[\s\S]*?<\/IdleSettings>/, "");
  const enabled = /<Enabled>(true|false)<\/Enabled>/.exec(withoutIdle);
  return enabled ? enabled[1] === "true" : true;
}

export type SuperviseClient = (dataDir: string, command: SuperviseCommand) => Promise<string | undefined>;

const asyncSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TaskSchedulerAdapter implements ServiceAdapter {
  readonly kind = "schtasks" as const;
  readonly name: string;
  readonly definitionPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly exec: Exec = defaultExec,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly client: SuperviseClient = (dir, command) => sendSuperviseCommand(dir, command),
    private readonly sleep: (ms: number) => Promise<void> = asyncSleep,
    private readonly release: string = os.release(),
  ) {
    this.name = `vibedeckx-connect${serviceSuffix(dataDir)}`;
    // The definition lives in Task Scheduler; this copy is what we registered,
    // so a re-install can tell whether anything changed.
    this.definitionPath = path.join(connectConfigDir(dataDir), "scheduled-task.xml");
  }

  private schtasks(args: string[], action: string): ExecResult {
    const result = this.exec("schtasks", args);
    if (result.status !== 0) fail(action, result);
    return result;
  }

  private get user(): string {
    const name = this.env.USERNAME;
    if (!name) throw new Error("USERNAME is not set; cannot register the task for this user");
    return this.env.USERDOMAIN ? `${this.env.USERDOMAIN}\\${name}` : name;
  }

  preflight(): void {
    const build = parseWindowsBuild(this.release);
    if (build === undefined || build < MIN_WINDOWS_BUILD) {
      throw new Error(
        `Windows build ${build ?? this.release} is too old; \`vibedeckx connect install\` needs Windows 10 1809 (build ${MIN_WINDOWS_BUILD}) or newer`,
      );
    }
    if (this.exec("schtasks", ["/Query", "/FO", "CSV", "/NH"]).status !== 0) {
      throw new Error("Task Scheduler is not reachable (schtasks /Query failed)");
    }
    void this.user;
  }

  /**
   * A failed `/Query /TN` does not prove absence: it also fails when Task
   * Scheduler is unreachable or access is denied, and its message is
   * localized. Absent means a successful full listing without our task.
   */
  taskState(): "present" | "absent" | "unknown" {
    if (this.exec("schtasks", ["/Query", "/TN", this.name]).status === 0) return "present";
    const listing = this.exec("schtasks", ["/Query", "/FO", "CSV", "/NH"]);
    if (listing.status !== 0) return "unknown";
    return listing.stdout.toLowerCase().includes(`"\\${this.name.toLowerCase()}"`) ? "present" : "absent";
  }

  isRegistered(): boolean {
    return this.taskState() === "present";
  }

  install(spec: ServiceSpec): boolean {
    const xml = renderTaskXml({ ...spec, user: this.user, systemRoot: this.env.SystemRoot ?? "C:\\Windows" });
    let before: string | undefined;
    try {
      before = fs.readFileSync(this.definitionPath, "utf16le").replace(/^\uFEFF/, "");
    } catch {
      before = undefined;
    }
    const changed = before !== xml;
    if (changed || !this.isRegistered()) {
      fs.mkdirSync(path.dirname(this.definitionPath), { recursive: true });
      // schtasks /XML wants UTF-16 with a BOM, as the declaration says.
      writeFileAtomic(this.definitionPath, Buffer.from(`\uFEFF${xml}`, "utf16le"));
      this.schtasks(["/Create", "/TN", this.name, "/XML", this.definitionPath, "/F"], `schtasks /Create /TN ${this.name}`);
    }
    return changed;
  }

  async isActive(): Promise<boolean> {
    try {
      return (await this.client(this.dataDir, "ping")) !== undefined;
    } catch {
      return false;
    }
  }

  isEnabled(): boolean {
    const result = this.exec("schtasks", ["/Query", "/TN", this.name, "/XML"]);
    return result.status === 0 && parseTaskEnabled(result.stdout) !== false;
  }

  private async waitUntil(active: boolean, timeoutMs: number): Promise<boolean> {
    for (let waited = 0; ; waited += SUPERVISE_POLL_MS) {
      if ((await this.isActive()) === active) return true;
      if (waited >= timeoutMs) return false;
      await this.sleep(SUPERVISE_POLL_MS);
    }
  }

  /** Ask the supervisor to stop the worker and exit; wait until it is gone. */
  private async quit(): Promise<void> {
    if ((await this.client(this.dataDir, "quit")) === undefined) return;
    if (!(await this.waitUntil(false, SUPERVISE_EXIT_WAIT_MS))) {
      throw new Error(`The worker supervisor for ${this.name} did not exit within ${SUPERVISE_EXIT_WAIT_MS / 1000}s`);
    }
  }

  async start(): Promise<void> {
    clearStopMarker(this.dataDir);
    if (await this.isActive()) return;
    if (!this.isEnabled()) {
      throw new Error(`${this.name} is disabled. Run \`vibedeckx connect enable\` to start it.`);
    }
    // The task instance that just quit may still be winding down, and
    // IgnoreNew drops a /Run while it does: retry until the supervisor answers.
    for (let waited = 0; waited < SUPERVISE_START_WAIT_MS; waited += 5_000) {
      this.schtasks(["/Run", "/TN", this.name], `schtasks /Run /TN ${this.name}`);
      if (await this.waitUntil(true, 5_000)) return;
    }
    throw new Error(
      `${this.name} was started but its supervisor did not come up; see logs\\supervise.log in ${this.dataDir}`,
    );
  }

  /**
   * Stopped until the next login or boot (the marker) or `start`; auto-start
   * is kept. The marker names the supervisor's logon session, which need not
   * be ours (e.g. `connect stop` over SSH).
   */
  async stop(): Promise<void> {
    const scope = currentStopScope();
    try {
      const reply = JSON.parse((await this.client(this.dataDir, "ping")) ?? "{}") as { logonId?: unknown };
      if (typeof reply.logonId === "string") scope.logonId = reply.logonId;
    } catch {
      // Not running, or an older supervisor: our own session is the best guess.
    }
    writeStopMarker(this.dataDir, scope);
    await this.quit();
  }

  /** Restarts the supervisor too, so it picks up a new runtime. */
  async restart(): Promise<void> {
    await this.quit();
    await this.start();
  }

  async enable(): Promise<void> {
    this.schtasks(["/Change", "/TN", this.name, "/ENABLE"], `schtasks /Change /TN ${this.name} /ENABLE`);
    await this.start();
  }

  async disable(): Promise<void> {
    this.schtasks(["/Change", "/TN", this.name, "/DISABLE"], `schtasks /Change /TN ${this.name} /DISABLE`);
    await this.quit();
  }

  async uninstall(): Promise<void> {
    await this.quit();
    const deleted = this.exec("schtasks", ["/Delete", "/TN", this.name, "/F"]);
    // Only a task confirmed gone is fine: one that may still be registered
    // would start the worker again within a minute, so keep our records and fail.
    if (deleted.status !== 0 && this.taskState() !== "absent") fail(`schtasks /Delete /TN ${this.name}`, deleted);
    fs.rmSync(this.definitionPath, { force: true });
    clearStopMarker(this.dataDir);
  }

  notes(): string[] {
    return [
      "The worker starts after this user logs in to Windows. For an unattended machine, enable automatic sign-in.",
    ];
  }
}

export interface AdapterOptions {
  platform?: NodeJS.Platform;
  exec?: Exec;
  /** Locates the definition (XDG_CONFIG_HOME, HOME). */
  env?: NodeJS.ProcessEnv;
}

function homeFrom(env: NodeJS.ProcessEnv | undefined): string {
  return env?.HOME || os.homedir();
}

export function createServiceAdapter(
  dataDir: string,
  options: AdapterOptions = {},
): ServiceAdapter {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    return new SystemdUserAdapter(dataDir, options.exec, options.env ?? process.env);
  }
  if (platform === "darwin") {
    return new LaunchdAgentAdapter(dataDir, options.exec, undefined, homeFrom(options.env));
  }
  if (platform === "win32") {
    return new TaskSchedulerAdapter(dataDir, options.exec, options.env ?? process.env);
  }
  throw new Error(
    `vibedeckx connect install is not supported on ${platform} yet (supported: Linux with systemd, macOS, Windows)`,
  );
}

/** The adapter for an installed service, rebuilt from its record. */
export function adapterForRecord(
  dataDir: string,
  record: ServiceRecord,
  options: Omit<AdapterOptions, "platform"> = {},
): ServiceAdapter {
  switch (record.kind) {
    case "systemd":
      return new SystemdUserAdapter(dataDir, options.exec, options.env ?? process.env);
    case "launchd":
      return new LaunchdAgentAdapter(dataDir, options.exec, undefined, homeFrom(options.env));
    case "schtasks":
      return new TaskSchedulerAdapter(dataDir, options.exec, options.env ?? process.env);
  }
}
