import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HeartbeatWriter,
  judgeLiveness,
  LIVENESS_STALE_MS,
  readWorkerStatus,
  workerStatusPath,
  type WorkerStatus,
} from "./connect-heartbeat.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdx-heartbeat-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writer(now: () => Date = () => new Date()): HeartbeatWriter {
  return new HeartbeatWriter({
    dataDir,
    version: "1.2.3",
    connectTo: "https://hub.example",
    supervisor: "systemd",
    installMode: "native-service",
    intervalMs: 60_000,
    now,
  });
}

describe("HeartbeatWriter", () => {
  it("writes the current state and detail immediately", () => {
    const beat = writer();
    beat.start();
    expect(readWorkerStatus(dataDir)).toMatchObject({
      pid: process.pid,
      state: "starting",
      version: "1.2.3",
      supervisor: "systemd",
    });

    beat.setState("auth-failed", "token rejected", "run setup");
    expect(readWorkerStatus(dataDir)).toMatchObject({
      state: "auth-failed",
      detail: "token rejected",
      fix: "run setup",
    });
    beat.stop();
  });

  it("removes its own file on stop but leaves another process's alone", () => {
    const beat = writer();
    beat.start();
    beat.stop();
    expect(fs.existsSync(workerStatusPath(dataDir))).toBe(false);

    const foreign: WorkerStatus = {
      schemaVersion: 1,
      pid: process.pid + 100_000,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: "x",
      connectTo: "https://hub.example",
      state: "connected",
      installMode: "manual",
    };
    fs.writeFileSync(workerStatusPath(dataDir), JSON.stringify(foreign));
    writer().stop();
    expect(readWorkerStatus(dataDir)).toMatchObject({ pid: foreign.pid });
  });

  it("ignores garbage in the status file", () => {
    fs.mkdirSync(path.dirname(workerStatusPath(dataDir)), { recursive: true });
    fs.writeFileSync(workerStatusPath(dataDir), "{");
    expect(readWorkerStatus(dataDir)).toBeUndefined();
    fs.writeFileSync(workerStatusPath(dataDir), JSON.stringify({ schemaVersion: 1, pid: 1, state: "weird" }));
    expect(readWorkerStatus(dataDir)).toBeUndefined();
  });
});

describe("judgeLiveness", () => {
  const base: WorkerStatus = {
    schemaVersion: 1,
    pid: 42,
    startedAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    version: "x",
    connectTo: "https://hub.example",
    state: "connected",
    installMode: "manual",
  };

  it("is live within the window and stale beyond it", () => {
    const at = (ms: number) => new Date(Date.parse(base.updatedAt) + ms);
    expect(judgeLiveness(base, 42, at(LIVENESS_STALE_MS))).toEqual({ live: true, ageMs: LIVENESS_STALE_MS });
    expect(judgeLiveness(base, 42, at(LIVENESS_STALE_MS + 1))?.live).toBe(false);
  });

  it("is unknown without a file from that process", () => {
    expect(judgeLiveness(undefined, 42)).toBeUndefined();
    expect(judgeLiveness(base, 43)).toBeUndefined();
  });
});
