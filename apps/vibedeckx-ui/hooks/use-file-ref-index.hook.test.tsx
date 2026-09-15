// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const listProjectFiles = vi.fn();
vi.mock("@/lib/api", () => ({ api: { listProjectFiles: (...a: unknown[]) => listProjectFiles(...a) } }));

// Capture the hook's global-event listener so tests can feed it events.
let emitGlobal: ((evt: { type?: string; [k: string]: unknown }) => void) | null = null;
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: (evt: unknown) => void) => {
    emitGlobal = listener;
  },
}));

import { useFileRefIndex } from "./use-file-ref-index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// The hook's result is projected into the DOM (no render-time side effects):
// data-state says whether an index exists, data-probe lists how the index
// resolves two paths — one inside the reported root, one outside it.
function Probe() {
  const index = useFileRefIndex({ projectId: "p1", branch: "dev" });
  const probe = (p: string) => (index ? index.resolve(p).join(",") : "-");
  return (
    <span
      data-state={index === null ? "null" : "index"}
      data-inside={probe("/work/repo/screenshot.png")}
      data-outside={probe("/tmp/screenshot.png")}
      data-relative={probe("src/a.ts")}
    />
  );
}

function probe(): { state: string; inside: string; outside: string; relative: string } {
  const el = container!.querySelector("span")!;
  return {
    state: el.getAttribute("data-state")!,
    inside: el.getAttribute("data-inside")!,
    outside: el.getAttribute("data-outside")!,
    relative: el.getAttribute("data-relative")!,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  listProjectFiles.mockReset();
  emitGlobal = null;
});

// Deliver an event and let the refresh debounce + fetch settle.
async function fire(evt: { type: string; [k: string]: unknown }) {
  await act(async () => {
    emitGlobal!(evt);
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

// Drain the retry schedule (~15s of backoff) plus the promise chain after it.
async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
  }
}

describe("useFileRefIndex", () => {
  it("builds a root-aware index from the file list", async () => {
    listProjectFiles.mockResolvedValue({ files: ["screenshot.png"], truncated: false, root: "/work/repo" });
    await mount();
    await settle();
    expect(probe()).toMatchObject({ state: "index", inside: "screenshot.png", outside: "" });
  });

  it("settles on an empty index, not null, when every fetch fails", async () => {
    listProjectFiles.mockRejectedValue(new Error("worker down"));
    await mount();
    expect(probe().state).toBe("null"); // still loading
    await settle();
    // failed → empty index, so external links stay enabled while repo refs resolve to nothing
    expect(probe()).toMatchObject({ state: "index", relative: "", outside: "" });
  });

  describe("refresh", () => {
    async function mountWithFiles(files: string[]) {
      listProjectFiles.mockResolvedValue({ files, truncated: false, root: "/work/repo" });
      await mount();
      await settle();
      listProjectFiles.mockClear();
    }

    it("re-pulls the list when an agent on this branch finishes a turn", async () => {
      await mountWithFiles([]);
      expect(probe().relative).toBe("");
      listProjectFiles.mockResolvedValue({ files: ["src/a.ts"], truncated: false, root: "/work/repo" });
      await fire({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s1" });
      expect(listProjectFiles).toHaveBeenCalledTimes(1);
      expect(probe().relative).toBe("src/a.ts");
    });

    it("re-pulls on a Files-tab write to this checkout", async () => {
      await mountWithFiles([]);
      listProjectFiles.mockResolvedValue({ files: ["src/a.ts"], truncated: false, root: "/work/repo" });
      await fire({ type: "files:changed", projectId: "p1", branch: "dev", change: "uploaded" });
      expect(listProjectFiles).toHaveBeenCalledTimes(1);
      expect(probe().relative).toBe("src/a.ts");
    });

    it("ignores turns on other projects or branches and unrelated events", async () => {
      await mountWithFiles([]);
      await fire({ type: "session:taskCompleted", projectId: "p2", branch: "dev", sessionId: "s1" });
      await fire({ type: "session:taskCompleted", projectId: "p1", branch: "main", sessionId: "s1" });
      await fire({ type: "session:taskCompleted", projectId: "p1", branch: null, sessionId: "s1" });
      await fire({ type: "session:status", projectId: "p1", branch: "dev", sessionId: "s1", status: "running" });
      expect(listProjectFiles).not.toHaveBeenCalled();
    });

    it("coalesces a burst of turn ends into one fetch", async () => {
      await mountWithFiles([]);
      listProjectFiles.mockResolvedValue({ files: ["src/a.ts"], truncated: false, root: "/work/repo" });
      await act(async () => {
        emitGlobal!({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s1" });
        emitGlobal!({ type: "session:finished", projectId: "p1", branch: "dev", sessionId: "s2" });
        emitGlobal!({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s3" });
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(listProjectFiles).toHaveBeenCalledTimes(1);
    });

    it("keeps the current index in place while refreshing and when the refresh fails", async () => {
      await mountWithFiles(["src/a.ts"]);
      let resolve!: (v: unknown) => void;
      listProjectFiles.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await act(async () => {
        emitGlobal!({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s1" });
        await vi.advanceTimersByTimeAsync(500);
      });
      // fetch in flight: old index still answers, never null
      expect(probe()).toMatchObject({ state: "index", relative: "src/a.ts" });
      await act(async () => {
        resolve({ files: ["src/a.ts", "src/b.ts"], truncated: false, root: "/work/repo" });
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(probe().relative).toBe("src/a.ts");

      listProjectFiles.mockRejectedValueOnce(new Error("worker down"));
      await fire({ type: "session:taskCompleted", projectId: "p1", branch: "dev", sessionId: "s1" });
      expect(probe()).toMatchObject({ state: "index", relative: "src/a.ts" });
    });
  });
});
