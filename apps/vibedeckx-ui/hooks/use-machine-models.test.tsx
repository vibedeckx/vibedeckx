// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({ getAgentModels: vi.fn() }));

import { getAgentModels, type MachineModelList } from "@/lib/api";
import { machineOfSession, resetMachineModelsStore, useMachineModels, type MachineModelsTarget } from "./use-machine-models";

const mocked = vi.mocked(getAgentModels);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
function renderHook(initial: MachineModelsTarget) {
  const result = { current: undefined as ReturnType<typeof useMachineModels> | undefined };
  const record = (value: ReturnType<typeof useMachineModels>) => { result.current = value; };
  function Probe(props: MachineModelsTarget) {
    record(useMachineModels(props));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Probe {...initial} />));
  return { result, rerender: (p: MachineModelsTarget) => act(() => root.render(<Probe {...p} />)) };
}
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
const list = (models: string[], source: MachineModelList["source"] = "machine"): MachineModelList => ({ models, source });

const SRV_A = "5a967959-f5b4-4f9f-bab7-22f1997e69ef";
const SRV_B = "0b1c2d3e-0000-4000-8000-000000000000";
const sessionOnA = `remote-${SRV_A}-fd5e77cc-aca9-45a5-821c-bb1dcbeeea2c-rs1`;

describe("machineOfSession", () => {
  it("is local for a plain id, the matching server for a remote one, null for an unlisted server", () => {
    expect(machineOfSession("abc-123", [SRV_A])).toBe("local");
    expect(machineOfSession(sessionOnA, [SRV_B, SRV_A])).toBe(SRV_A);
    expect(machineOfSession(sessionOnA, [SRV_B])).toBeNull();
  });
});

