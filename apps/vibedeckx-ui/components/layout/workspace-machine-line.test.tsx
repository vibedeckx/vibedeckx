// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceMachineState } from "@/lib/worktree-target-results";

import { WorkspaceMachineLine } from "./workspace-machine-line";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceMachineLine", () => {
  let container: HTMLElement;
  let root: Root;

  const render = (machine: WorkspaceMachineState, roles?: { primary?: boolean }) =>
    act(() => {
      root.render(<WorkspaceMachineLine machine={machine} {...roles} />);
    });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("leads with a glyph for the state, one per state the hub can report", () => {
    const glyph = () => container.querySelector("svg")!.getAttribute("class");

    render({ serverId: "a", name: "Mac", state: "present" });
    expect(glyph()).toContain("lucide-check");
    render({ serverId: "a", name: "Mac", state: "absent", deleted: true });
    expect(glyph()).toContain("lucide-x");
    render({ serverId: "a", name: "Mac", state: "error", error: "disk full" });
    expect(glyph()).toContain("lucide-triangle-alert");
    render({ serverId: "a", name: "Mac", state: "creating" });
    expect(glyph()).toContain("lucide-loader-circle");
    render({ serverId: "a", name: "Mac", state: "unknown" });
    expect(glyph()).toMatch(/lucide-circle-(help|question-mark)/);
  });

  it("tags the primary remote after the state, and nothing else", () => {
    // The current remote gets no tag: the lead line names it when it
    // matters, and a second tag per line was more to read than it told.
    render({ serverId: "a", name: "Mac", state: "present" }, { primary: true });
    expect(container.textContent).toBe("MacPresent[primary]");
    render({ serverId: "a", name: "Mac", state: "absent", deleted: true }, { primary: true });
    expect(container.textContent).toBe("MacDeleted[primary]");
    render({ serverId: "a", name: "Mac", state: "present" });
    expect(container.textContent).toBe("MacPresent");
  });

  it("keeps the failure red, for a failed machine and for a kept delete reason alike", () => {
    render({ serverId: "a", name: "Mac", state: "error", error: "disk full" });
    expect(container.querySelector("span.text-red-400")?.textContent).toBe("Failed — disk full");
    render({ serverId: "a", name: "Mac", state: "present", error: "uncommitted changes" });
    expect(container.querySelector("span.text-red-400")?.textContent).toBe("Present — could not delete: uncommitted changes");
    render({ serverId: "a", name: "Mac", state: "present" });
    expect(container.querySelector("span.text-red-400")).toBeNull();
  });
});
