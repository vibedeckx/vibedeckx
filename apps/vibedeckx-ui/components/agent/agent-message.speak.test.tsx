// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const player = vi.hoisted(() => {
  let state: { status: string; ownerKey?: string; chunk?: number; total?: number } = { status: "idle" };
  const listeners = new Set<() => void>();
  return {
    toggle: vi.fn(),
    set(next: typeof state) {
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    get: () => state,
  };
});

vi.mock("@/lib/tts/tts-player", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    ttsPlayer: { toggle: player.toggle },
    useTtsState: () => useSyncExternalStore(player.subscribe, player.get, player.get),
    useTtsOwnedBy: (key: string) => {
      const owned = () => player.get().status !== "idle" && player.get().ownerKey === key;
      return useSyncExternalStore(player.subscribe, owned, owned);
    },
  };
});

import { AgentMessageItem } from "./agent-message";
import type { AgentMessage } from "@/hooks/use-agent-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  player.set({ status: "idle" });
  player.toggle.mockReset();
});

describe("AgentMessageItem read-aloud", () => {
  it("gives identical replies separate playback controls", () => {
    const message = { type: "assistant", content: "好的。", timestamp: 1 } as AgentMessage;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <>
          <AgentMessageItem message={message} messageIndex={0} entryIndex={1} />
          <AgentMessageItem message={message} messageIndex={1} entryIndex={3} />
        </>,
      ),
    );

    const buttons = () => Array.from(container!.querySelectorAll<HTMLButtonElement>('button[aria-label="Read aloud"], button[aria-label="Stop reading"]'));
    expect(buttons()).toHaveLength(2);

    act(() => buttons()[0].click());
    const firstKey = player.toggle.mock.calls[0][0] as string;
    act(() => buttons()[1].click());
    const secondKey = player.toggle.mock.calls[1][0] as string;
    expect(firstKey).not.toBe(secondKey);

    act(() => player.set({ status: "playing", ownerKey: firstKey, chunk: 0, total: 1 }));
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual(["Stop reading", "Read aloud"]);

    // The playing message's view-source / copy buttons stay pinned alongside
    // its speak button; the other message's stay hover-revealed.
    const copyButtons = Array.from(container!.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy source"]'));
    expect(copyButtons[0].className).toContain("opacity-100");
    expect(copyButtons[0].className).not.toContain("opacity-0");
    expect(copyButtons[1].className).toContain("opacity-0");
  });
});
