// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TerminalPanel } from "./terminal-panel";

const state = vi.hoisted(() => ({
  activeTerminalId: "term-1" as string | null,
  terminalIds: ["term-1", "term-2"],
  connected: [] as string[],
  disconnected: [] as string[],
}));

// Terminal ids that were asked for keyboard focus, in order.
const focused = vi.hoisted(() => [] as string[]);

vi.mock("@/hooks/use-terminals", () => ({
  useTerminals: () => ({
    terminals: state.terminalIds.map((id) => ({ id, name: id, location: "local" })),
    activeTerminalId: state.activeTerminalId,
    createTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    setActiveTerminal: vi.fn(),
    removeTerminal: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-executor-logs", async () => {
  const { useEffect } = await import("react");
  return {
    useExecutorLogs: (id: string) => {
      useEffect(() => {
        state.connected.push(id);
        return () => { state.disconnected.push(id); };
      }, [id]);
      return {
        logs: [{ data: id }],
        sendInput: vi.fn(),
        sendResize: vi.fn(),
        exitCode: null,
        replayingHistory: false,
      };
    },
  };
});

vi.mock("@/hooks/project-remotes-context", () => ({
  useProjectRemotesContext: () => ({ remotes: [] }),
}));

vi.mock("@/components/executor/executor-output", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    ExecutorOutput: ({ focusHandle, logs }: { focusHandle: React.Ref<{ focus: () => void }>; logs: { data: string }[] }) => {
      const id = logs[0].data;
      useImperativeHandle(focusHandle, () => ({ focus: () => focused.push(id) }), [id]);
      return <div data-terminal-id={id}>terminal window</div>;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  focused.length = 0;
  state.activeTerminalId = "term-1";
  state.terminalIds = ["term-1", "term-2"];
  state.connected.length = 0;
  state.disconnected.length = 0;
});

function render(active: boolean) {
  act(() => {
    root!.render(<TerminalPanel projectId="project-1" selectedBranch="dev" active={active} />);
  });
}

function mount(active: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render(active);
}

describe("TerminalPanel focus handoff", () => {
  it("focuses the shell only once the tab is on screen", () => {
    mount(false);
    expect(focused).toEqual([]);

    render(true);
    expect(focused).toEqual(["term-1"]);
  });

  it("re-focuses when the shown terminal changes while the tab is open", () => {
    mount(true);
    expect(focused).toEqual(["term-1"]);

    state.activeTerminalId = "term-2";
    render(true);

    expect(focused).toEqual(["term-1", "term-2"]);
  });

  it("does not focus a terminal while the tab is hidden", () => {
    mount(true);

    render(false);
    state.activeTerminalId = "term-2";
    render(false);

    expect(focused).toEqual(["term-1"]);
  });
});

describe("TerminalPanel instance lifetime", () => {
  it("preserves terminal DOM and log subscriptions when switching away and back", () => {
    mount(true);
    const first = container!.querySelector('[data-terminal-id="term-1"]')!;
    const second = container!.querySelector('[data-terminal-id="term-2"]')!;
    expect(first.parentElement!.classList.contains("hidden")).toBe(false);
    expect(second.parentElement!.classList.contains("hidden")).toBe(true);

    state.activeTerminalId = "term-2";
    render(true);
    expect(first.parentElement!.classList.contains("hidden")).toBe(true);
    expect(second.parentElement!.classList.contains("hidden")).toBe(false);

    state.activeTerminalId = "term-1";
    render(true);
    expect(container!.querySelector('[data-terminal-id="term-1"]')).toBe(first);
    expect(container!.querySelector('[data-terminal-id="term-2"]')).toBe(second);
    expect(first.parentElement!.classList.contains("hidden")).toBe(false);
    expect(state.connected).toEqual(["term-1", "term-2"]);
    expect(state.disconnected).toEqual([]);
    expect(focused).toEqual(["term-1", "term-2", "term-1"]);
  });

  it("cleans up only the removed terminal, then all remaining terminals on unmount", () => {
    mount(true);
    state.terminalIds = ["term-1"];
    render(true);
    expect(state.disconnected).toEqual(["term-2"]);
    expect(container!.querySelector('[data-terminal-id="term-2"]')).toBeNull();
    expect(state.connected).toEqual(["term-1", "term-2"]);

    act(() => root!.unmount());
    root = null;
    expect(state.disconnected).toEqual(["term-2", "term-1"]);
  });
});
