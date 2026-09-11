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

  const render = (machine: WorkspaceMachineState, roles?: { primary?: boolean; current?: boolean }) =>
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

  it("names the machine's roles after it, and both when they coincide", () => {
    render({ serverId: "a", name: "Mac", state: "present" }, { primary: true });
    expect(container.textContent).toBe("Mac · primaryPresent");
    render({ serverId: "a", name: "Mac", state: "present" }, { current: true });
    expect(container.textContent).toBe("Mac · currentPresent");
    render({ serverId: "a", name: "Mac", state: "present" }, { primary: true, current: true });
    expect(container.textContent).toBe("Mac · primary, currentPresent");
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
