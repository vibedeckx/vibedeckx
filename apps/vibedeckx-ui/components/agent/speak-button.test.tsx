// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const player = vi.hoisted(() => {
  type State = { status: string; ownerKey?: string; chunk?: number; total?: number; code?: string; message?: string };
  let state: State = { status: "idle" };
  const listeners = new Set<() => void>();
  return {
    toggle: vi.fn(),
    set(next: State) {
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
  };
});

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { SpeakButton, speakOwnerKey } from "./speak-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

const button = () => container!.querySelector<HTMLButtonElement>("button");

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  player.set({ status: "idle" });
  player.toggle.mockReset();
  toastError.mockReset();
});

describe("SpeakButton", () => {
  it("is a hover-revealed speaker button that toggles playback", () => {
    render(<SpeakButton ownerKey="k1" text="Hello **world**" />);
    const b = button()!;
    expect(b.getAttribute("aria-label")).toBe("Read aloud");
    expect(b.className).toContain("group-hover:opacity-100");
    expect(b.className).toContain("opacity-0");
    act(() => b.click());
    expect(player.toggle).toHaveBeenCalledWith("k1", "Hello **world**");
  });

  it("renders nothing when there is nothing to say", () => {
    render(<SpeakButton ownerKey="k1" text={"```bash\nls\n```"} />);
    expect(button()).toBeNull();
  });

  it("stays visible and offers stop while its own message plays", () => {
    render(<SpeakButton ownerKey="k1" text="Hello" />);
    act(() => player.set({ status: "playing", ownerKey: "k1", chunk: 1, total: 3 }));
    const b = button()!;
    expect(b.getAttribute("aria-label")).toBe("Stop reading");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.className).toContain("opacity-100");
    expect(b.className).not.toContain("opacity-0");
    expect(b.title).toBe("Stop reading (2/3)");
  });

  it("ignores another message's playback", () => {
    render(<SpeakButton ownerKey="k1" text="Hello" />);
    act(() => player.set({ status: "playing", ownerKey: "k2", chunk: 0, total: 1 }));
    expect(button()!.getAttribute("aria-label")).toBe("Read aloud");
  });

  it("toasts once on a not-configured error", () => {
    render(<SpeakButton ownerKey="k1" text="Hello" />);
    act(() => player.set({ status: "error", ownerKey: "k1", code: "not_configured", message: "x" }));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe("Text-to-speech is not configured");
  });
});

describe("speakOwnerKey", () => {
  it("tells identical replies apart by entry index", () => {
    expect(speakOwnerKey("s1", "好的。", 3)).not.toBe(speakOwnerKey("s1", "好的。", 7));
    expect(speakOwnerKey("s1", "好的。", 3)).toBe(speakOwnerKey("s1", "好的。", 3));
  });

  it("is stable per content and scoped by session", () => {
    expect(speakOwnerKey("s1", "abc")).toBe(speakOwnerKey("s1", "abc"));
    expect(speakOwnerKey("s1", "abc")).not.toBe(speakOwnerKey("s1", "abd"));
    expect(speakOwnerKey("s1", "abc").startsWith("s1:")).toBe(true);
    expect(speakOwnerKey(null, "abc").startsWith("none:")).toBe(true);
  });
});
