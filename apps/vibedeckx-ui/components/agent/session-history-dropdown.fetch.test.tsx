// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listBranchSessions } = vi.hoisted(() => ({ listBranchSessions: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, listBranchSessions };
});

import { SessionHistoryDropdown } from "./session-history-dropdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const row = (id: string) => ({
  id,
  title: `Title ${id}`,
  status: "stopped",
  created_at: "2026-08-16 01:00:00.000",
  updated_at: "2026-08-16 01:00:00.000",
  entry_count: 3,
  favorited_at: null,
});

const render = async (props: { branch: string | null; currentSessionId: string | null }) => {
  await act(async () => {
    root.render(
      <SessionHistoryDropdown
        projectId="p1"
        branch={props.branch}
        currentSessionId={props.currentSessionId}
        onSwitch={() => {}}
      />,
    );
  });
};

const branchesAsked = () => listBranchSessions.mock.calls.map((call) => call[1]);

beforeEach(() => {
  listBranchSessions.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.querySelectorAll("[data-radix-portal]").forEach((node) => node.remove());
  container.remove();
});

describe("SessionHistoryDropdown fetching", () => {
  it("does not self-heal against another workspace's list", async () => {
    // The list for `dev7` is still in flight when its session becomes current.
    // Healing off the previous workspace's rows — which legitimately lack it —
    // would fan one navigation into two identical requests.
    listBranchSessions.mockResolvedValueOnce({ sessions: [row("s-main")] });
    await render({ branch: null, currentSessionId: "s-main" });

    let resolveDev: (value: { sessions: ReturnType<typeof row>[] }) => void = () => {};
    listBranchSessions.mockReturnValueOnce(new Promise((resolve) => { resolveDev = resolve; }));
    await render({ branch: "dev7", currentSessionId: "s-dev" });

    expect(branchesAsked()).toEqual([null, "dev7"]);

    await act(async () => {
      resolveDev({ sessions: [row("s-dev")] });
    });
    expect(branchesAsked()).toEqual([null, "dev7"]);
  });

  it("still heals a session missing from this workspace's own list", async () => {
    // A commander-spawned session surfaced into an open window: its row really
    // is absent from a list that has already landed, so refetch once.
    listBranchSessions.mockResolvedValueOnce({ sessions: [row("s-a")] });
    await render({ branch: "dev7", currentSessionId: "s-a" });
    expect(branchesAsked()).toEqual(["dev7"]);

    listBranchSessions.mockResolvedValueOnce({ sessions: [row("s-a"), row("s-spawned")] });
    await render({ branch: "dev7", currentSessionId: "s-spawned" });
    expect(branchesAsked()).toEqual(["dev7", "dev7"]);

    // And only once — the ref guard holds even though the row has landed and
    // the effect re-runs on the new `sessions`.
    await render({ branch: "dev7", currentSessionId: "s-spawned" });
    expect(branchesAsked()).toEqual(["dev7", "dev7"]);
  });

  it("heals once after a failed load rather than staying stale forever", async () => {
    listBranchSessions.mockRejectedValueOnce(new Error("network"));
    listBranchSessions.mockResolvedValue({ sessions: [row("s-a")] });
    await render({ branch: "dev7", currentSessionId: "s-a" });

    expect(branchesAsked()).toEqual(["dev7", "dev7"]);

    // The retry landed the row, so nothing keeps refetching.
    await render({ branch: "dev7", currentSessionId: "s-a" });
    expect(branchesAsked()).toEqual(["dev7", "dev7"]);
  });
});
