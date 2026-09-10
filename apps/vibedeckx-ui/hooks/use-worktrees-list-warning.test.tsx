// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeList } from "@/lib/api";

const getProjectWorktreeList = vi.hoisted(() => vi.fn<() => Promise<WorktreeList>>());
vi.mock("@/lib/api", () => ({ api: { getProjectWorktreeList } }));
vi.mock("@/hooks/global-event-stream", () => ({ useGlobalEventStream: () => {} }));

import { useWorktrees, type ListWarning } from "./use-worktrees";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Rendered into the DOM rather than assigned during render: a render is not
// the place to write to anything outside the component.
function Probe({ projectId }: { projectId: string | null }) {
  const { listWarning } = useWorktrees(projectId, null, "srv-1");
  return <span data-warning={JSON.stringify(listWarning)} />;
}

describe("useWorktrees list warning", () => {
  let root: Root;
  let container: HTMLElement;

  const seen = (): ListWarning => JSON.parse(container.querySelector("span")!.getAttribute("data-warning")!);

  const render = async (projectId: string | null = "p1") => {
    await act(async () => {
      root.render(<Probe projectId={projectId} />);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    getProjectWorktreeList.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("carries what the server said about the list, and clears it when the server stops saying it", async () => {
    getProjectWorktreeList.mockResolvedValueOnce({
      worktrees: [{ branch: null }],
      stale: { serverId: "srv-1", name: "worker3" },
      activeRemoteInvalid: true,
    });
    await render();
    expect(seen()).toEqual({ staleRemote: { serverId: "srv-1", name: "worker3" }, activeRemoteInvalid: true });

    getProjectWorktreeList.mockResolvedValueOnce({ worktrees: [{ branch: null }] });
    await render(null);
    await render("p1");
    expect(seen()).toEqual({ staleRemote: null, activeRemoteInvalid: false });
  });
});
