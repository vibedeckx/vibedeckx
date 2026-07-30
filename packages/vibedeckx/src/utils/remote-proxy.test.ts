import { describe, it, expect, vi } from "vitest";
import { proxyToRemoteAuto, proxyStatus } from "./remote-proxy.js";
import type { ReverseConnectManager } from "../reverse-connect-manager.js";

describe("proxyToRemoteAuto (reverse-connect only)", () => {
  it("routes through the reverse-connect manager when the remote is connected", async () => {
    const sendHttpRequest = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { hello: 1 } });
    const rcm = { isConnected: () => true, sendHttpRequest } as unknown as ReverseConnectManager;

    const result = await proxyToRemoteAuto("srv-1", "POST", "/api/path/x", { a: 1 }, {
      reverseConnectManager: rcm,
      timeoutMs: 1234,
    });

    expect(sendHttpRequest).toHaveBeenCalledWith("srv-1", "POST", "/api/path/x", { a: 1 }, 1234);
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
