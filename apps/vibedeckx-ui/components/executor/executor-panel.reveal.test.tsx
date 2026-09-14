// @vitest-environment jsdom
// Expanding an executor scrolls it fully into view: a row opened near the fold
// otherwise shows its header and hides the output that the open was about.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocateProvider } from "@/components/locate/locate-context";
import { FocusRegionProvider } from "@/components/locate/focus-region";
import { ExecutorPanel } from "./executor-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { CSS?: { escape: (s: string) => string } }).CSS ??= {
  escape: (value: string) => value,
};
Element.prototype.scrollIntoView ??= () => {};

const EXECUTORS = [
  { id: "e1", name: "dev server" },
  { id: "e2", name: "build watch" },
  { id: "e3", name: "tests" },
];

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

// Stand-in row with the one control the panel cares about here: a header that
// toggles the output, like the real CollapsibleTrigger.
vi.mock("./executor-item", () => ({
  ExecutorItem: ({
    executor,
    isOpen,
    onOpenChange,
  }: {
    executor: { id: string; name: string };
    isOpen?: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-locate-id={executor.id} data-open={isOpen ? "yes" : "no"}>
      <button data-testid={`header-${executor.id}`} onClick={() => onOpenChange(!isOpen)}>
        {executor.name}
      </button>
    </div>
  ),
}));

// jsdom lays nothing out, so the panel's measurements come from this fake
// geometry: rows stacked top to bottom inside a viewport of VIEW_HEIGHT,
// shifted by whatever the panel has scrolled to.
const ROW_GAP = 10;
const CLOSED_HEIGHT = 60;
const OPEN_HEIGHT = 380;
let viewHeight = 400;
let scrollTop = 0;
let scrollTo: ReturnType<typeof vi.fn>;

const rowHeight = (el: Element) => (el.getAttribute("data-open") === "yes" ? OPEN_HEIGHT : CLOSED_HEIGHT);

function installGeometry(scroller: HTMLElement) {
  scroller.getBoundingClientRect = () =>
    ({ top: 0, bottom: viewHeight, height: viewHeight, left: 0, right: 300, width: 300 }) as DOMRect;
  scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    scrollTop = top ?? 0;
  });
  (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop, configurable: true });

  for (const row of Array.from(scroller.querySelectorAll("[data-locate-id]"))) {
    row.getBoundingClientRect = () => {
      let offset = 0;
      for (const sibling of Array.from(scroller.querySelectorAll("[data-locate-id]"))) {
        if (sibling === row) break;
        offset += rowHeight(sibling) + ROW_GAP;
      }
      const top = offset - scrollTop;
      const height = rowHeight(row);
      return { top, bottom: top + height, height, left: 0, right: 300, width: 300 } as DOMRect;
    };
  }
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  viewHeight = 400;
  scrollTop = 0;
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
  installGeometry(container.querySelector(".overflow-y-auto") as HTMLElement);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

const clickHeader = (id: string) => {
  act(() => {
    container!
      .querySelector(`[data-testid="header-${id}"]`)!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const claimRegion = () => {
  act(() => {
    container!
      .querySelector("[data-focus-region]")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
};

const press = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

describe("ExecutorPanel expand reveal", () => {
  it("scrolls an opened row that runs past the bottom back into full view", () => {
    // e3 sits at 140; expanded it ends at 520, past the 400px fold.
    clickHeader("e3");
    expect(scrollTo).toHaveBeenCalledWith({ top: 132, behavior: "smooth" });
  });

  it("leaves the panel alone when the expanded row already fits", () => {
    clickHeader("e1");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("pins the header to the top when the row is taller than the panel", () => {
    viewHeight = 300;
    clickHeader("e3");
    // Aligning the bottom would push the header (and its Start/Stop) out of
    // reach, so the row is shown from its top instead.
    expect(scrollTo).toHaveBeenCalledWith({ top: 140, behavior: "smooth" });
  });

  it("reveals a row opened with Space, and doesn't scroll when it closes again", () => {
    claimRegion();
    press("ArrowDown");
    press("ArrowDown");
    press(" ");
    expect(container!.querySelector('[data-locate-id="e3"]')!.getAttribute("data-open")).toBe("yes");
    expect(scrollTo).toHaveBeenCalledWith({ top: 132, behavior: "smooth" });

    scrollTo.mockClear();
    press(" ");
    expect(container!.querySelector('[data-locate-id="e3"]')!.getAttribute("data-open")).toBe("no");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
