import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Stand in for Clerk: every request is user "u1". Solo mode (authEnabled=false)
// never reaches this — requireAuth short-circuits to undefined there.
vi.mock("../server.js", () => ({ requireAuth: () => "u1" }));

// Records which machine each tunnelled read was sent to, so the tests can
// assert the order the hub asks in — and that it stops at the first hit.
const { proxySpy } = vi.hoisted(() => ({ proxySpy: vi.fn() }));
vi.mock("../utils/remote-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/remote-proxy.js")>()),
  proxyToRemoteAuto: (...args: unknown[]) => proxySpy(...args),
}));

import fileRoutes from "./file-routes.js";

// Fixture: a "project" directory with one tracked file, and a sibling file
// OUTSIDE it — the agent's `/tmp/screenshot.png` stand-in.
let root: string;
let projectDir: string;
let outsideFile: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vdx-file-routes-"));
  projectDir = path.join(root, "project");
  await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "src", "index.ts"), "export const x = 1;\n");
  outsideFile = path.join(root, "artifact.txt");
  await fs.writeFile(outsideFile, "hello from outside\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Ids are uuids in production (`remote-{serverId}-{projectId}-{sessionId}`), and
// the project segment is what says a session belongs here — so the fixtures use
// real-shaped ones rather than readable stand-ins.
const WORKER3 = "5a967959-f5b4-4f9f-bab7-22f1997e69ef";
const UBUNTU = "7fa15626-7b98-411e-9605-a6e8b0e04341";
const PRIMARY = "11111111-2222-3333-4444-555555555555";
const PROJECT = "82192b68-707f-4882-bafe-b24c1bb97f0f";
const OTHER_PROJECT = "99999999-8888-7777-6666-555555555555";
const SESSION = `remote-${WORKER3}-${PROJECT}-296cb6af-478c-4922-a24a-a370567b2043`;
const FOREIGN_SESSION = `remote-${WORKER3}-${OTHER_PROJECT}-296cb6af-478c-4922-a24a-a370567b2043`;

interface AppOptions {
  authEnabled: boolean;
  /** Project path; null models a remote-only project. */
  localPath?: string | null;
  /** Machines linked to the project, primary first. */
  remotes?: Array<{ remote_server_id: string; remote_path: string }>;
  /** Machines the user may reach through the cross-remote gateway. */
  reachable?: string[];
  /** Machines this session already touched through the gateway. */
  auditTargets?: string[];
  /** Local session id → the machine its agent runs on. */
  sessions?: Record<string, string>;
  /** Local (non-`remote-`) session id → the project it belongs to. */
  localSessions?: Record<string, string>;
}

function makeApp(opts: AppOptions): FastifyInstance {
  const remotes = opts.remotes ?? [];
  const app = Fastify();
  app.decorate("authEnabled", opts.authEnabled);
  app.decorate("storage", {
    projects: {
      getById: async (id: string) => ({
        id,
        path: opts.localPath === undefined ? projectDir : opts.localPath,
      }),
    },
    // Local sessions carry no project in their id, so they are looked up.
    agentSessions: {
      getById: async (id: string) =>
        opts.localSessions?.[id] ? { id, project_id: opts.localSessions[id] } : undefined,
    },
    projectRemotes: {
      getByProject: async () => remotes,
      getByProjectAndServer: async (_projectId: string, serverId: string) =>
        remotes.find((r) => r.remote_server_id === serverId),
    },
    crossRemoteAudit: { listSessionTargets: async () => opts.auditTargets ?? [] },
    remoteServers: {
      getById: async (id: string) =>
        (opts.reachable ?? []).includes(id)
          ? { id, name: id, cross_remote_access: "read" }
          : undefined,
    },
  });
  app.decorate("reverseConnectManager", { isConnected: () => true });
  app.decorate("remoteSessionMap", new Map(
    Object.entries(opts.sessions ?? {}).map(([id, remoteServerId]) => [id, { remoteServerId }]),
  ));
  app.register(fileRoutes);
  return app;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe("worker-side /api/path/file-content", () => {
  it("still serves repo-relative files and confines them to the checkout", async () => {
    app = makeApp({ authEnabled: false });
    const ok = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=src/index.ts`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ binary: false, content: "export const x = 1;\n" });

    const traversal = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=../artifact.txt`,
    });
    expect(traversal.statusCode).toBe(403);
  });

  it("serves an absolute path outside the checkout (the agent's temp artifact)", async () => {
    app = makeApp({ authEnabled: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(outsideFile)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ binary: false, content: "hello from outside\n" });
  });

  it("downloads an absolute path outside the checkout", async () => {
    app = makeApp({ authEnabled: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/path/file-download?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(outsideFile)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain('filename="artifact.txt"');
    expect(res.body).toBe("hello from outside\n");
  });

  it("404s a missing or non-file absolute path instead of leaking a stack", async () => {
    app = makeApp({ authEnabled: false });
    const missing = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(path.join(root, "nope.png"))}`,
    });
    expect(missing.statusCode).toBe(404);
    const dir = await app.inject({
      method: "GET",
      url: `/api/path/file-content?path=${encodeURIComponent(projectDir)}&filePath=${encodeURIComponent(root)}`,
    });
    expect(dir.statusCode).toBe(404);
  });
});

describe("list-files", () => {
  it("reports the checkout root alongside the file list", async () => {
    app = makeApp({ authEnabled: false });
    const worker = await app.inject({
      method: "GET",
      url: `/api/path/list-files?path=${encodeURIComponent(projectDir)}`,
    });
    expect(worker.statusCode).toBe(200);
    expect(worker.json()).toMatchObject({ files: ["src/index.ts"], root: projectDir });
    const hub = await app.inject({ method: "GET", url: "/api/projects/p1/list-files" });
    expect(hub.json()).toMatchObject({ root: projectDir });
  });
});

describe("hub-side /api/projects/:id/file-content (local checkout)", () => {
  it("follows absolute paths in solo mode — the operator's own machine", async () => {
    app = makeApp({ authEnabled: false });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/p1/file-content?path=${encodeURIComponent(outsideFile)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: "hello from outside\n" });
  });

  it("keeps local checkouts confined on a multi-tenant (auth) hub", async () => {
    app = makeApp({ authEnabled: true });
    const outside = await app.inject({
      method: "GET",
      url: `/api/projects/p1/file-content?path=${encodeURIComponent(outsideFile)}`,
    });
    expect(outside.statusCode).toBe(403);
    const inside = await app.inject({
      method: "GET",
      url: `/api/projects/p1/file-content?path=src/index.ts`,
    });
    expect(inside.statusCode).toBe(200);
  });
});

// An artifact an agent names — `/tmp/zk200-login-ok.png` — lives on whichever
// machine ran the command that wrote it, which for a cross-remote tool call is
// neither the project's primary remote nor even the machine the session's own
// agent runs on. The conversation carries the path but not the machine, so the
// hub has to ask more than one.
describe("hub-side project reads across machines", () => {
  const artifact = "/tmp/zk200-login-ok.png";

  // Serves the artifact from `holder` and 404s everywhere else.
  function onlyOn(holder: string) {
    proxySpy.mockImplementation(async (serverId: string) =>
      serverId === holder
        ? { ok: true, status: 200, data: { binary: false, content: "png" } }
        : { ok: false, status: 404, data: { error: "File not found" } },
    );
  }

  const askedMachines = () => proxySpy.mock.calls.map((call) => call[0]);

  afterEach(() => {
    proxySpy.mockReset();
  });

  it("falls through the primary to the machine the session's agent runs on", async () => {
    onlyOn(WORKER3);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [
        { remote_server_id: PRIMARY, remote_path: "/src/app" },
        { remote_server_id: WORKER3, remote_path: "/home/j/app" },
      ],
      sessions: { [SESSION]: WORKER3 },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${SESSION}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: "png", serverId: WORKER3 });
    // The agent's own machine first, the primary only as the fallback.
    expect(askedMachines()).toEqual([WORKER3]);
  });

  it("finds an artifact on a machine the session only reached through the gateway", async () => {
    onlyOn(UBUNTU);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: WORKER3, remote_path: "/src/app" }],
      sessions: { [SESSION]: WORKER3 },
      auditTargets: [UBUNTU],
      reachable: [UBUNTU],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-download?target=remote&sessionId=${SESSION}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-vibedeckx-source-server"]).toBe(UBUNTU);
    expect(askedMachines()).toEqual([WORKER3, UBUNTU]);
  });

  it("never asks a machine the user has no read grant on", async () => {
    onlyOn(UBUNTU);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: WORKER3, remote_path: "/src/app" }],
      sessions: { [SESSION]: WORKER3 },
      auditTargets: [UBUNTU],
      reachable: [], // access revoked (or someone else's machine)
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${SESSION}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(404);
    expect(askedMachines()).toEqual([WORKER3]);
  });

  it("keeps repo-relative paths on the primary alone", async () => {
    onlyOn(UBUNTU);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: PRIMARY, remote_path: "/src/app" }],
      sessions: { [SESSION]: WORKER3 },
      auditTargets: [UBUNTU],
      reachable: [UBUNTU],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${SESSION}&path=src/index.ts`,
    });
    expect(res.statusCode).toBe(404);
    expect(askedMachines()).toEqual([PRIMARY]);
  });

  it("asks only the primary when the request names no session", async () => {
    onlyOn(PRIMARY);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: PRIMARY, remote_path: "/src/app" }],
      auditTargets: [UBUNTU],
      reachable: [UBUNTU],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(askedMachines()).toEqual([PRIMARY]);
  });

  // The session id is a lookup key into two GLOBAL maps (remoteSessionMap and
  // the audit trail), so a session belonging elsewhere must not steer the search
  // — even though every candidate it could produce is authorized on its own.
  it("ignores a session id belonging to another project", async () => {
    onlyOn(UBUNTU);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: PRIMARY, remote_path: "/src/app" }],
      sessions: { [FOREIGN_SESSION]: WORKER3 },
      auditTargets: [UBUNTU],
      reachable: [UBUNTU, WORKER3],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${FOREIGN_SESSION}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(404);
    // Falls back to primary-only, exactly as with no session at all.
    expect(askedMachines()).toEqual([PRIMARY]);
  });

  it("ignores a local session id that belongs to another project", async () => {
    onlyOn(UBUNTU);
    const localSession = "296cb6af-478c-4922-a24a-a370567b2043";
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: PRIMARY, remote_path: "/src/app" }],
      localSessions: { [localSession]: OTHER_PROJECT },
      auditTargets: [UBUNTU],
      reachable: [UBUNTU],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${localSession}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(404);
    expect(askedMachines()).toEqual([PRIMARY]);
  });

  it("follows a local session of this project to the machines it drove", async () => {
    onlyOn(UBUNTU);
    const localSession = "296cb6af-478c-4922-a24a-a370567b2043";
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: PRIMARY, remote_path: "/src/app" }],
      localSessions: { [localSession]: PROJECT },
      auditTargets: [UBUNTU],
      reachable: [UBUNTU],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${localSession}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(200);
    // Hit on the first candidate — the primary is never asked.
    expect(askedMachines()).toEqual([UBUNTU]);
  });

  // Deliberate, and disputed in review: a machine LINKED to the project stays a
  // candidate even with its cross-remote grant off. The link can only exist if
  // one user owned both project and machine, and no other hub→remote read
  // consults that grant either — the Files tab browses the primary with no such
  // check, and this same machine becomes readable there the moment the user
  // promotes it. `cross_remote_access` gates the agent's reach, not the owner's.
  it("still reads a linked machine whose cross-remote grant was revoked", async () => {
    onlyOn(UBUNTU);
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [
        { remote_server_id: WORKER3, remote_path: "/src/app" },
        { remote_server_id: UBUNTU, remote_path: "/home/j/app" },
      ],
      sessions: { [SESSION]: WORKER3 },
      auditTargets: [UBUNTU],
      reachable: [], // grant revoked since the screenshot was taken
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${SESSION}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(askedMachines()).toEqual([WORKER3, UBUNTU]);
  });

  it("reports a worker too old for outside paths instead of a misleading 404", async () => {
    proxySpy.mockImplementation(async () => ({
      ok: false,
      status: 403,
      data: { error: "Path traversal not allowed" },
    }));
    app = makeApp({
      authEnabled: true,
      localPath: null,
      remotes: [{ remote_server_id: PRIMARY, remote_path: "/src/app" }],
      sessions: { [SESSION]: WORKER3 },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT}/file-content?target=remote&sessionId=${SESSION}&path=${encodeURIComponent(artifact)}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
