#!/usr/bin/env node
// Cross-version compatibility smoke: current-branch server ↔ an older published
// worker (docs/server-worker-compat-design.md §4.2). Green means workers of
// that version keep working against this server build, so the server can ship
// alone.
//
// Registry-driven: every capability in reverse-connect-capabilities.ts must be
// either exercised by a smoke step below or listed in EXEMPT with a reason.
// The script fails on drift in either direction, so adding a capability forces
// an explicit coverage decision here.
//
// Usage:
//   node scripts/cross-version-e2e.mjs <worker-version>
//   node scripts/cross-version-e2e.mjs --worker-bin packages/vibedeckx/dist/bin.js   # harness self-test
//
// 404 policy is judged per capability against its `since` in the registry:
// a 404 is tolerated ONLY when the tested worker version predates every
// capability the smoke covers (an additive capability not yet published), and
// FAILS when the worker version should support it (a breaking change). The
// --worker-bin self-test runs the current branch as worker — newest possible —
// so a 404 there always fails.
//
// Requires a prior `pnpm build:main`. Worker versions predating
// `connect --data-dir` cannot be tested by this harness. Never touches
// ~/.vibedeckx and never runs `connect stop`: both processes get throwaway
// --data-dir directories and are killed by PID / unique-path pkill on exit.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, openSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BIN = path.join(REPO, "packages/vibedeckx/dist/bin.js");
const REGISTRY_TS = path.join(REPO, "packages/vibedeckx/src/reverse-connect-capabilities.ts");
const SERVER_PORT = Number(process.env.XVER_SERVER_PORT ?? 4611);
const WORKER_PORT = Number(process.env.XVER_WORKER_PORT ?? 4612);

// ---------------------------------------------------------------------------
// Coverage plan. Keys must exactly partition the registry.
// ---------------------------------------------------------------------------

// Capabilities not smoked here but exercised by a CI-run test (test.yml runs
// the whole vitest suite). Validated below: the file must exist and contain
// the marker, so a renamed/deleted test can't leave a dead pointer.
const COVERED_BY = {
  "http:POST /api/agent-sessions/:param/switch-mode": { file: "packages/vibedeckx/src/routes/agent-session-workflow-guard-routes.test.ts", marker: "switch-mode" },
  "http:POST /api/agent-sessions/:param/accept-plan": { file: "packages/vibedeckx/src/routes/agent-session-workflow-guard-routes.test.ts", marker: "accept-plan" },
  "http:POST /api/agent-sessions/:param/model": { file: "packages/vibedeckx/src/routes/agent-session-model-routes.test.ts", marker: "/model" },
  "http:POST /api/path/agent-sessions/:param/branch": { file: "packages/vibedeckx/src/routes/agent-session-branch-routes.test.ts", marker: "/branch" },
  "http:POST /api/path/cross-remote/exec": { file: "packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts", marker: "/api/path/cross-remote/exec" },
  "http:POST /api/path/cross-remote/read-file": { file: "packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts", marker: "/api/path/cross-remote/read-file" },
  "http:POST /api/path/cross-remote/list-dir": { file: "packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts", marker: "/api/path/cross-remote/list-dir" },
  "http:POST /api/path/cross-remote/stat": { file: "packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts", marker: "/api/path/cross-remote/stat" },
  "http:POST /api/path/cross-remote/process-list": { file: "packages/vibedeckx/src/routes/cross-remote-target-routes.test.ts", marker: "/api/path/cross-remote/process-list" },
  "http:POST /api/notification-outbox/query": { file: "packages/vibedeckx/src/routes/notification-outbox-routes.test.ts", marker: "/api/notification-outbox/query" },
  "http:POST /api/path/workflow-runs": { file: "packages/vibedeckx/src/routes/workflow-run-routes.test.ts", marker: "/api/path/workflow-runs" },
  "http:GET /api/path/workflow-runs/reviewer-candidate": { file: "packages/vibedeckx/src/routes/workflow-run-routes.test.ts", marker: "reviewer-candidate" },
  "http:POST /api/workflow-runs/:param/gate": { file: "packages/vibedeckx/src/routes/workflow-run-remote-routes.test.ts", marker: "/gate" },
  "http:POST /api/workflow-runs/:param/cancel": { file: "packages/vibedeckx/src/routes/workflow-run-routes.test.ts", marker: "cancel" },
  "http:GET /api/executor-processes/running": { file: "packages/vibedeckx/src/routes/process-routes.auth.test.ts", marker: "/api/executor-processes/running" },
};

