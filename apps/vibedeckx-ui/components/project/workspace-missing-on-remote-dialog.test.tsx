// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceMissingOnRemoteDialog } from "./workspace-missing-on-remote-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceMissingOnRemoteDialog", () => {
  let container: HTMLElement;
  let root: Root;
  const onSwitch = vi.fn();
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
          onSwitch={onSwitch}
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

  it("offers a switch to each machine that has it, creating it here, or opening anyway", () => {
    expect(document.body.textContent).toContain("dev is not on worker3");

    act(() => buttonNamed("Switch to Mac").click());
    expect(onSwitch).toHaveBeenCalledWith("server-2");
    act(() => buttonNamed("Switch to ubuntu").click());
    expect(onSwitch).toHaveBeenCalledWith("server-3");

    act(() => buttonNamed("Create on worker3").click());
    expect(onCreateHere).toHaveBeenCalledTimes(1);

    act(() => buttonNamed("Open anyway").click());
    expect(onOpenAnyway).toHaveBeenCalledTimes(1);
  });
});
