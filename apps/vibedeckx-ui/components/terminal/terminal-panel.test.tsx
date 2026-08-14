// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TerminalPanel } from "./terminal-panel";

const state = vi.hoisted(() => ({
  activeTerminalId: "term-1" as string | null,
}));

// Terminal ids that were asked for keyboard focus, in order.
const focused = vi.hoisted(() => [] as string[]);

vi.mock("@/hooks/use-terminals", () => ({
  useTerminals: () => ({
    terminals: [
      { id: "term-1", name: "Terminal 1", location: "local" },
      { id: "term-2", name: "Terminal 2", location: "local" },
    ],
    activeTerminalId: state.activeTerminalId,
    createTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    setActiveTerminal: vi.fn(),
    removeTerminal: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-executor-logs", () => ({
  useExecutorLogs: () => ({
    logs: [],
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    exitCode: null,
    replayingHistory: false,
  }),
}));

vi.mock("@/hooks/project-remotes-context", () => ({
  useProjectRemotesContext: () => ({ remotes: [] }),
}));

vi.mock("@/components/executor/executor-output", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    ExecutorOutput: ({ focusHandle }: { focusHandle: React.Ref<{ focus: () => void }> }) => {
      const id = state.activeTerminalId ?? "";
      useImperativeHandle(focusHandle, () => ({ focus: () => focused.push(id) }), [id]);
      return <div>terminal window</div>;
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
