// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    authFetch: vi.fn(),
    getFreshToken: vi.fn().mockResolvedValue("test-token"),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://test"),
  };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { authFetch } from "@/lib/api";
import { toast } from "sonner";
import { SEND_NETWORK_ERROR, useAgentSession } from "./use-agent-session";

const fetchMock = vi.mocked(authFetch);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
  send() {}
}
vi.stubGlobal("WebSocket", FakeWebSocket);

type HookApi = ReturnType<typeof useAgentSession>;
let latest: HookApi | null = null;

function Probe({ branch = "main" }: { branch?: string }) {
  const hook = useAgentSession("p1", branch);
  useEffect(() => { latest = hook; });
  return null;
}

let root: Root | null = null;

const isMessagePost = (url: unknown) => String(url).endsWith("/api/agent-sessions/s1/message");

beforeEach(async () => {
  fetchMock.mockReset();
  vi.mocked(toast.error).mockClear();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ session: null, messages: [] }),
  } as unknown as Response);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => { r.render(<Probe />); });
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  root = null;
  latest = null;
});

describe("useAgentSession sendMessage failures", () => {
  it("reports a dropped connection as a network failure, then clears it once a resend lands", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (isMessagePost(url)) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ session: null, messages: [] }) } as unknown as Response;
    });

    let delivered: boolean | undefined;
    await act(async () => { delivered = await latest!.sendMessage("hi", "s1"); });

    expect(delivered).toBe(false);
    expect(latest!.error).toBe(SEND_NETWORK_ERROR);
    expect(toast.error).toHaveBeenCalledWith("Failed to send message", { description: SEND_NETWORK_ERROR });

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response);
    await act(async () => { delivered = await latest!.sendMessage("hi", "s1"); });

    expect(delivered).toBe(true);
    expect(latest!.error).toBeNull();
  });

  it("leaves another workspace's banner alone when a send from the previous one settles", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (isMessagePost(url)) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ session: null, messages: [] }) } as unknown as Response;
    });
    await act(async () => { await latest!.sendMessage("hi", "s1"); });
    expect(latest!.error).toBe(SEND_NETWORK_ERROR);

    let resolvePost!: (r: Response) => void;
    fetchMock.mockImplementation(async (url) => {
      if (isMessagePost(url)) return new Promise<Response>((resolve) => { resolvePost = resolve; });
      if (String(url).endsWith("/api/agent-sessions/s2/message")) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ session: null, messages: [] }) } as unknown as Response;
    });
    let pending!: Promise<boolean>;
    await act(async () => { pending = latest!.sendMessage("hi", "s1"); });

    // Navigate the same hook to another branch, which then fails a send of
    // its own; the old workspace's POST landing afterwards must not clear it.
    const r = root!;
    await act(async () => { r.render(<Probe branch="other" />); });
    await act(async () => { await latest!.sendMessage("hi", "s2"); });
    expect(latest!.error).toBe(SEND_NETWORK_ERROR);
    await act(async () => {
      resolvePost({ ok: true, json: async () => ({}) } as unknown as Response);
      await pending;
    });

    expect(latest!.error).toBe(SEND_NETWORK_ERROR);
  });

  it("keeps the server's status for a failure that did get a response", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (isMessagePost(url)) {
        return { ok: false, status: 502, json: async () => ({ error: "worker offline" }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ session: null, messages: [] }) } as unknown as Response;
    });

    await act(async () => { await latest!.sendMessage("hi", "s1"); });

    expect(latest!.error).toBe("Failed to send message [502] — worker offline");
  });
});
