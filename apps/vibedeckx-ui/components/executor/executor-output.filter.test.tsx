// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExecutorOutput, type TerminalFocusHandle } from "./executor-output";

// A Terminal stub with a fake rendered buffer. The filter reads
// `buffer.active` and re-runs on `onWriteParsed`, so the test drives both
// directly instead of pushing bytes through write().
const fake = vi.hoisted(() => ({
  rows: [] as Array<{ text: string; wrapped?: boolean }>,
  listeners: [] as Array<() => void>,
  focusCalls: 0,
  disposedSubs: 0,
  onData: null as ((d: string) => void) | null,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    buffer = {
      active: {
        get length() {
          return fake.rows.length;
        },
        getLine: (y: number) =>
          fake.rows[y] && {
            isWrapped: fake.rows[y].wrapped ?? false,
            translateToString: () => fake.rows[y].text,
          },
      },
    };
    loadAddon() {}
    open() {}
    write(_d: string, cb?: () => void) { cb?.(); }
    onData(cb: (d: string) => void) { fake.onData = cb; }
    onResize() {}
    onWriteParsed(cb: () => void) {
      fake.listeners.push(cb);
      return {
        dispose: () => {
          fake.listeners = fake.listeners.filter((l) => l !== cb);
          fake.disposedSubs++;
        },
      };
    }
    attachCustomKeyEventHandler() {}
    focus() { fake.focusCalls++; }
    // reset() empties the buffer and, like the real thing, does NOT fire
    // onWriteParsed.
    reset() { fake.rows = []; }
    scrollToBottom() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() { return { cols: 80, rows: 24 }; }
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@/hooks/use-terminal-settings", () => ({
  useTerminalSettings: () => ({
    settings: { fontSize: 13, fontFamily: "monospace", scrollback: 1000 },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  // Run the rAF-coalesced recompute synchronously.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  fake.rows = [
    { text: "INFO server started" },
    { text: "ERROR db connection refused" },
    { text: "info request GET /health" },
    { text: "error: request timeout" },
    { text: "" },
    { text: "" },
  ];
  fake.listeners = [];
  fake.focusCalls = 0;
  fake.disposedSubs = 0;
  fake.onData = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T | null;
const filterButton = () =>
  q<HTMLButtonElement>(
    'button[aria-label="Filter output lines"], button[aria-label="Close filter input"]'
  )!;
const input = () => q<HTMLInputElement>('input[aria-label="Add terminal filter"]');
const view = () => q<HTMLElement>('[data-testid="terminal-filter-view"]');
const chips = () => Array.from(document.querySelectorAll('[data-testid="terminal-filter-chip"]'));
const viewLines = () =>
  Array.from(view()?.querySelectorAll("pre > div") ?? []).map((d) => d.textContent);
const count = () => q<HTMLElement>('[data-testid="terminal-filter-count"]')?.textContent;

function key(el: Element, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

function addFilter(text: string) {
  const el = input()!;
  el.value = text;
  key(el, "Enter");
}

function render(isPty: boolean, extra: Partial<ComponentProps<typeof ExecutorOutput>> = {}) {
  act(() => {
    root!.render(<ExecutorOutput logs={[]} isPty={isPty} {...extra} />);
  });
}

describe("ExecutorOutput line filter", () => {
  it("opens an input, applies a chip on Enter and shows only matching buffer lines", () => {
    render(false);
    expect(input()).toBeNull();
    expect(view()).toBeNull();

    act(() => filterButton().click());
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());

    addFilter("error");
    expect(chips().map((c) => c.textContent)).toEqual(["error"]);
    expect(input()!.value).toBe(""); // box cleared for the next chip
    expect(viewLines()).toEqual(["ERROR db connection refused", "error: request timeout"]);
    // Trailing blank rows are not counted.
    expect(count()).toBe("2 / 4");
    expect(filterButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("narrows with a second chip and hides with a negated one", () => {
    render(false);
    act(() => filterButton().click());
    addFilter("request");
    expect(viewLines()).toEqual(["info request GET /health", "error: request timeout"]);

    addFilter("-info");
    expect(chips().map((c) => c.getAttribute("data-negate"))).toEqual([null, "true"]);
    expect(viewLines()).toEqual(["error: request timeout"]);
    expect(count()).toBe("1 / 4");
  });

  it("removes chips via × and Backspace-on-empty, and drops the overlay when none remain", () => {
    render(false);
    act(() => filterButton().click());
    addFilter("error");
    addFilter("timeout");
    expect(viewLines()).toEqual(["error: request timeout"]);

    // Backspace in the empty box pops the last chip.
    key(input()!, "Backspace");
    expect(chips().map((c) => c.textContent)).toEqual(["error"]);
    expect(viewLines()).toEqual(["ERROR db connection refused", "error: request timeout"]);

    act(() => q<HTMLButtonElement>('button[aria-label="Remove filter error"]')!.click());
    expect(chips()).toEqual([]);
    expect(view()).toBeNull();
    expect(count()).toBeUndefined();
    // Subscription on the terminal was torn down with the last filter.
    expect(fake.listeners).toEqual([]);
    expect(fake.disposedSubs).toBeGreaterThan(0);
  });

  it("re-filters when the terminal parses new output, joining wrapped rows", () => {
    render(false);
    act(() => filterButton().click());
    addFilter("timeout");
    expect(viewLines()).toEqual(["error: request timeout"]);

    // New output lands at the cursor, above the unused blank rows.
    fake.rows.splice(4, 0, { text: "WARN slow upstream, tim" }, { text: "eout in 30s", wrapped: true });
    act(() => fake.listeners.forEach((l) => l()));
    expect(viewLines()).toEqual(["error: request timeout", "WARN slow upstream, timeout in 30s"]);
    expect(count()).toBe("2 / 5");
  });

  it("ignores blank input and shows an empty state when nothing matches", () => {
    render(false);
    act(() => filterButton().click());
    addFilter("   ");
    expect(chips()).toEqual([]);
    expect(view()).toBeNull();

    addFilter("zzz-no-such-line");
    expect(view()!.textContent).toContain("No lines match");
    expect(count()).toBe("0 / 4");
  });

  it("Escape closes the box and returns focus to a PTY shell only when unfiltered", () => {
    render(true);
    act(() => filterButton().click());
    fake.focusCalls = 0;
    key(input()!, "Escape");
    expect(input()).toBeNull();
    expect(fake.focusCalls).toBe(1);

    act(() => filterButton().click());
    addFilter("error");
    fake.focusCalls = 0;
    key(input()!, "Escape");
    expect(input()).toBeNull();
    // Overlay still covers the terminal — focusing it would be pointless.
    expect(fake.focusCalls).toBe(0);
    expect(view()!.textContent).toContain("clear filters to type into the shell");
  });

  it("offers a copy of the filtered lines", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(false);
    expect(q('button[aria-label="Copy filtered lines"]')).toBeNull();
    act(() => filterButton().click());
    addFilter("error");
    await act(async () => {
      q<HTMLButtonElement>('button[aria-label="Copy filtered lines"]')!.click();
    });
    expect(writeText).toHaveBeenCalledWith("ERROR db connection refused\nerror: request timeout");
  });

  it("blocks shell input and auto-focus while a filter covers the terminal", () => {
    const onInput = vi.fn();
    const handle: { current: TerminalFocusHandle | null } = { current: null };
    render(true, { onInput, focusHandle: handle });
    fake.onData!("a");
    expect(onInput).toHaveBeenCalledWith("a");

    act(() => filterButton().click());
    addFilter("error");
    onInput.mockClear();
    fake.focusCalls = 0;

    // Keystrokes that reach xterm are dropped rather than sent blind.
    fake.onData!("b");
    expect(onInput).not.toHaveBeenCalled();
    // Maximize and the host's focus handle both leave focus alone.
    act(() =>
      q<HTMLButtonElement>('button[aria-label="Maximize terminal"]')!.click()
    );
    act(() => handle.current!.focus());
    expect(fake.focusCalls).toBe(0);

    // Clearing the filter restores both. The filter box is still open, so
    // the maximized terminal does not grab focus by itself (see the
    // Backspace test below); the host's handle works again.
    act(() => q<HTMLButtonElement>('button[aria-label="Remove filter error"]')!.click());
    expect(fake.focusCalls).toBe(0);
    fake.onData!("c");
    expect(onInput).toHaveBeenCalledWith("c");
    act(() => handle.current!.focus());
    expect(fake.focusCalls).toBe(1);
  });

  it("refreshes the filtered view when the log is cleared, even with no further output", () => {
    const out = (data: string) => ({ type: "stdout" as const, data });
    render(false, { logs: [out("x"), out("y")] });
    act(() => filterButton().click());
    addFilter("error");
    expect(viewLines()).toEqual(["ERROR db connection refused", "error: request timeout"]);

    // Fewer logs than already written → the component reset()s the terminal.
    render(false, { logs: [] });
    expect(fake.rows).toEqual([]);
    expect(view()!.textContent).toContain("No lines match");
    expect(count()).toBe("0 / 0");
  });

  it("ignores Enter while an IME composition is in progress", () => {
    render(false);
    act(() => filterButton().click());
    const el = input()!;
    el.value = "错误";
    key(el, "Enter", { isComposing: true });
    expect(chips()).toEqual([]);
    expect(el.value).toBe("错误"); // draft kept for the composition to finish
    key(el, "Enter");
    expect(chips().map((c) => c.textContent)).toEqual(["错误"]);
  });

  it("keeps focus in the open filter box when the last chip is removed while maximized", () => {
    const onInput = vi.fn();
    render(true, { onInput });
    act(() =>
      q<HTMLButtonElement>('button[aria-label="Maximize terminal"]')!.click()
    );
    act(() => filterButton().click());
    addFilter("error");
    fake.focusCalls = 0;

    key(input()!, "Backspace");
    expect(chips()).toEqual([]);
    expect(document.activeElement).toBe(input());
    expect(fake.focusCalls).toBe(0);

    // The next filter word goes into the box, not the shell.
    addFilter("timeout");
    expect(chips().map((c) => c.textContent)).toEqual(["timeout"]);
    expect(onInput).not.toHaveBeenCalled();

    // Esc with no chips left is what hands focus to the shell (closeFilterInput
    // and the maximize effect may each do so; either way it lands there).
    key(input()!, "Backspace");
    key(input()!, "Escape");
    expect(input()).toBeNull();
    expect(fake.focusCalls).toBeGreaterThan(0);
  });
});
