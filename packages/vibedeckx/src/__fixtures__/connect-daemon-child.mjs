import fs from "node:fs";

const mode = process.env.VIBEDECKX_TEST_DAEMON_MODE ?? "ready";
const recordPath = process.env.VIBEDECKX_TEST_DAEMON_RECORD;

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

if (mode === "ready") {
  setInterval(() => {}, 1_000);
  process.send?.({ type: "ready", pid: process.pid }, disconnect);
} else if (mode === "error") {
  process.send?.({ type: "error", message: "fixture failed" }, () => {
    disconnect();
    process.exit(1);
  });
} else if (mode === "exit") {
  process.exit(2);
} else if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "invalid") {
  process.send?.({ type: "ready", pid: "not-a-pid" }, disconnect);
}
