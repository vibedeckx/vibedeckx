// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useWorkspaceDraft } from "./use-workspace-draft";

describe("useWorkspaceDraft", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: [string, (value: string) => void];

  // One component identity: AgentConversation has no `key`, so a workspace
  // switch is a prop change, not a remount.
  function Probe({ projectId, branch }: { projectId: string; branch: string | null }) {
    latest = useWorkspaceDraft(projectId, branch);
    return null;
  }

  const render = async (projectId: string, branch: string | null) => {
    await act(async () => root.render(<Probe projectId={projectId} branch={branch} />));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.localStorage.clear();
  });

  it("keeps the main workspace's (branch null) draft across a project switch", async () => {
    await render("p1", null);
    await act(async () => latest[1]("half-written"));

    await render("p2", null);
    expect(latest[0]).toBe("");

    await render("p1", null);
    expect(latest[0]).toBe("half-written");
  });

  it("keeps drafts separate per branch", async () => {
    await render("p1", "feat");
    await act(async () => latest[1]("on feat"));

    await render("p1", null);
    expect(latest[0]).toBe("");
    await act(async () => latest[1]("on main"));

    await render("p1", "feat");
    expect(latest[0]).toBe("on feat");
    await render("p1", null);
    expect(latest[0]).toBe("on main");
  });

  it("survives a remount (full page navigation)", async () => {
    await render("p1", null);
    await act(async () => latest[1]("kept"));
    act(() => root.unmount());
    root = createRoot(container);

    await render("p1", null);
    expect(latest[0]).toBe("kept");
  });
});
