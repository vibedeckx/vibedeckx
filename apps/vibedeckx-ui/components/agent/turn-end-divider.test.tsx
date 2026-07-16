// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TurnEndDivider } from "./turn-end-divider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const baseProps = {
  agentType: "claude-code" as const,
  currentAgentName: "Claude Code",
  alternateProviders: [],
  onBranch: () => {},
  emphasis: "subtle" as const,
};

describe("TurnEndDivider", () => {
  it("shows the formatted duration and an always-rendered branch button", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TurnEndDivider {...baseProps} durationMs={134_000} outcome="completed" />);
    });
    expect(container.textContent).toContain("2m 14s");
    expect(container.querySelector('button[aria-label="Branch conversation"]')).not.toBeNull();
  });

  it('shows "interrupted" when durationMs is absent (server_restart)', async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TurnEndDivider {...baseProps} outcome="server_restart" />);
    });
    expect(container.textContent).toContain("interrupted");
  });
});
