// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "@/lib/api";

const getTerminals = vi.hoisted(() => vi.fn());
const createTerminalApi = vi.hoisted(() => vi.fn());
const closeTerminalApi = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { getTerminals, createTerminal: createTerminalApi, closeTerminal: closeTerminalApi },
}));

import { useTerminals, type UseTerminalsResult } from "./use-terminals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shell = (id: string): TerminalSession =>
  ({ id, name: id, projectId: "p1", branch: "dev2", location: "remote" }) as TerminalSession;

/** A promise plus the handle to settle it, so response order is the test's to choose. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useTerminals response ordering", () => {
  let container: HTMLElement;
  let root: Root;
  let latest: UseTerminalsResult;

  function Probe({ branch }: { branch: string }) {
    const value = useTerminals("p1", branch);
    // Published after commit, not during render: assigning while rendering is
    // a side effect the lint rules reject.
    useEffect(() => { latest = value; });
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a terminal created while the list for that workspace was still loading", async () => {
    // Exactly the shape of "open a terminal there": the workspace switch and
    // the create land in one commit, so the create races the list fetch.
    const list = deferred<TerminalSession[]>();
    const created = deferred<TerminalSession>();
    getTerminals.mockReturnValue(list.promise);
    createTerminalApi.mockReturnValue(created.promise);

    await act(async () => { root.render(<Probe branch="dev2" />); });
    let creating: Promise<void>;
    await act(async () => { creating = latest.createTerminal("remote", "server-2"); });

    // The create answers first...
    await act(async () => { created.resolve(shell("new-shell")); await creating; });
    expect(latest.terminals.map((terminal) => terminal.id)).toEqual(["new-shell"]);

    // ...and the list, taken before it existed, must not undo it.
    await act(async () => { list.resolve([]); await list.promise; });
    expect(latest.terminals.map((terminal) => terminal.id)).toEqual(["new-shell"]);
    expect(latest.activeTerminalId).toBe("new-shell");
  });

  it("lands on the target workspace's own terminals, old and new, with none from the one left behind", async () => {
    // Both workspaces already have shells. Switching to dev2 while creating one
    // there must end with dev2's existing shell AND the new one — dropping
    // either leaves the user typing into the wrong workspace's shell.
    const dev2List = deferred<TerminalSession[]>();
    const created = deferred<TerminalSession>();
    getTerminals.mockResolvedValueOnce([shell("main-shell")]).mockReturnValueOnce(dev2List.promise);
    createTerminalApi.mockReturnValue(created.promise);

    await act(async () => { root.render(<Probe branch="main" />); });
    expect(latest.terminals.map((terminal) => terminal.id)).toEqual(["main-shell"]);

    // The panel asks for the shell once the new workspace is committed, so the
    // create runs against dev2 while dev2's own list is still in flight.
    await act(async () => { root.render(<Probe branch="dev2" />); });
    let creating: Promise<void>;
    await act(async () => { creating = latest.createTerminal("remote", "server-2"); });
    await act(async () => { created.resolve(shell("new-dev2-shell")); await creating; });
    await act(async () => { dev2List.resolve([shell("existing-dev2-shell")]); await dev2List.promise; });

    expect(latest.terminals.map((terminal) => terminal.id))
      .toEqual(["existing-dev2-shell", "new-dev2-shell"]);
    expect(latest.activeTerminalId).toBe("new-dev2-shell");
  });

  it("drops a shell whose workspace the user left before it finished starting", async () => {
    const created = deferred<TerminalSession>();
    getTerminals.mockResolvedValue([]);
    createTerminalApi.mockReturnValue(created.promise);

    await act(async () => { root.render(<Probe branch="main" />); });
    let creating: Promise<void>;
    await act(async () => { creating = latest.createTerminal("local"); });
    await act(async () => { root.render(<Probe branch="dev2" />); });
    await act(async () => { created.resolve(shell("main-shell")); await creating; });

    // It belongs to main, and main is not what is on screen.
    expect(latest.terminals).toEqual([]);
  });

  it("does not bring back a shell that was closed before the list answered", async () => {
    const list = deferred<TerminalSession[]>();
    const created = deferred<TerminalSession>();
    getTerminals.mockReturnValue(list.promise);
    createTerminalApi.mockReturnValue(created.promise);
    closeTerminalApi.mockResolvedValue(undefined);

    await act(async () => { root.render(<Probe branch="dev2" />); });
    let creating: Promise<void>;
    await act(async () => { creating = latest.createTerminal("remote", "server-2"); });
    await act(async () => { created.resolve(shell("new-shell")); await creating; });

    let closing: Promise<void>;
    await act(async () => { closing = latest.closeTerminal("new-shell"); });
    await act(async () => { await closing; });
    await act(async () => { list.resolve([]); await list.promise; });

    expect(latest.terminals).toEqual([]);
    expect(latest.activeTerminalId).toBeNull();
  });

  it("does not bring back a shell that exited on its own before the list answered", async () => {
    const list = deferred<TerminalSession[]>();
    const created = deferred<TerminalSession>();
    getTerminals.mockReturnValue(list.promise);
    createTerminalApi.mockReturnValue(created.promise);

    await act(async () => { root.render(<Probe branch="dev2" />); });
    let creating: Promise<void>;
    await act(async () => { creating = latest.createTerminal("remote", "server-2"); });
    await act(async () => { created.resolve(shell("new-shell")); await creating; });

    // What TerminalInstance calls when the shell process exits.
    await act(async () => { latest.removeTerminal("new-shell"); });
    await act(async () => { list.resolve([]); await list.promise; });

    expect(latest.terminals).toEqual([]);
    expect(latest.activeTerminalId).toBeNull();
  });

  it("still adopts a list that answers with nothing racing it", async () => {
    getTerminals.mockResolvedValue([shell("existing")]);

    await act(async () => { root.render(<Probe branch="dev2" />); });

    expect(latest.terminals.map((terminal) => terminal.id)).toEqual(["existing"]);
    expect(latest.activeTerminalId).toBe("existing");
  });

  it("ignores the previous workspace's list when the workspace changes", async () => {
    const first = deferred<TerminalSession[]>();
    getTerminals.mockReturnValueOnce(first.promise).mockResolvedValueOnce([shell("dev3-shell")]);

    await act(async () => { root.render(<Probe branch="dev2" />); });
    await act(async () => { root.render(<Probe branch="dev3" />); });
    await act(async () => { first.resolve([shell("dev2-shell")]); await first.promise; });

    expect(latest.terminals.map((terminal) => terminal.id)).toEqual(["dev3-shell"]);
  });
});
