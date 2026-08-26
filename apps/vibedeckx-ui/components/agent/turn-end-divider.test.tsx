// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

describe("TurnEndDivider finalize affordance", () => {
  const finalizeBaseProps = {
    durationMs: 1000,
    emphasis: "normal" as const,
    agentType: "claude-code" as const,
    currentAgentName: "Claude Code",
    alternateProviders: [],
    onBranch: vi.fn(),
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("renders an icon-only finalize button with a tooltip, and clicking calls onFinalize", () => {
    const onFinalize = vi.fn();
    act(() => {
      root!.render(<TurnEndDivider {...finalizeBaseProps} showFinalize onFinalize={onFinalize} />);
    });
    const btn = container!.querySelector<HTMLButtonElement>(
      '[data-slot="tooltip-trigger"][aria-label="生成 review 终稿"]',
    )!;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe("");
    act(() => { btn.click(); });
    expect(onFinalize).toHaveBeenCalledTimes(1);

    act(() => {
      root!.render(<TurnEndDivider {...finalizeBaseProps} />);
    });
    expect(
      container!.querySelector('button[aria-label="生成 review 终稿"]'),
    ).toBeNull();
  });

  it("disables the button while finalizeBusy", () => {
    act(() => {
      root!.render(<TurnEndDivider {...finalizeBaseProps} showFinalize finalizeBusy onFinalize={vi.fn()} />);
    });
    const btn = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 review 终稿"]',
    )!;
    expect(btn.disabled).toBe(true);
  });
});

describe("TurnEndDivider send-back affordance", () => {
  const dividerProps = {
    durationMs: 1000,
    emphasis: "normal" as const,
    agentType: "claude-code" as const,
    currentAgentName: "Claude Code",
    alternateProviders: [],
    onBranch: vi.fn(),
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const sendBackBtn = () =>
    container!.querySelector<HTMLButtonElement>('button[aria-label="发回源会话"]');

  it("is absent without a sendBack control (non-branch sessions)", () => {
    act(() => {
      root!.render(<TurnEndDivider {...dividerProps} />);
    });
    expect(sendBackBtn()).toBeNull();
  });

  it("opens a confirm popover with the composed content and only sends on confirm", () => {
    const onSend = vi.fn();
    const getContent = vi.fn(() => "preamble\n\nanswer");
    act(() => {
      root!.render(<TurnEndDivider {...dividerProps} sendBack={{
        available: true, sent: false, busy: false, getContent, onSend,
      }} />);
    });
    const btn = sendBackBtn()!;
    expect(btn.disabled).toBe(false);
    act(() => { btn.click(); });
    // Opening previews but does not send.
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("preamble");
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "确认发回")!;
    act(() => { confirm.click(); });
    expect(onSend).toHaveBeenCalledWith("preamble\n\nanswer");
  });

  it("shows the no-text notice when the turn produced no answer", () => {
    const onSend = vi.fn();
    act(() => {
      root!.render(<TurnEndDivider {...dividerProps} sendBack={{
        available: true, sent: false, busy: false, getContent: () => null, onSend,
      }} />);
    });
    act(() => { sendBackBtn()!.click(); });
    expect(document.body.textContent).toContain("本轮没有可发回的文本回复");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables the button when the parent session is gone", () => {
    act(() => {
      root!.render(<TurnEndDivider {...dividerProps} sendBack={{
        available: false, sent: false, busy: false, getContent: () => "x", onSend: vi.fn(),
      }} />);
    });
    expect(sendBackBtn()!.disabled).toBe(true);
  });
});
