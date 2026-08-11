// @vitest-environment jsdom
//
// Regression test for the cross-project session-jump flash: while a jump is
// resolving, the parent renders (projectId=<new>, branch=null, sessionId=null)
// until the target project's worktrees load. Without the `suspended` gate the
// hook auto-starts in that window, and the backend treats branch=null as the
// main/default branch — so the window flashes main's latest session before the
// real target loads. `suspended: true` must block auto-start entirely, and
// lifting it (with the final branch + sessionId) must load only the target.
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

import { authFetch } from "@/lib/api";
import { useAgentSession } from "./use-agent-session";

const fetchMock = vi.mocked(authFetch);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The hook opens a real WebSocket after a successful load; jsdom has none.
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

interface ProbeProps {
  branch: string | null;
  sessionId: string | null;
  suspended: boolean;
}

function Probe({ branch, sessionId, suspended }: ProbeProps) {
  const hook = useAgentSession("p1", branch, undefined, undefined, { sessionId, suspended });
  useEffect(() => {
    latest = hook;
  });
  return null;
}

let root: Root | null = null;

async function render(props: ProbeProps) {
  if (!root) {
    root = createRoot(document.body.appendChild(document.createElement("div")));
  }
  const r = root;
  await act(async () => {
    r.render(<Probe {...props} />);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      session: { id: "s-target", projectId: "p1", branch: "dev", status: "running" },
      messages: [],
    }),
  }) as unknown as Response);
});

afterEach(async () => {
  const r = root;
  if (r) {
    await act(async () => {
      r.unmount();
    });
  }
  root = null;
  latest = null;
});

describe("suspended navigation gate", () => {
  it("does not auto-start while suspended, then loads only the target session", async () => {
    // Mid-jump window: branch nulled, session not selected yet.
    await render({ branch: null, sessionId: null, suspended: true });
    expect(fetchMock).not.toHaveBeenCalled();

    // Worktrees loaded → selectBranchSession lands branch + sessionId and
    // clears the pin in one batched update.
    await render({ branch: "dev", sessionId: "s-target", suspended: false });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // Explicit-session GET only — never the latest-for-branch POST that
    // resolves branch=null to the default branch.
    expect(urls.some((u) => u.includes("/api/agent-sessions/s-target"))).toBe(true);
    expect(urls.some((u) => u.includes("/api/projects/p1/agent-sessions"))).toBe(false);
    expect(latest!.session?.id).toBe("s-target");
  });

  it("auto-starts latest-for-branch when not suspended (control)", async () => {
    await render({ branch: null, sessionId: null, suspended: false });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/projects/p1/agent-sessions"))).toBe(true);
  });
});
