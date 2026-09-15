// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteServer } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  getRemoteServers: vi.fn(async () => [] as RemoteServer[]),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { CrossRemoteToolResult, CrossRemoteToolUse, isCrossRemoteTool } from "./cross-remote-tools";
import { __resetRemoteServerNamesCache, publishRemoteServerNames } from "@/hooks/use-remote-server-names";

const SERVER: RemoteServer = {
  id: "6ab61b9c-acca-4447-978b-53d52713f911",
  name: "worker3",
  status: "online",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  cross_remote_access: "exec",
};

let container: HTMLDivElement;
let root: Root;

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
  // Let the lazy remote-server fetch land.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  __resetRemoteServerNamesCache();
  apiMock.getRemoteServers.mockReset();
  apiMock.getRemoteServers.mockResolvedValue([SERVER]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("isCrossRemoteTool", () => {
  it("matches both CLIs' spellings and nothing else", () => {
    expect(isCrossRemoteTool("mcp__cross-remote__remote_bash")).toBe(true);
    expect(isCrossRemoteTool("remote_bash")).toBe(true);
    expect(isCrossRemoteTool("cross-remote__remote_read_file")).toBe(true);
    expect(isCrossRemoteTool("Bash")).toBe(false);
    expect(isCrossRemoteTool("mcp__cross-remote__something_else")).toBe(false);
  });
});

describe("CrossRemoteToolUse", () => {
  it("heads the call with the remote's name instead of its id", async () => {
    await render(
      <CrossRemoteToolUse
        tool="mcp__cross-remote__remote_bash"
        input={{ remoteId: SERVER.id, command: "ls -la /app", timeoutSec: 120 }}
      />,
    );

    expect(container.textContent).toContain("Run Command");
    expect(container.textContent).toContain("worker3");
    expect(container.textContent).not.toContain(SERVER.id);
    expect(container.textContent).toContain("ls -la /app");
    expect(container.textContent).toContain("120s");
    expect(apiMock.getRemoteServers).toHaveBeenCalledTimes(1);
  });

  it("falls back to a short id for a remote that is no longer listed", async () => {
    await render(
      <CrossRemoteToolUse
        tool="mcp__cross-remote__remote_bash"
        input={{ remoteId: "deadbeef-1111-2222-3333-444455556666", command: "ls" }}
      />,
    );

    expect(container.textContent).toContain("remote deadbeef");
  });

  it("reads a Codex-shaped call: bare tool name, string-encoded arguments", async () => {
    await render(
      <CrossRemoteToolUse
        tool="remote_read_file"
        input={JSON.stringify({ remoteId: SERVER.id, path: "/etc/hosts" })}
      />,
    );

    expect(container.textContent).toContain("Read File");
    expect(container.textContent).toContain("worker3");
    expect(container.textContent).toContain("/etc/hosts");
  });

  it("renames a card that stays mounted, the way the settings screen does", async () => {
    await render(<CrossRemoteToolUse tool="remote_bash" input={{ remoteId: SERVER.id, command: "ls" }} />);
    expect(container.textContent).toContain("worker3");

    // Same card, no remount: Remote Servers reloads its list after a rename and
    // publishes it, and the conversation is still mounted behind that screen.
    await act(async () => {
      publishRemoteServerNames([{ ...SERVER, name: "build-box" }]);
    });

    expect(container.textContent).toContain("build-box");
    expect(container.textContent).not.toContain("worker3");
  });

  it("picks up a rename once the cached list has gone stale", async () => {
    await render(<CrossRemoteToolUse key="a" tool="remote_bash" input={{ remoteId: SERVER.id, command: "ls" }} />);
    expect(container.textContent).toContain("worker3");

    apiMock.getRemoteServers.mockResolvedValue([{ ...SERVER, name: "build-box" }]);
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
    try {
      // A different key remounts the card, which is what revalidates.
      await render(<CrossRemoteToolUse key="b" tool="remote_bash" input={{ remoteId: SERVER.id, command: "ls" }} />);
    } finally {
      clock.mockRestore();
    }

    expect(container.textContent).toContain("build-box");
    expect(container.textContent).not.toContain("worker3");
  });

  it("shares one fetch across the cards of a conversation", async () => {
    await render(
      <>
        <CrossRemoteToolUse tool="remote_bash" input={{ remoteId: SERVER.id, command: "a" }} />
        <CrossRemoteToolUse tool="remote_bash" input={{ remoteId: SERVER.id, command: "b" }} />
        <CrossRemoteToolUse tool="remote_bash" input={{ remoteId: SERVER.id, command: "c" }} />
      </>,
    );

    expect(apiMock.getRemoteServers).toHaveBeenCalledTimes(1);
  });
});

describe("CrossRemoteToolResult", () => {
  it("unwraps stdout out of the envelope", async () => {
    await render(
      <CrossRemoteToolResult
        output={JSON.stringify({ stdout: "total 0\ndrwxr-xr-x app\n", stderr: "", exitCode: 0 })}
      />,
    );

    expect(container.textContent).toContain("drwxr-xr-x app");
    expect(container.textContent).not.toContain("\\n");
  });

  it("unwraps the MCP envelope Codex serializes around the worker's JSON", async () => {
    const workerJson = JSON.stringify({ stdout: "total 0\ndrwxr-xr-x app\n", stderr: "", exitCode: 0, timedOut: true }, null, 2);
    await render(
      <CrossRemoteToolResult output={JSON.stringify({ content: [{ type: "text", text: workerJson }] })} />,
    );

    expect(container.textContent).toContain("drwxr-xr-x app");
    expect(container.textContent).toContain("timed out");
    expect(container.textContent).not.toContain("stdout");
  });

  it("shows a gateway error carried inside the envelope as text", async () => {
    await render(
      <CrossRemoteToolResult
        output={JSON.stringify({ content: [{ type: "text", text: "Remote srv-1 is offline" }], isError: true })}
      />,
    );

    expect(container.textContent).toContain("Remote srv-1 is offline");
  });

  it("badges a timed-out, truncated, non-zero run", async () => {
    await render(
      <CrossRemoteToolResult
        output={JSON.stringify({ stdout: "partial", stderr: "boom", exitCode: 124, timedOut: true, truncated: true })}
      />,
    );

    expect(container.textContent).toContain("timed out");
    expect(container.textContent).toContain("exit 124");
    expect(container.textContent).toContain("truncated");
  });

  it("shows a gateway error as the plain text it is", async () => {
    await render(<CrossRemoteToolResult output="Call to remote srv-1 failed: Request timed out after 30000ms" />);

    expect(container.textContent).toContain("Request timed out after 30000ms");
  });
});
