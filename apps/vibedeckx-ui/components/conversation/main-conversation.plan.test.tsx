// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@/hooks/use-chat-session";

const chat = vi.hoisted(() => ({ messages: [] as AgentMessage[] }));
vi.mock("@/hooks/use-chat-session", () => ({ useChatSession: () => ({
  session: { id: "chat", eventListeningEnabled: false }, messages: chat.messages,
  status: "stopped", isInitialized: true, isLoading: false, error: null,
  sendMessage: vi.fn(), stopGeneration: vi.fn(), restartSession: vi.fn(),
  workflowRunUpdate: null, streamEpoch: 0, draft: "", setDraft: vi.fn(), setEventListening: vi.fn(),
}) }));
vi.mock("@/hooks/use-conversation-settings", () => ({ useConversationSettings: () => ({ settings: { chatFontSize: 14 } }) }));
vi.mock("use-stick-to-bottom", () => ({ useStickToBottomContext: () => ({ scrollToBottom: vi.fn() }) }));
vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: ReactNode }) => <div data-testid="scrolling-chat">{children}</div>,
  ConversationContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}));
vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInput: ({ children }: { children: ReactNode }) => <form data-testid="composer">{children}</form>,
  PromptInputTextarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  PromptInputSubmit: (props: ComponentProps<"button">) => <button {...props}>Send</button>,
}));
vi.mock("./review-run-panel", () => ({ ReviewRunPanel: () => null }));
vi.mock("./new-loop-dialog", () => ({ NewLoopDialog: () => null }));
import { MainConversation } from "./main-conversation";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Main Chat pinned plan layout", () => {
  it("keeps the plan outside the message scroller, above the input, and removes it on reset", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    chat.messages = [{ type: "tool_result", tool: "setPlan", timestamp: 0, output: JSON.stringify({ success: true, plan: {
      planId: "plan", goal: "Run checks", completionCriteria: ["Checks pass"],
      steps: [{ id: "test", title: "Run tests", status: "in_progress" }],
    } }) }];
    try {
      await act(async () => root.render(<MainConversation projectId="project" branch="dev" />));
      const panel = host.querySelector('section[aria-label="Current task plan"]')!;
      const scroll = host.querySelector('[data-testid="scrolling-chat"]')!;
      const composer = host.querySelector('[data-testid="composer"]')!;
      expect(panel).not.toBeNull();
      expect(scroll.contains(panel)).toBe(false);
      expect(composer.parentElement!.contains(panel)).toBe(true);
      expect(panel.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scroll.textContent).not.toContain("Run checks");
      chat.messages = [...chat.messages, { type: "tool_result", tool: "setPlan", timestamp: 1, output: JSON.stringify({ success: true, plan: {
        planId: "next-plan", goal: "Next task", completionCriteria: ["Preview ready"],
        steps: [{ id: "preview", title: "Start preview", status: "pending" }],
      } }) }];
      await act(async () => root.render(<MainConversation projectId="project" branch="dev" />));
      expect(scroll.textContent).toContain("Run checks"); // Previous plans become history.
      expect(scroll.textContent).not.toContain("Next task");
      expect(host.querySelector('section[aria-label="Current task plan"]')?.textContent).toContain("Next task");
      chat.messages = [];
      await act(async () => root.render(<MainConversation projectId="project" branch="dev" />));
      expect(host.querySelector('section[aria-label="Current task plan"]')).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
  it("shows current plan confirmation controls only in the pinned panel", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    chat.messages = [{ type: "tool_approval_request", tool: "setPlan", timestamp: 0, approvalId: "review", input: {
      goal: "Review login", completionCriteria: ["Login works"],
      steps: [{ id: "login", title: "Verify login", status: "pending" }],
    } }];
    try {
      await act(async () => root.render(<MainConversation projectId="project" branch="dev" />));
      const scroll = host.querySelector('[data-testid="scrolling-chat"]')!;
      expect(scroll.textContent).not.toContain("Review login");
      expect(scroll.textContent).not.toContain("Confirm and execute");
      const confirm = [...host.querySelectorAll("button")].filter((button) => button.textContent?.includes("Confirm and execute"));
      expect(confirm).toHaveLength(1);
      expect(host.querySelector('section[aria-label="Current task plan"]')?.contains(confirm[0])).toBe(true);
    } finally { await act(async () => root.unmount()); }
  });

});
