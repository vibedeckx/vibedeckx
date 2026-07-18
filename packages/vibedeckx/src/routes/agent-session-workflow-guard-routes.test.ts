import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import agentSessionRoutes from "./agent-session-routes.js";

let app: FastifyInstance;

async function makeApp(active: boolean) {
  const switchMode = vi.fn(async () => true);
  const acceptPlanAndRestart = vi.fn(async () => true);
  app = Fastify();
  app.decorate("storage", {
    projects: { getById: async () => ({ id: "p1", path: "/tmp/p" }) },
    agentSessions: { getById: async () => ({ id: "s1", project_id: "p1", branch: "dev" }) },
  } as never);
  app.decorate("agentSessionManager", {
    getSession: () => ({ id: "s1", projectId: "p1" }),
    switchMode,
    acceptPlanAndRestart,
  } as never);
  app.decorate("workflowEngine", { isSessionInActiveRun: () => active } as never);
  app.decorate("remoteSessionMap", new Map() as never);
  app.decorate("reverseConnectManager", null as never);
  await app.register(agentSessionRoutes);
  return { switchMode, acceptPlanAndRestart };
}

afterEach(async () => { if (app) await app.close(); });

describe("agent session workflow permission guards", () => {
  it("rejects switch-mode and accept-plan while the session is in an active review", async () => {
    const { switchMode, acceptPlanAndRestart } = await makeApp(true);

    const switched = await app.inject({
      method: "POST", url: "/api/agent-sessions/s1/switch-mode", payload: { mode: "edit" },
    });
    const accepted = await app.inject({
      method: "POST", url: "/api/agent-sessions/s1/accept-plan", payload: { planContent: "do it" },
    });

    expect(switched.statusCode).toBe(409);
    expect(accepted.statusCode).toBe(409);
    expect(switchMode).not.toHaveBeenCalled();
    expect(acceptPlanAndRestart).not.toHaveBeenCalled();
  });

  it("keeps both permission routes available outside an active review", async () => {
    const { switchMode, acceptPlanAndRestart } = await makeApp(false);

    const switched = await app.inject({
      method: "POST", url: "/api/agent-sessions/s1/switch-mode", payload: { mode: "plan" },
    });
    const accepted = await app.inject({
      method: "POST", url: "/api/agent-sessions/s1/accept-plan", payload: { planContent: "do it" },
    });

    expect(switched.statusCode).toBe(200);
    expect(accepted.statusCode).toBe(200);
    expect(switchMode).toHaveBeenCalledWith("s1", "/tmp/p", "plan");
    expect(acceptPlanAndRestart).toHaveBeenCalledWith("s1", "/tmp/p", "do it");
  });
});
