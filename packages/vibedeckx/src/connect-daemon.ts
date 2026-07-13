import fs from "node:fs";
import path from "node:path";

export interface ConnectDaemonState {
  schemaVersion: 1;
  pid: number;
  processStartTicks: string;
  startedAt: string;
  connectTo: string;
  version: string;
}

export type ConnectDaemonInspection =
  | { kind: "missing" }
  | { kind: "running"; state: ConnectDaemonState }
  | { kind: "stale"; state: ConnectDaemonState }
  | { kind: "invalid"; path: string; reason: string };

export function parseLinuxProcessStartTicks(stat: string): string {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) throw new Error("Malformed Linux process stat");

  const fieldsFromThree = stat.slice(closeParen + 1).trim().split(/\s+/);
  const startTicks = fieldsFromThree[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Malformed Linux process stat");
  }
  return startTicks;
}

export function readLinuxProcessStartTicks(pid: number): string | undefined {
  try {
    return parseLinuxProcessStartTicks(
      fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return undefined;
    }
    throw error;
  }
}

export function daemonStatePath(dataDir: string): string {
  return path.join(dataDir, "run", "connect.json");
}

function isConnectDaemonState(value: unknown): value is ConnectDaemonState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.schemaVersion === 1 &&
    Number.isSafeInteger(state.pid) &&
    (state.pid as number) > 0 &&
    typeof state.processStartTicks === "string" &&
    typeof state.startedAt === "string" &&
    typeof state.connectTo === "string" &&
    typeof state.version === "string"
  );
}

export function inspectDaemonState(dataDir: string): ConnectDaemonInspection {
  const statePath = daemonStatePath(dataDir);
  if (!fs.existsSync(statePath)) return { kind: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    return {
      kind: "invalid",
      path: statePath,
      reason: (error as Error).message,
    };
  }
  if (!isConnectDaemonState(parsed)) {
    return {
      kind: "invalid",
      path: statePath,
      reason: "Unsupported or malformed daemon state",
    };
  }

  const actualTicks = readLinuxProcessStartTicks(parsed.pid);
  return actualTicks === parsed.processStartTicks
    ? { kind: "running", state: parsed }
    : { kind: "stale", state: parsed };
}
