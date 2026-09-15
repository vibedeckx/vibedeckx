// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const listProjectFiles = vi.fn();
vi.mock("@/lib/api", () => ({ api: { listProjectFiles: (...a: unknown[]) => listProjectFiles(...a) } }));

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
});

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
});
