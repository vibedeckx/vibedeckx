import fs from "node:fs";

const mode = process.env.VIBEDECKX_TEST_DAEMON_MODE ?? "ready";
const recordPath = process.env.VIBEDECKX_TEST_DAEMON_RECORD;
const pidRecordPath = process.env.VIBEDECKX_TEST_DAEMON_PID_RECORD;

if (pidRecordPath) {
  fs.writeFileSync(
    pidRecordPath,
    JSON.stringify({
      pid: process.pid,
      processStartTicks: readStartTicks(process.pid),
    }),
  );
}

if (recordPath) {
  fs.writeFileSync(
    recordPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      internalToken: process.env.VIBEDECKX_INTERNAL_CONNECT_TOKEN,
      childMarker: process.env.VIBEDECKX_INTERNAL_CONNECT_DAEMON,
    }),
  );
}

function disconnect() {
  if (process.connected) process.disconnect();
}

function readStartTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19];
}

function writeDaemonState(pid, processStartTicks) {
  const dataDir = process.env.VIBEDECKX_TEST_DAEMON_STATE_DATA_DIR;
  if (!dataDir) throw new Error("Missing fixture daemon state data directory");
  const runDir = `${dataDir}/run`;
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    `${runDir}/connect.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      pid,
      processStartTicks,
      startedAt: new Date().toISOString(),
      connectTo: "https://fixture.example.com",
      version: "fixture",
    })}\n`,
    { mode: 0o600 },
  );
  return runDir;
}

function sendFixtureError() {
  process.send?.({
    type: "error",
    message: process.env.VIBEDECKX_TEST_DAEMON_ERROR_MESSAGE ?? "fixture failed",
  }, () => {
    disconnect();
    process.exit(1);
  });
}

if (mode === "ready") {
  setInterval(() => {}, 1_000);
  process.send?.({ type: "ready", pid: process.pid }, disconnect);
} else if (mode === "error") {
  sendFixtureError();
} else if (mode === "error-with-state") {
  writeDaemonState(process.pid, readStartTicks(process.pid));
  sendFixtureError();
} else if (mode === "error-with-state-lock") {
  const runDir = writeDaemonState(process.pid, readStartTicks(process.pid));
  fs.mkdirSync(`${runDir}/connect.lock`, { mode: 0o700 });
  fs.writeFileSync(
    `${runDir}/connect.lock/owner.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.ppid,
      processStartTicks: readStartTicks(process.ppid),
      nonce: "fixture-live-owner",
    })}\n`,
    { mode: 0o600 },
  );
  sendFixtureError();
} else if (mode === "error-with-unreadable-state") {
  const runDir = writeDaemonState(process.pid, readStartTicks(process.pid));
  fs.chmodSync(`${runDir}/connect.json`, 0o000);
  sendFixtureError();
} else if (mode === "error-with-foreign-state") {
  writeDaemonState(process.ppid, readStartTicks(process.ppid));
  sendFixtureError();
} else if (mode === "exit") {
  process.exit(2);
} else if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "disconnect") {
  setInterval(() => {}, 1_000);
  disconnect();
} else if (mode === "invalid") {
  process.send?.({ type: "ready", pid: "not-a-pid" }, disconnect);
}
