// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@/hooks/use-chat-session";

const chat = vi.hoisted(() => ({
  messages: [] as AgentMessage[],
  status: "waiting" as string,
  turnState: { status: "waiting", waitingFor: ['executor "build" on local'] } as { status: string; waitingFor: string[] },
  stopGeneration: vi.fn(),
  draft: "",
}));
vi.mock("@/hooks/use-chat-session", () => ({ useChatSession: () => ({
  session: { id: "chat", eventListeningEnabled: false }, messages: chat.messages,
  status: chat.status, turnState: chat.turnState, isInitialized: true, isLoading: false, error: null,
  sendMessage: vi.fn(), stopGeneration: chat.stopGeneration, restartSession: vi.fn(),
  workflowRunUpdate: null, streamEpoch: 0, draft: chat.draft, setDraft: vi.fn(), setEventListening: vi.fn(),
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
vi.mock("@/components/commands/commands-menu", () => ({ CommandsMenu: () => null }));
vi.mock("@/hooks/use-commands", () => ({ useCommands: () => ({ commands: [], createCommand: vi.fn(), updateCommand: vi.fn(), deleteCommand: vi.fn() }) }));
import { MainConversation } from "./main-conversation";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Main Chat while its turn waits", () => {
  const render = async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<MainConversation projectId="project" branch="dev" />));
    return { host, root };
  };

  const byLabel = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it("keeps the composer open, turns Send into Stop, and says what it is waiting for", async () => {
    chat.status = "waiting";
    chat.draft = "";
    const { host, root } = await render();
    expect(host.querySelector("textarea")?.disabled).toBe(false);
    expect(host.querySelector('[data-testid="turn-waiting-for"]')?.textContent).toBe('Waiting for executor "build" on local');
    const stop = byLabel(host, "Stop");
    expect(stop).toBeDefined();
    await act(async () => stop!.click());
    expect(chat.stopGeneration).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("a typed addition while waiting flips the button back to Send", async () => {
    chat.status = "waiting";
    chat.draft = "also run the tests";
    const { host, root } = await render();
    expect(byLabel(host, "Stop")).toBeNull();
    expect([...host.querySelectorAll("button")].find((button) => button.textContent === "Send")?.disabled).toBe(false);
    chat.draft = "";
    await act(async () => root.unmount());
  });

  it("while a reply streams the composer is locked and Stop says so", async () => {
    chat.status = "running";
    const { host, root } = await render();
    expect(host.querySelector("textarea")?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="turn-waiting-for"]')).toBeNull();
    expect(byLabel(host, "Stop generating")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("idle shows neither", async () => {
    chat.status = "stopped";
    const { host, root } = await render();
    expect(host.querySelector('[data-testid="turn-waiting-for"]')).toBeNull();
    expect(byLabel(host, "Stop")).toBeNull();
    expect(byLabel(host, "Stop generating")).toBeNull();
    await act(async () => root.unmount());
  });
});
