// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({ getAgentModels: vi.fn() }));

import { getAgentModels, type MachineModelList } from "@/lib/api";
import { useMachineModels, type MachineModelsTarget } from "./use-machine-models";

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
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const list = (models: string[], source: MachineModelList["source"] = "machine"): MachineModelList => ({ models, source });

describe("useMachineModels", () => {
  beforeEach(() => { mocked.mockReset(); });
  afterEach(() => { roots.splice(0).forEach((r) => act(() => r.unmount())); });

  it("before a session, lists on the project's target", async () => {
    mocked.mockResolvedValue(list(["a/one"]));
    const { result } = renderHook({ projectId: "p1", agentTarget: "srv-1", agentType: "fx" });
    expect(result.current?.models).toBeNull();
    await flush();
    expect(result.current?.models).toEqual(["a/one"]);
    expect(mocked).toHaveBeenCalledWith({ projectId: "p1" }, "fx");
  });

  it("with a session, lists on the session's own machine regardless of the project target", async () => {
    mocked.mockResolvedValue(list(["s/model"]));
    const { result } = renderHook({ sessionId: "remote-srvA-p1-rs1", projectId: "p1", agentTarget: "srv-B", agentType: "fx" });
    await flush();
    expect(mocked).toHaveBeenCalledWith({ sessionId: "remote-srvA-p1-rs1" }, "fx");
    expect(result.current?.models).toEqual(["s/model"]);
  });

  it("never shows the previous target's list after the target changes", async () => {
    let resolveSecond!: (v: MachineModelList) => void;
    mocked
      .mockResolvedValueOnce(list(["old/model"]))
      .mockReturnValueOnce(new Promise((r) => { resolveSecond = r; }));
    const { result, rerender } = renderHook({ projectId: "p1", agentTarget: "srv-1", agentType: "fx" });
    await flush();
    expect(result.current?.models).toEqual(["old/model"]);
    rerender({ projectId: "p1", agentTarget: "srv-2", agentType: "fx" });
    expect(result.current?.models).toBeNull();
    resolveSecond(list(["new/model"]));
    await flush();
    expect(result.current?.models).toEqual(["new/model"]);
  });

  it("refresh recovers on the same page: suggestions while the worker is offline, machine list once it is back", async () => {
    mocked
      .mockResolvedValueOnce(list(["static/suggestion"], "suggestions"))
      .mockResolvedValueOnce(list(["machine/model"]));
    const { result } = renderHook({ projectId: "p1", agentTarget: "srv-1", agentType: "fx" });
    await flush();
    expect(result.current?.models).toEqual(["static/suggestion"]);
    act(() => result.current!.refresh());
    // The current list stays on screen until the refreshed answer lands.
    expect(result.current?.models).toEqual(["static/suggestion"]);
    await flush();
    expect(result.current?.models).toEqual(["machine/model"]);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("a failed refresh keeps what is shown; no project and no session fetches nothing", async () => {
    mocked.mockResolvedValueOnce(list(["a/one"])).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook({ projectId: "p1", agentTarget: "local", agentType: "fx" });
    await flush();
    act(() => result.current!.refresh());
    await flush();
    expect(result.current?.models).toEqual(["a/one"]);
    const none = renderHook({ projectId: null, agentType: "fx" });
    expect(none.result.current?.models).toBeNull();
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
