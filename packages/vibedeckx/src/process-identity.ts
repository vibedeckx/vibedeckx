import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Process identity = PID + an opaque, digits-only "start ticks" value that
 * changes when the PID is reused. Every signal we send to a recorded PID is
 * authorized by re-reading this value first.
 */

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

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Parse `ps -o lstart=` output (run with LC_ALL=C TZ=UTC), e.g.
 * "Mon Oct 19 03:07:54 2026", into epoch seconds as a digits-only string.
 */
export function parsePsLstart(output: string): string | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    output.trim(),
  );
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]);
  if (month < 0) return undefined;
  const millis = Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return String(Math.floor(millis / 1000));
}

function readDarwinProcessStartTicks(pid: number): string | undefined {
  let output: string;
  try {
    output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // ps exits 1 when the PID does not exist.
    return undefined;
  }
  return parsePsLstart(output);
}

/**
 * Platform-aware start ticks. Linux reads /proc (clock ticks since boot);
 * macOS uses `ps` (start time, one-second resolution). Undefined means the
 * process does not exist — or, on unsupported platforms, that identity cannot
 * be established at all (callers treat that as "not verifiable").
 */
export function readProcessStartTicks(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "linux") return readLinuxProcessStartTicks(pid);
  if (platform === "darwin") return readDarwinProcessStartTicks(pid);
  return undefined;
}

export function processIdentitySupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" || platform === "darwin";
}