// The irreducible remainder — no smoke and no existing test. Each reason names
// the missing fixture, not a hand-wave.
const EXEMPT = {
  "http:GET /api/workflow-runs/:param": "needs a live remote workflow run id; no route test exists yet",
  "http:POST /api/agent-sessions/:param/approve": "approvals never arise under --dangerously-skip-permissions (stub runs edit mode); no route test exists",
  "http:POST /api/agent-sessions/:param/agent-type": "switching to the only other agent type (codex) would download a real binary in CI; no route test exists",
  "http:POST /api/path/terminals/:param/send": "only driven by the project-chat LLM tool; no test exists",
  "passthrough:browser-proxy": "requires a running browser-preview target app",
};

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let workerVersion = null; // null = current branch (--worker-bin): newest possible, 404 never expected
let workerBin = null;
if (args[0] === "--worker-bin") {
  workerBin = path.resolve(args[1] ?? BIN);
} else if (args[0] && !args[0].startsWith("-")) {
  workerVersion = args[0];
} else {
  console.error("usage: cross-version-e2e.mjs <worker-version> | --worker-bin <path>");
  process.exit(2);
}

/** True when version a is strictly older than b. Plain x.y.z compare; unparseable → not older. */
function versionOlderThan(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

if (!existsSync(BIN)) {
  console.error(`server binary missing at ${BIN} — run \`pnpm build:main\` first`);
  process.exit(2);
}

const serverDir = mkdtempSync(path.join(tmpdir(), "xver-server-"));
const workerDir = mkdtempSync(path.join(tmpdir(), "xver-worker-"));
const repoDir = path.join(workerDir, "repo");
const children = [];
let failed = false;

function launch(name, cmd, cmdArgs, opts = {}) {
  const logPath = path.join(serverDir, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(cmd, cmdArgs, { stdio: ["ignore", fd, fd], ...opts });
  children.push({ name, child, logPath });
  console.log(`[xver] ${name}: pid=${child.pid} log=${logPath}`);
  return child;
}

// npx wraps the real worker in sh → bin shims, so killing the spawned pid is
// not enough. The throwaway workerDir path is unique per run and appears on
// every process in that chain's command line — and on nothing else, so this
// can never touch a real worker on the host.
function killWorkerTree() {
  try { execFileSync("pkill", ["-KILL", "-f", workerDir]); } catch { /* none left */ }
}

function cleanup() {
  for (const { child } of children) {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  killWorkerTree();
  rmSync(workerDir, { recursive: true, force: true });
  if (!failed) rmSync(serverDir, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

function fail(message) {
  failed = true;
  console.error(`[xver] FAIL: ${message}`);
  for (const { name, logPath } of children) {
    try {
      const tail = readFileSync(logPath, "utf8").split("\n").slice(-25).join("\n");
      console.error(`[xver] --- last lines of ${name} (${logPath} kept for inspection) ---\n${tail}`);
    } catch { /* log unreadable */ }
  }
  process.exit(1);
}

async function poll(desc, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) fail(`timed out waiting for ${desc}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function request(method, apiPath, body, base = `http://127.0.0.1:${SERVER_PORT}`) {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: body && !isForm ? { "content-type": "application/json" } : {},
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  let json;
  try { json = await res.clone().json(); } catch { json = undefined; }
  return { status: res.status, json, res };
}

class HttpError extends Error {
  constructor(method, apiPath, status, detail) {
    super(`${method} ${apiPath} → ${status}${detail ? ` (${detail})` : ""}`);
    this.status = status;
  }
}

async function api(method, apiPath, body) {
  const { status, json } = await request(method, apiPath, body);
  if (status >= 300) throw new HttpError(method, apiPath, status, JSON.stringify(json)?.slice(0, 150));
  return json;
}

function assertOrFail(cond, msg) {
  if (!cond) fail(msg);
}

// ---------------------------------------------------------------------------
// 1. current-branch server + worker
// ---------------------------------------------------------------------------

launch("server", process.execPath, [BIN, "start", "--port", String(SERVER_PORT), "--data-dir", serverDir]);
await poll("server /api/config", 30_000, async () => {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`);
  return res.ok ? true : undefined;
});
console.log("[xver] server up");

const record = await api("POST", "/api/remote-servers", { name: "xver-e2e-worker" });
const { token } = await api("POST", `/api/remote-servers/${record.id}/connect-token`);
console.log(`[xver] remote record ${record.id}, token issued`);

// Stub `claude` binary on the worker's PATH: speaks just enough stream-json
// (init → assistant → result) for agent-session capabilities to be exercised
// over the tunnel without a real agent CLI or API key.
const stubBinDir = path.join(workerDir, "stub-bin");
mkdirSync(stubBinDir);
writeFileSync(path.join(stubBinDir, "claude"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) { console.log("9.9.9 (Claude Code)"); process.exit(0); }
const sid = "stub-" + Math.random().toString(36).slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: [], mcp_servers: [], model: "stub-model", permissionMode: "default" });
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "user") {
      out({ type: "assistant", message: { model: "stub-model", id: "msg_stub", type: "message", role: "assistant", content: [{ type: "text", text: "stub-reply" }] }, session_id: sid });
      out({ type: "result", subtype: "success", duration_ms: 5, cost_usd: 0, result: "stub-reply", session_id: sid });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
const workerEnv = { ...process.env, PATH: `${stubBinDir}:${process.env.PATH}` };

const connectArgs = [
  "connect",
  "--connect-to", `http://127.0.0.1:${SERVER_PORT}`,
  "--token", token,
  "--port", String(WORKER_PORT),
  "--data-dir", workerDir,
];
const startWorker = () => workerBin
  ? launch("worker", process.execPath, [workerBin, ...connectArgs], { env: workerEnv })
  : launch("worker", "npx", ["-y", `vibedeckx@${workerVersion}`, ...connectArgs], { env: workerEnv });
startWorker();

const online = async () => {
  const servers = await api("GET", "/api/remote-servers");
  const row = servers.find((s) => s.id === record.id);
  return row?.status === "online" ? row : undefined;
};
// npx may download the package on first run — allow a long warm-up.
const row = await poll("worker online", 180_000, online);
console.log(`[xver] worker online (reported version: ${row.worker_version ?? "none — pre-reporting worker"})`);

// ---------------------------------------------------------------------------
// 2. shared fixtures: git repo on the worker, project bound to the remote
// ---------------------------------------------------------------------------

mkdirSync(repoDir);
const git = (...a) => execFileSync("git", ["-C", repoDir, "-c", "user.email=xver@e2e", "-c", "user.name=xver", ...a], { stdio: "pipe" });
execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
writeFileSync(path.join(repoDir, "README.md"), "# xver e2e fixture\nhello-content\n");
git("add", ".");
git("commit", "-m", "init");

// Remote-only project on the server (no local path → routes auto-proxy);
// agent/executor mode pinned to this remote for the routes that consult them.
const { project } = await api("POST", "/api/projects", {
  name: "xver-e2e-project",
  agentMode: record.id,
  executorMode: record.id,
});
await api("POST", `/api/projects/${project.id}/remotes`, {
  remoteServerId: record.id,
  remotePath: repoDir,
  syncUpConfig: { actionType: "command", content: "echo sync-ok", executionMode: record.id },
});
// Worker-side project row (path == remote_path) — required by execute/upload/
// search on the worker. In production this comes from the project-sync flow;
// here we drive the worker's own API directly as fixture setup.
const workerRow = await request("POST", "/api/projects", { name: "xver-worker-row", path: repoDir }, `http://127.0.0.1:${WORKER_PORT}`);
assertOrFail(workerRow.status < 300, `worker-side project row creation failed: ${workerRow.status}`);
console.log("[xver] fixtures ready (git repo + project + binding)");

// ---------------------------------------------------------------------------
// 3. registry-driven capability smokes
// ---------------------------------------------------------------------------

const registryEntries = [...readFileSync(REGISTRY_TS, "utf8").matchAll(/"((?:http|ws|passthrough):[^"]+)"\s*:\s*\{\s*since:\s*"([^"]+)"/g)]
  .map((m) => ({ key: m[1], since: m[2] }));
const registryKeys = registryEntries.map((e) => e.key);
const sinceByKey = new Map(registryEntries.map((e) => [e.key, e.since]));
if (registryKeys.length < 50) fail(`registry parse found only ${registryKeys.length} keys — check the regex against ${REGISTRY_TS}`);

const results = { ok: [], missing: [], failed: [] };
async function smoke(label, keys, fn) {
  try {
    await fn();
    results.ok.push(...keys);
    console.log(`[xver] smoke ${label}: ok`);
  } catch (err) {
    // A 404 is an expected gap only when the tested worker predates EVERY
    // capability this smoke covers; a 404 on a capability the worker's
    // version should serve is a breaking change and fails.
    const expectedGap =
      err instanceof HttpError && err.status === 404 &&
      workerVersion !== null &&
      keys.every((k) => versionOlderThan(workerVersion, sinceByKey.get(k) ?? "0.0.0"));
    if (expectedGap) {
      results.missing.push(...keys);
      console.log(`[xver] smoke ${label}: 404 — worker@${workerVersion} predates ${keys.join(", ")} (expected gap)`);
    } else {
      results.failed.push(...keys);
      console.error(`[xver] smoke ${label}: FAILED — ${err.message}`);
    }
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const P = `/api/projects/${project.id}`;

await smoke("server-browse", ["http:GET /api/browse"], async () => {
  const r = await api("POST", `/api/remote-servers/${record.id}/browse`, { path: workerDir });
  assert(Array.isArray(r.items), `unexpected shape: ${JSON.stringify(r).slice(0, 120)}`);
});
await smoke("server-mkdir", ["http:POST /api/mkdir"], async () => {
  await api("POST", `/api/remote-servers/${record.id}/mkdir`, { parentPath: workerDir, name: "xver-mkdir-check" });
  assert(existsSync(path.join(workerDir, "xver-mkdir-check")), "directory not created on worker");
});
await smoke("project-browse", ["http:GET /api/path/browse"], async () => {
  const r = await api("GET", `${P}/browse?target=remote&path=`);
  assert(Array.isArray(r.items ?? r.entries), "no items");
});
await smoke("list-files", ["http:GET /api/path/list-files"], async () => {
  const r = await api("GET", `${P}/list-files?target=remote`);
  assert(JSON.stringify(r).includes("README.md"), "README.md not listed");
});
await smoke("file-content", ["http:GET /api/path/file-content"], async () => {
  const r = await api("GET", `${P}/file-content?target=remote&path=README.md`);
  assert(JSON.stringify(r).includes("hello-content"), "content mismatch");
});
await smoke("symbol-search", ["http:GET /api/path/symbol-search"], async () => {
  await api("GET", `${P}/symbol-search?target=remote&symbol=hello`);
});
await smoke("file-download", ["http:GET /api/path/file-download"], async () => {
  const { status, res } = await request("GET", `${P}/file-download?target=remote&path=README.md`);
  if (status === 404) throw new HttpError("GET", "file-download", 404);
  assert(status < 300, `status ${status}`);
  const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
  assert(text.includes("hello-content"), "downloaded bytes mismatch");
});
await smoke("upload+delete", ["http:POST /api/path/upload", "http:DELETE /api/path/delete"], async () => {
  const fd = new FormData();
  fd.append("files", new Blob(["uploaded-by-xver"]), "xver-upload.txt");
  await api("POST", `${P}/upload?target=remote&path=`, fd);
  assert(existsSync(path.join(repoDir, "xver-upload.txt")), "uploaded file not on worker");
  await api("DELETE", `${P}/file?target=remote&path=xver-upload.txt`);
  assert(!existsSync(path.join(repoDir, "xver-upload.txt")), "file not deleted on worker");
});
await smoke("branches", ["http:GET /api/path/branches"], async () => {
  const r = await api("GET", `${P}/branches?target=remote`);
  assert(JSON.stringify(r).includes("main"), "main branch not listed");
});
await smoke("branch-activity", ["http:GET /api/path/branches/activity"], async () => {
  const r = await api("GET", `${P}/branches/activity`);
  assert(Array.isArray(r.branches), "no branches array");
});
await smoke("merge-status", ["http:POST /api/path/branches/merge-status"], async () => {
  await api("POST", `${P}/branches/merge-status`, { comparisons: [{ branch: "main", target: "main" }] });
});
await smoke("diff", ["http:GET /api/path/diff"], async () => {
  await api("GET", `${P}/diff?target=remote`);
});
await smoke("commits", ["http:GET /api/path/commits"], async () => {
  const r = await api("GET", `${P}/commits?target=remote&limit=5`);
  assert(JSON.stringify(r).includes("init"), "init commit not listed");
});
await smoke("worktrees", [
  "http:GET /api/path/worktrees", "http:POST /api/path/worktrees", "http:DELETE /api/path/worktrees",
], async () => {
  await api("POST", `${P}/worktrees`, { branchName: "xver/wt", targets: ["remote"], remoteBaseBranch: "main" });
  const list = await api("GET", `${P}/worktrees?target=${record.id}`);
  assert(JSON.stringify(list).includes("xver/wt"), "created worktree not listed");
  await api("DELETE", `${P}/worktrees`, { branch: "xver/wt" });
});
await smoke("execute-sync", ["http:POST /api/execute-one-shot"], async () => {
  await api("POST", `${P}/execute-sync`, { syncType: "up", remoteServerId: record.id });
});
let processId;
await smoke("executor-start", ["http:POST /api/path/execute"], async () => {
  const { group } = await api("POST", `${P}/executor-groups`, { name: "xver-group", branch: "main" });
  const { executor } = await api("POST", `${P}/executors`, {
    name: "xver-exec", command: "echo xver-log-line; sleep 20", group_id: group?.id,
  });
  const started = await api("POST", `/api/executors/${executor.id}/start`, { target: record.id });
  processId = started.processId;
  assert(typeof processId === "string" && processId.startsWith("remote-"), `unexpected processId: ${processId}`);
});
await smoke("executor-logs-ws", ["ws:/api/executor-processes/:param/logs"], async () => {
  assert(processId, "no remote process to stream (executor-start failed?)");
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/executor-processes/${processId}/logs`);
    const timer = setTimeout(() => { ws.close(); reject(new Error("no WS frame within 15s")); }, 15_000);
    ws.onmessage = () => { clearTimeout(timer); ws.close(); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WS error")); };
  });
});
await smoke("executor-stop", ["http:POST /api/executor-processes/:param/stop"], async () => {
  assert(processId, "no remote process to stop (executor-start failed?)");
  await api("POST", `/api/executor-processes/${processId}/stop`);
});
await smoke("terminals", ["http:POST /api/path/terminals"], async () => {
  const r = await api("POST", `${P}/terminals`, { location: "remote", remote_server_id: record.id });
  const termId = r.terminal?.id;
  assert(typeof termId === "string" && termId.startsWith("remote-terminal-"), `unexpected terminal id: ${termId}`);
  await api("DELETE", `/api/terminals/${termId}`).catch(() => { /* stop is covered by executor-stop */ });
});
await smoke("search-catalog", ["http:GET /api/path/search-catalog"], async () => {
  await api("POST", "/api/search/refresh");
});

// --- agent-session round, driven by the PATH-stub `claude` on the worker ---
await smoke("session-find", ["http:POST /api/path/agent-sessions"], async () => {
  // Find-existing (not create): 200 with session:null is a valid answer.
  await api("POST", `${P}/agent-sessions`, { branch: "main", permissionMode: "edit", agentType: "claude-code" });
});
let sessionId;
await smoke("session-create", ["http:POST /api/path/agent-sessions/new"], async () => {
  const created = await api("POST", `${P}/agent-sessions/new`, { branch: "main", permissionMode: "edit", agentType: "claude-code" });
  sessionId = created.session?.id ?? created.id;
  assert(typeof sessionId === "string" && sessionId.startsWith("remote-"), `unexpected session id: ${JSON.stringify(created).slice(0, 150)}`);
});
await smoke("session-list", ["http:GET /api/path/agent-sessions"], async () => {
  const r = await api("GET", `${P}/agent-sessions?branch=main`);
  assert(Array.isArray(r.sessions), "no sessions array");
});
const sessionSmoke = (label, keys, fn) => smoke(label, keys, async () => {
  assert(sessionId, "no remote session (session-create failed?)");
  await fn();
});
await sessionSmoke("session-get", ["http:GET /api/agent-sessions/:param"], async () => {
  const r = await api("GET", `/api/agent-sessions/${sessionId}`);
  assert(JSON.stringify(r).includes("session"), "no session in response");
});
await sessionSmoke("session-message", ["http:POST /api/agent-sessions/:param/message"], async () => {
  await api("POST", `/api/agent-sessions/${sessionId}/message`, { content: "hello stub" });
});
await sessionSmoke("session-stream-ws", ["ws:/api/agent-sessions/:param/stream"], async () => {
  // Semantic assertion, not liveness: the stream replays the session history,
  // which after the session-message smoke must contain the stub agent's
  // "stub-reply". Error frames and unparseable frames fail immediately.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/agent-sessions/${sessionId}/stream`);
    const finish = (timer, act) => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } act(); };
    const timer = setTimeout(() => finish(timer, () => reject(new Error("stub-reply never appeared on the stream within 20s"))), 20_000);
    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(String(ev.data)); } catch {
        return finish(timer, () => reject(new Error(`unparseable WS frame: ${String(ev.data).slice(0, 120)}`)));
      }
      if (frame.error !== undefined) {
        return finish(timer, () => reject(new Error(`WS error frame: ${JSON.stringify(frame).slice(0, 150)}`)));
      }
      if (JSON.stringify(frame).includes("stub-reply")) return finish(timer, resolve);
      // Ready / other patches: keep listening until the reply or the timeout.
    };
    ws.onerror = () => finish(timer, () => reject(new Error("WS transport error")));
  });
});
// The only smoke that asks the worker's own port instead of the hub. The hub
// has no route of its own here: intent-brief distillation calls
// proxyToRemoteAuto directly, so there is nothing to drive through the public
// API, and adding a hub route only so this script could reach it would be
// production code written for a test. Asking the worker still answers the
// question this harness exists for — does a worker of THIS version serve the
// path — which is what the 404-vs-`since` policy is judged on; that the hub
// requests exactly this path over the tunnel is asserted in
// workflow-run-remote-routes.test.ts.
//
// Runs after the stream smoke, so the session holds a real user→assistant
// exchange to project. The route earns its place by what it leaves out — tool
// calls, tool results and thinking never cross the tunnel — so the shape
// assertion is the contract, not the presence of the text.
await sessionSmoke("session-brief-source", ["http:GET /api/agent-sessions/:param/brief-source"], async () => {
  // remote-<serverId>-<projectId>-<sessionId>, each a 36-char uuid.
  const bare = sessionId.slice(-36);
  const apiPath = `/api/agent-sessions/${bare}/brief-source`;
  const { status, json } = await request("GET", apiPath, undefined, `http://127.0.0.1:${WORKER_PORT}`);
  if (status >= 300) throw new HttpError("GET", apiPath, status, JSON.stringify(json)?.slice(0, 150));
  assert(Array.isArray(json?.messages), `no messages array: ${JSON.stringify(json).slice(0, 120)}`);
  const types = [...new Set(json.messages.map((m) => m.type))];
  assert(types.every((t) => t === "user" || t === "assistant"), `unprojected entry types: ${types.join(", ")}`);
  assert(JSON.stringify(json.messages).includes("hello stub"), "the sent user message is missing from the projection");
});
await sessionSmoke("session-paste", ["http:POST /api/agent-sessions/:param/paste"], async () => {
  await api("POST", `/api/agent-sessions/${sessionId}/paste`, { content: "pasted-by-xver" });
});
await sessionSmoke("session-title", ["http:PATCH /api/agent-sessions/:param/title"], async () => {
  await api("PATCH", `/api/agent-sessions/${sessionId}/title`, { title: "xver session" });
});
await sessionSmoke("session-favorite", ["http:PATCH /api/agent-sessions/:param/favorite"], async () => {
  await api("PATCH", `/api/agent-sessions/${sessionId}/favorite`, { favorited: true });
});
await sessionSmoke("session-restart", ["http:POST /api/agent-sessions/:param/restart"], async () => {
  await api("POST", `/api/agent-sessions/${sessionId}/restart`, {});
});
await sessionSmoke("session-stop", ["http:POST /api/agent-sessions/:param/stop"], async () => {
  await api("POST", `/api/agent-sessions/${sessionId}/stop`);
});
await sessionSmoke("session-delete", ["http:DELETE /api/agent-sessions/:param"], async () => {
  await api("DELETE", `/api/agent-sessions/${sessionId}`);
});
await smoke("workflow-list", ["http:GET /api/path/workflow-runs"], async () => {
  const r = await api("GET", `/api/workflow-runs?projectId=${project.id}&branch=main`);
  assert(Array.isArray(r.runs ?? r), "no runs array");
});

// ---------------------------------------------------------------------------
// 4. drop + reconnect
// ---------------------------------------------------------------------------

const workerEntry = children.find((c) => c.name === "worker");
process.kill(workerEntry.child.pid, "SIGKILL");
killWorkerTree();
await poll("worker offline after kill", 30_000, async () => {
  const servers = await api("GET", "/api/remote-servers");
  return servers.find((s) => s.id === record.id)?.status === "offline" ? true : undefined;
});
startWorker();
await poll("worker back online", 180_000, online);
console.log("[xver] smoke reconnect: ok");

// ---------------------------------------------------------------------------
// 5. coverage accounting — the registry must be fully partitioned
// ---------------------------------------------------------------------------

// COVERED_BY pointers must be live: file present and marker found, otherwise
// the claim of CI coverage is dead and the run fails.
for (const [key, { file, marker }] of Object.entries(COVERED_BY)) {
  const full = path.join(REPO, file);
  if (!existsSync(full)) fail(`COVERED_BY ${key} → ${file}: file does not exist`);
  if (!readFileSync(full, "utf8").includes(marker)) fail(`COVERED_BY ${key} → ${file}: marker "${marker}" not found`);
}

const planned = new Set([...results.ok, ...results.missing, ...results.failed, ...Object.keys(EXEMPT), ...Object.keys(COVERED_BY)]);
const unplanned = registryKeys.filter((k) => !planned.has(k));
const phantom = [...planned].filter((k) => !registryKeys.includes(k));
if (unplanned.length > 0) fail(`registry capabilities with neither a smoke, a COVERED_BY test, nor an EXEMPT reason:\n${unplanned.join("\n")}`);
if (phantom.length > 0) fail(`coverage plan references keys not in the registry (stale plan):\n${phantom.join("\n")}`);

console.log(`[xver] coverage: ${results.ok.length} smoked ok, ${results.missing.length} missing on this version, ${Object.keys(COVERED_BY).length} covered by CI tests (validated), ${Object.keys(EXEMPT).length} exempt (reasons in script), ${results.failed.length} failed`);
if (results.missing.length > 0) {
  console.log(`[xver] missing on worker@${workerVersion ?? "local-bin"} (fix their \`since\` in the registry if unexpected):\n  ${results.missing.join("\n  ")}`);
}
if (results.failed.length > 0) fail(`capability smokes failed:\n${results.failed.join("\n")}`);

console.log(`[xver] PASS — server@branch is compatible with worker@${workerVersion ?? "local-bin"}`);
process.exit(0);
