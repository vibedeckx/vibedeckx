// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceMissingOnRemoteDialog } from "./workspace-missing-on-remote-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceMissingOnRemoteDialog", () => {
  let container: HTMLElement;
  let root: Root;
  const onCreateHere = vi.fn();
  const onOpenAnyway = vi.fn();

  const buttonNamed = (text: string) =>
    Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes(text))!;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <WorkspaceMissingOnRemoteDialog
          missing={{
            branch: "dev",
            current: { serverId: "server-1", name: "worker3", state: "absent" },
            presentOn: [
              { serverId: "server-2", name: "Mac", state: "present" },
              { serverId: "server-3", name: "ubuntu", state: "present" },
            ],
          }}
          onOpenChange={() => {}}
          onCreateHere={onCreateHere}
          onOpenAnyway={onOpenAnyway}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("names where it exists and offers creating it here or opening anyway", () => {
    expect(document.body.textContent).toContain("dev is not on worker3");
    expect(document.body.textContent).toContain("It exists on Mac, ubuntu");
    expect(document.body.textContent).toContain("switch the project's remote in the session header");
    // Moving sessions is project-wide, so no row-level shortcut for it.
    expect(buttonNamed("Switch to")).toBeUndefined();

    act(() => buttonNamed("Create on worker3").click());
    expect(onCreateHere).toHaveBeenCalledTimes(1);

    act(() => buttonNamed("Open anyway").click());
    expect(onOpenAnyway).toHaveBeenCalledTimes(1);
  });
});
