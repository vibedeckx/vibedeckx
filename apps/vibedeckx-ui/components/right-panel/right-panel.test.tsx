// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RightPanel } from "./right-panel";

vi.mock("@/hooks/use-file-ref-index", () => ({
  useFileRefIndex: () => null,
}));

vi.mock("@/components/executor", () => ({
  ExecutorPanel: () => <div>Executors panel</div>,
}));

vi.mock("@/components/diff", () => ({
  DiffPanel: () => <div>Diff panel</div>,
}));

vi.mock("@/components/terminal", () => ({
  TerminalPanel: () => <div>Terminal panel</div>,
}));

vi.mock("@/components/preview", () => ({
  PreviewPanel: () => <div>Browser panel</div>,
}));

vi.mock("@/components/files", () => ({
  FilesView: () => <div>Files panel</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  localStorage.clear();
  if (realPlatform) Object.defineProperty(Navigator.prototype, "platform", realPlatform);
});

function setPlatform(platform: string) {
  Object.defineProperty(Navigator.prototype, "platform", {
    get: () => platform,
    configurable: true,
  });
}

function pressKey(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

function renderPanel(activateAgentTabNonce: number, active = true) {
  act(() => {
    root!.render(
      <RightPanel
        projectId="project-1"
        selectedBranch="dev"
        activateAgentTabNonce={activateAgentTabNonce}
        agentSlot={<div>Agent panel</div>}
        active={active}
      />,
    );
  });
}

function mountPanel(active = true) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  renderPanel(0, active);
}

describe("RightPanel", () => {
  it("switches back to the Agent tab when an external session selection asks for it", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    renderPanel(0);

    const terminalTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Terminal",
    );
    expect(terminalTab).toBeTruthy();

    act(() => {
      terminalTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Terminal panel");

    renderPanel(1);

    const agentTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Agent",
    );
    expect(agentTab?.className).toContain("border-primary");
    expect(localStorage.getItem("vibedeckx:activeTab:project-1:dev")).toBe("agent");
  });

  describe("tab keyboard shortcuts", () => {
    function activeTabLabel() {
      return Array.from(container!.querySelectorAll("button")).find((button) =>
        button.className.includes("border-primary"),
      )?.textContent;
    }

    it("switches tabs with Ctrl+Alt+<letter> on non-mac platforms", () => {
      setPlatform("Win32");
      mountPanel();

      pressKey({ code: "KeyD", ctrlKey: true, altKey: true });
      expect(activeTabLabel()).toBe("Diff");

      pressKey({ code: "KeyT", ctrlKey: true, altKey: true });
      expect(activeTabLabel()).toBe("Terminal");

      pressKey({ code: "KeyA", ctrlKey: true, altKey: true });
      expect(activeTabLabel()).toBe("Agent");
      expect(localStorage.getItem("vibedeckx:activeTab:project-1:dev")).toBe("agent");
    });

    it("switches tabs with Ctrl+Shift+<letter> on mac and ignores the non-mac combo", () => {
      setPlatform("MacIntel");
      mountPanel();

      pressKey({ code: "KeyB", ctrlKey: true, shiftKey: true });
      expect(activeTabLabel()).toBe("Browser");

      // The Windows combo must not fire on mac.
      pressKey({ code: "KeyD", ctrlKey: true, altKey: true });
      expect(activeTabLabel()).toBe("Browser");
    });

    it("ignores shortcuts when extra modifiers are held or the panel is inactive", () => {
      setPlatform("Win32");
      mountPanel();

      pressKey({ code: "KeyE", ctrlKey: true, altKey: true, shiftKey: true });
      expect(activeTabLabel()).toBe("Agent");

      renderPanel(0, false);
      pressKey({ code: "KeyE", ctrlKey: true, altKey: true });
      renderPanel(0, true);
      expect(activeTabLabel()).toBe("Agent");
    });
  });
});