describe("useMachineModels", () => {
  beforeEach(() => { mocked.mockReset(); resetMachineModelsStore(); });
  afterEach(() => { roots.splice(0).forEach((r) => act(() => r.unmount())); vi.restoreAllMocks(); });

  it("before a session, lists on the project's target", async () => {
    mocked.mockResolvedValue(list(["a/one"]));
    const { result } = renderHook({ projectId: "p1", agentTarget: "local", agentType: "fx" });
    expect(result.current?.models).toBeNull();
    await flush();
    expect(result.current?.models).toEqual(["a/one"]);
    expect(mocked).toHaveBeenCalledWith({ projectId: "p1" }, "fx", undefined);
  });

  it("a first message (new conversation → session) on the same machine neither refetches nor blanks", async () => {
    mocked.mockResolvedValue(list(["a/one"]));
    const { result, rerender } = renderHook({ projectId: "p1", agentTarget: SRV_A, knownRemoteIds: [SRV_A], agentType: "fx" });
    await flush();
    rerender({ sessionId: sessionOnA, projectId: "p1", agentTarget: SRV_A, knownRemoteIds: [SRV_A], agentType: "fx" });
    expect(result.current?.models).toEqual(["a/one"]);
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("switching sessions on one machine reuses the list, across separately mounted pickers too", async () => {
    mocked.mockResolvedValue(list(["local/model"]));
    const first = renderHook({ sessionId: "s1", projectId: "p1", agentTarget: "local", agentType: "codex" });
    await flush();
    first.rerender({ sessionId: "s2", projectId: "p1", agentTarget: "local", agentType: "codex" });
    const second = renderHook({ sessionId: "s3", projectId: "p2", agentTarget: "local", agentType: "codex" });
    await flush();
    expect(first.result.current?.models).toEqual(["local/model"]);
    expect(second.result.current?.models).toEqual(["local/model"]);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("a session lists on its own machine even when the project now targets another, via the session route", async () => {
    mocked.mockResolvedValueOnce(list(["b/model"])).mockResolvedValueOnce(list(["a/model"]));
    const { result, rerender } = renderHook({ projectId: "p1", agentTarget: SRV_B, knownRemoteIds: [SRV_A, SRV_B], agentType: "fx" });
    await flush();
    expect(result.current?.models).toEqual(["b/model"]);
    rerender({ sessionId: sessionOnA, projectId: "p1", agentTarget: SRV_B, knownRemoteIds: [SRV_A, SRV_B], agentType: "fx" });
    // Never machine B's list for a session on A.
    expect(result.current?.models).toBeNull();
    await flush();
    expect(mocked.mock.calls[1]).toEqual([{ sessionId: sessionOnA }, "fx", undefined]);
    expect(result.current?.models).toEqual(["a/model"]);
  });

  it("each agent type has its own list on one machine", async () => {
    mocked.mockResolvedValueOnce(list(["fx/model"])).mockResolvedValueOnce(list(["codex/model"]));
    const { result, rerender } = renderHook({ projectId: "p1", agentTarget: "local", agentType: "fx" });
    await flush();
    rerender({ projectId: "p1", agentTarget: "local", agentType: "codex" });
    expect(result.current?.models).toBeNull();
    await flush();
    expect(result.current?.models).toEqual(["codex/model"]);
    rerender({ projectId: "p1", agentTarget: "local", agentType: "fx" });
    expect(result.current?.models).toEqual(["fx/model"]);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("revalidate retries the fallback list, then leaves the machine list alone", async () => {
    mocked
      .mockResolvedValueOnce(list(["static/suggestion"], "suggestions"))
      .mockResolvedValueOnce(list(["machine/model"]));
    const { result } = renderHook({ projectId: "p1", agentTarget: SRV_A, agentType: "fx" });
    await flush();
    expect(result.current?.models).toEqual(["static/suggestion"]);
    act(() => result.current!.revalidate());
    // The current list stays on screen until the answer lands.
    expect(result.current?.models).toEqual(["static/suggestion"]);
    await flush();
    expect(result.current?.models).toEqual(["machine/model"]);
    act(() => result.current!.revalidate());
    await flush();
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("refresh skips the machine's cache and spins until its answer lands", async () => {
    let resolveRefresh!: (v: MachineModelList) => void;
    mocked
      .mockResolvedValueOnce(list(["old/model"]))
      .mockReturnValueOnce(new Promise((r) => { resolveRefresh = r; }));
    const { result } = renderHook({ sessionId: "s1", agentTarget: "local", agentType: "codex" });
    await flush();
    expect(result.current?.refreshing).toBe(false);
    act(() => result.current!.refresh());
    expect(mocked.mock.calls[1]).toEqual([{ sessionId: "s1" }, "codex", { refresh: true }]);
    expect(result.current?.refreshing).toBe(true);
    expect(result.current?.models).toEqual(["old/model"]);
    resolveRefresh(list(["new/model"]));
    await flush();
    expect(result.current?.refreshing).toBe(false);
    expect(result.current?.models).toEqual(["new/model"]);
  });

  it("a failed refresh keeps what is shown and stops spinning; no project and no session fetches nothing", async () => {
    mocked.mockResolvedValueOnce(list(["a/one"])).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook({ projectId: "p1", agentTarget: "local", agentType: "fx" });
    await flush();
    act(() => result.current!.refresh());
    await flush();
    expect(result.current?.models).toEqual(["a/one"]);
    expect(result.current?.refreshing).toBe(false);
    const none = renderHook({ projectId: null, agentType: "fx" });
    expect(none.result.current?.models).toBeNull();
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("opening re-asks once the machine's cache entry has expired, by this browser's clock", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocked
      .mockResolvedValueOnce({ models: ["old/model"], source: "machine", expiresInMs: 10 * 60 * 1000 })
      .mockResolvedValueOnce({ models: ["new/model"], source: "machine", expiresInMs: 24 * 60 * 60 * 1000 });
    const { result } = renderHook({ projectId: "p1", agentTarget: SRV_A, agentType: "fx" });
    await flush();
    now += 9 * 60 * 1000;
    act(() => result.current!.revalidate());
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    act(() => result.current!.revalidate());
    // The held list stays on screen while the machine answers.
    expect(result.current?.models).toEqual(["old/model"]);
    await flush();
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[1]).toEqual([{ projectId: "p1" }, "fx", undefined]);
    expect(result.current?.models).toEqual(["new/model"]);
    // The new answer's expiry now applies.
    now += 60 * 60 * 1000;
    act(() => result.current!.revalidate());
    await flush();
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("an answer without expiresInMs is re-asked for after an hour", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocked.mockResolvedValue(list(["a/one"]));
    const { result } = renderHook({ projectId: "p1", agentTarget: "local", agentType: "fx" });
    await flush();
    now = 59 * 60 * 1000;
    act(() => result.current!.revalidate());
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
    now = 61 * 60 * 1000;
    act(() => result.current!.revalidate());
    await flush();
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
