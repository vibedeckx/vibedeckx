// @vitest-environment jsdom
// The executor list's keyboard cursor: a "current executor" that exists with
// no locate query typed, survives Enter, and hands off to/from a query.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocateProvider } from "@/components/locate/locate-context";
import { FocusRegionProvider } from "@/components/locate/focus-region";
import { ExecutorPanel } from "./executor-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom ships neither CSS.escape nor scrollIntoView; the panel uses both to
// find and reveal a row.
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= {
  escape: (value: string) => value,
};
Element.prototype.scrollIntoView ??= () => {};

const EXECUTORS = [
  { id: "e1", name: "dev server" },
  { id: "e2", name: "build watch" },
  { id: "e3", name: "tests" },
];

let commits: string[] = [];

vi.mock("@/hooks/use-executors", () => ({
  useExecutors: () => ({
    executors: EXECUTORS,
    loading: false,
    createExecutor: vi.fn(),
    updateExecutor: vi.fn(),
    deleteExecutor: vi.fn(),
    startExecutor: vi.fn(),
    stopExecutor: vi.fn(),
    markProcessFinished: vi.fn(),
    reorderExecutors: vi.fn(),
  }),
}));

vi.mock("@/hooks/project-remotes-context", () => ({
  useProjectRemotesContext: () => ({ remotes: [] }),
}));

vi.mock("@/hooks/executor-logs-context", () => ({
  ExecutorLogsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Stand-in row: exposes the mark as an attribute and the Start/Stop button the
// panel clicks on commit.
vi.mock("./executor-item", () => ({
  ExecutorItem: ({
    executor,
    keyboardSelected,
  }: {
    executor: { id: string; name: string };
    keyboardSelected?: boolean;
  }) => (
    <div data-locate-id={executor.id} data-marked={keyboardSelected ? "yes" : "no"}>
      {executor.name}
      <button data-locate-action onClick={() => commits.push(executor.id)}>
        run
      </button>
    </div>
  ),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  commits = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <FocusRegionProvider>
        <LocateProvider>
          <div data-focus-region="right-panel">
            <ExecutorPanel projectId="p1" project={{ path: "/tmp/p" } as never} locateActive />
          </div>
        </LocateProvider>
      </FocusRegionProvider>,
    );
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

const marked = () => container!.querySelector('[data-marked="yes"]')?.getAttribute("data-locate-id") ?? null;

// A tab click claims the keyboard region; a tab restored from storage on page
// load does not, which is why every keyboard test opts in explicitly.
const claimRegion = () => {
  act(() => {
    container!
      .querySelector("[data-focus-region]")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
};

const press = (key: string, target: EventTarget = window) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

describe("executor panel keyboard cursor", () => {
  it("marks the first executor as soon as the tab is visible", () => {
    // No region claim: the page-load path where the tab is restored from
    // storage still opens with a current executor.
    expect(marked()).toBe("e1");
  });

  it("ignores the arrow keys until the panel owns the keyboard", () => {
    press("ArrowDown");
    expect(marked()).toBe("e1");
    claimRegion();
    press("ArrowDown");
    expect(marked()).toBe("e2");
  });

  it("moves the mark with ArrowDown/ArrowUp and wraps", () => {
    claimRegion();
    press("ArrowDown");
    expect(marked()).toBe("e2");
    press("ArrowUp");
    expect(marked()).toBe("e1");
    press("ArrowUp");
    expect(marked()).toBe("e3");
  });

  it("keeps the mark after Enter fires the row's action", () => {
    claimRegion();
    press("ArrowDown");
    press("Enter");
    expect(commits).toEqual(["e2"]);
    expect(marked()).toBe("e2");
  });

  it("leaves Enter alone when a button already owns it", () => {
    claimRegion();
    const button = container!.querySelector("[data-locate-action]")!;
    press("Enter", button);
    expect(commits).toEqual([]);
  });

  it("hands the cursor over when a locate query commits", () => {
    claimRegion();
    press("t"); // matches "tests" best
    expect(marked()).toBe("e3");
    press("Enter");
    expect(commits).toEqual(["e3"]);
    expect(marked()).toBe("e3");
  });

  it("re-adopts a repeat query's row as the cursor", () => {
    claimRegion();
    press("t");
    press("Escape"); // cursor now e3
    press("ArrowDown"); // wraps to e1
    press("t");
    press("Escape");
    expect(marked()).toBe("e3");
  });

  it("drops the mark while a query matches nothing, and restores it on Esc", () => {
    claimRegion();
    press("z");
    expect(marked()).toBe(null);
    press("Escape");
    expect(marked()).toBe("e1");
  });

  it("makes a clicked row current", () => {
    act(() => {
      container!
        .querySelector('[data-locate-id="e3"]')!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(marked()).toBe("e3");
  });

  it("keeps the mark when the keyboard region moves away, but stops acting on it", () => {
    claimRegion();
    press("ArrowDown");
    press("Escape"); // releases the right panel back to the default region
    expect(marked()).toBe("e2");
    press("ArrowDown");
    expect(marked()).toBe("e2");
  });
});
