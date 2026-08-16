import { describe, it, expect, vi } from "vitest";
import fastify from "fastify";
import { proxyToRemoteAuto, proxyStatus } from "./remote-proxy.js";
import type { ReverseConnectManager } from "../reverse-connect-manager.js";
import { registerTraceContext } from "../trace-context-hooks.js";
import { formatTraceparent, newTraceContext, parseTraceparent, runWithTraceContext } from "../trace-context.js";

describe("proxyToRemoteAuto (reverse-connect only)", () => {
  it("routes through the reverse-connect manager when the remote is connected", async () => {
    const sendHttpRequest = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { hello: 1 } });
    const rcm = { isConnected: () => true, sendHttpRequest } as unknown as ReverseConnectManager;

    const result = await proxyToRemoteAuto("srv-1", "POST", "/api/path/x", { a: 1 }, {
      reverseConnectManager: rcm,
      timeoutMs: 1234,
    });

    // No ambient request context here, so no trace header is invented.
    expect(sendHttpRequest).toHaveBeenCalledWith("srv-1", "POST", "/api/path/x", { a: 1 }, 1234, {});
    expect(result).toEqual({ ok: true, status: 200, data: { hello: 1 } });
  });

  it("resolves to a network_error result when the remote is not connected", async () => {
    const rcm = { isConnected: () => false, sendHttpRequest: vi.fn() } as unknown as ReverseConnectManager;

    const result = await proxyToRemoteAuto("srv-1", "GET", "/api/projects", undefined, {
      reverseConnectManager: rcm,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.errorCode).toBe("network_error");
    // status 0 must coerce to a gateway error, never a success
    expect(proxyStatus(result)).toBe(502);
  });

  it("resolves to a network_error result when no manager is provided at all", async () => {
    const result = await proxyToRemoteAuto("srv-1", "GET", "/api/projects");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("network_error");
  });
});

describe("trace propagation over the tunnel", () => {
  function capturingRcm() {
    const sendHttpRequest = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    return {
      sendHttpRequest,
      rcm: { isConnected: () => true, sendHttpRequest } as unknown as ReverseConnectManager,
      headers: () => sendHttpRequest.mock.calls[0]?.[5] as Record<string, string>,
    };
  }

  it("forwards the ambient trace as a frame header without call-site changes", async () => {
    const { rcm, headers } = capturingRcm();
    const ctx = newTraceContext(undefined);

    await runWithTraceContext(ctx, () =>
      proxyToRemoteAuto("srv-1", "GET", "/api/projects", undefined, { reverseConnectManager: rcm }),
    );

    expect(headers().traceparent).toBe(formatTraceparent(ctx));
  });

  it("lets explicit headers win over the automatic one", async () => {
    const { rcm, headers } = capturingRcm();
    await runWithTraceContext(newTraceContext(undefined), () =>
      proxyToRemoteAuto("srv-1", "GET", "/api/projects", undefined, {
        reverseConnectManager: rcm,
        headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
      }),
    );
    expect(headers().traceparent).toBe("00-11111111111111111111111111111111-2222222222222222-01");
  });

  it("joins hub and worker under one trace ID end to end", async () => {
    const { rcm, headers } = capturingRcm();
    const hubCtx = newTraceContext(undefined);

    await runWithTraceContext(hubCtx, () =>
      proxyToRemoteAuto("srv-1", "GET", "/api/projects", undefined, { reverseConnectManager: rcm }),
    );

    // The worker hands frame headers straight to its own server.inject, so
    // stand one up and confirm it continues the hub's trace rather than
    // starting a fresh one — that link is what makes a trace ID from the
    // browser usable for grepping worker logs.
    const worker = fastify();
    registerTraceContext(worker);
    worker.get("/api/projects", async () => ({ ok: true }));
    try {
      const res = await worker.inject({ method: "GET", url: "/api/projects", headers: headers() });
      const workerTrace = parseTraceparent(res.headers.traceparent as string);
      expect(workerTrace?.traceId).toBe(hubCtx.traceId);
      expect(workerTrace?.spanId).not.toBe(hubCtx.spanId);
    } finally {
      await worker.close();
    }
  });
});
