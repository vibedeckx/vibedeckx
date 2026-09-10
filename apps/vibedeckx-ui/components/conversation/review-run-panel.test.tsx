// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runFixture = {
  id: "r1", project_id: "p1", branch: "dev",
  source_session_id: "s-src", source_turn_end_index: 4,
  reviewer_session_id: "s-rev", review_focus: null, review_target: null,
  review_span: "this_turn", feedback_snapshot: "old feedback",
  status: "discussing", error: null, created_at: "", updated_at: "",
};

vi.mock("@/lib/api", () => ({
  api: {
    getActiveWorkflowRuns: vi.fn(async () => ({ runs: [runFixture] })),
    workflowRunGate: vi.fn(async () => runFixture),
    cancelWorkflowRun: vi.fn(async () => runFixture),
  },
}));
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));

import { ReviewRunPanel } from "./review-run-panel";
import { api } from "@/lib/api";
import { resetWorkflowRunsInflightForTests } from "@/lib/workflow-runs-fetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReviewRunPanel discussing state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the discussing hint and an icon-only finalize button", async () => {
    expect(container.textContent).toContain("讨论中");
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 review 终稿"]',
    );
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("");
    // 讨论态不显示发送/编辑(那是 waiting_feedback 的控件)。
    expect(container.textContent).not.toContain("发送反馈给原 session");
  });

  it("clicking finalize calls the gate with the finalize action", async () => {
    const btn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 review 终稿"]',
    )!;
    await act(async () => { btn.click(); });
    expect(api.workflowRunGate).toHaveBeenCalledWith("r1", "finalize");
  });
});

describe("ReviewRunPanel WS reconnect reconciliation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetWorkflowRunsInflightForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // 掉线期间发出的 WorkflowRunUpdated 是丢帧且不重放的,面板手里 0 条 run 时
  // 又不会轮询 —— 没有这次对账,重连后面板会一直空着(2026-08-18 事故)。
  it("re-reads on a streamEpoch bump and surfaces a run pushed while the socket was down", async () => {
    const waiting = { ...runFixture, status: "waiting_feedback" as const, feedback_snapshot: "verdict" };
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({ runs: [waiting] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    expect(container.textContent).toBe("");

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    expect(api.getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("等你确认反馈");
  });

  it("does not re-read when nothing but an unrelated re-render happens", async () => {
    vi.mocked(api.getActiveWorkflowRuns).mockResolvedValue({ runs: [] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    expect(api.getActiveWorkflowRuns).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewRunPanel out-of-order reads", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetWorkflowRunsInflightForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // mount 的那次读发出得早、返回得晚(远程代理往返会互相超车)。它带的是 run 出现
  // 之前的空快照,若允许落地就会把重连对账刚拉到的 run 再抹掉。
  it("keeps the newest read when an earlier one resolves last", async () => {
    const waiting = { ...runFixture, status: "waiting_feedback" as const };
    let resolveMount: (payload: { runs: typeof waiting[] }) => void = () => {};
    vi.mocked(api.getActiveWorkflowRuns)
      .mockReturnValueOnce(new Promise((resolve) => { resolveMount = resolve; }))
      .mockResolvedValueOnce({ runs: [waiting] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    // 重连对账:第二次读先返回,面板显示 run。
    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    expect(container.textContent).toContain("等你确认反馈");

    // mount 那次姗姗来迟的空快照必须被丢弃。
    await act(async () => { resolveMount({ runs: [] }); });
    expect(container.textContent).toContain("等你确认反馈");
  });
});

// 休眠唤醒后 WS 是僵尸、轮询失败被静默吞掉,面板会短暂停留在睡前快照 —— 按钮
// 照常可点(这是有意的),于是点击撞上服务端的状态守卫。这一组锁住那次失败之后
// 的行为:提示按刷新后的真实状态写,只挂在自己的 run 上,并在状态再变时消失。
describe("ReviewRunPanel stale-click errors", () => {
  let container: HTMLDivElement;
  let root: Root;

  const waiting = { ...runFixture, status: "waiting_feedback" as const, feedback_snapshot: "verdict" };
  const discussing = { ...runFixture, status: "discussing" as const };
  const clickApprove = async () => {
    const btn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("发送反馈给原 session"))!;
    await act(async () => { btn.click(); });
    await act(async () => {});
  };

  beforeEach(() => {
    resetWorkflowRunsInflightForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("explains a rejected approve with the refreshed status instead of the backend guard text", async () => {
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [waiting] })   // 睡前快照:还挂着发送按钮
      .mockResolvedValue({ runs: [discussing] });   // 点击后对账:早就进讨论了
    vi.mocked(api.workflowRunGate).mockRejectedValue(new Error("run 不在等待反馈确认的状态"));

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await clickApprove();

    expect(container.textContent).toContain("先点「生成终稿」");
    expect(container.textContent).not.toContain("run 不在等待反馈确认的状态");
  });

  // 面板常驻挂载(没有活跃 run 时只是 return null),旧写法里这行红字会活到
  // 下一次 review,挂在一个跟它毫无关系的 run 卡片下面。
  it("drops the message once that run's status changes again", async () => {
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [waiting] })
      .mockResolvedValueOnce({ runs: [discussing] })
      .mockResolvedValue({ runs: [waiting] });      // 讨论完出了终稿
    vi.mocked(api.workflowRunGate).mockRejectedValue(new Error("run 不在等待反馈确认的状态"));

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await clickApprove();
    expect(container.textContent).toContain("先点「生成终稿」");

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    expect(container.textContent).not.toContain("先点「生成终稿」");
    expect(container.textContent).toContain("等你确认反馈");
  });

  // run 在点击落地前就没了(已结束/被取消/反馈其实已发出):提示没有卡片可挂,
  // 又不能让面板直接消失 —— 否则用户点完只看到卡片凭空不见,得不到任何交代。
  it("keeps a dismissible notice when the run is gone by the time the click lands", async () => {
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [waiting] })
      .mockResolvedValue({ runs: [] });
    vi.mocked(api.workflowRunGate).mockRejectedValue(new Error("run 不在等待反馈确认的状态"));

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await clickApprove();
    expect(container.textContent).toContain("这次 review 已经结束了");

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')!;
    await act(async () => { dismiss.click(); });
    expect(container.textContent).toBe("");
  });

  // 自己那趟读被更晚发出的读超车:提示必须用已经落地的那份(= 屏幕上的)快照来
  // 解释,而不是把后端原文当成"最新状态"写回去。
  it("explains from the newest landed snapshot when its own read is overtaken", async () => {
    let resolveOwn: (payload: { runs: typeof waiting[] }) => void = () => {};
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [waiting] })                                    // mount
      .mockReturnValueOnce(new Promise((resolve) => { resolveOwn = resolve; }))      // 点击后那趟(共享)
      .mockResolvedValueOnce({ runs: [discussing] });                                // epoch 对账,先落地
    vi.mocked(api.workflowRunGate).mockRejectedValue(new Error("run 不在等待反馈确认的状态"));

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await clickApprove();

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    // 迟到的那趟带着动作之前的快照返回。
    await act(async () => { resolveOwn({ runs: [waiting] }); });
    await act(async () => {});

    expect(container.textContent).toContain("先点「生成终稿」");
    expect(container.textContent).not.toContain("run 不在等待反馈确认的状态");
  });

  // 无主提示的 status 恒为 null,状态比较清不掉它;下一次 review 开起来时它必须
  // 自己让位,否则又变成"红字挂在一个不相干的 run 上"——这次要修的原病。
  it("drops the orphan notice as soon as a new review shows up", async () => {
    const nextRun = { ...runFixture, id: "r2", status: "discussing" as const };
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [waiting] })
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValue({ runs: [nextRun] });
    vi.mocked(api.workflowRunGate).mockRejectedValue(new Error("run 不在等待反馈确认的状态"));

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await clickApprove();
    expect(container.textContent).toContain("这次 review 已经结束了");

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={1} />);
    });
    expect(container.textContent).not.toContain("这次 review 已经结束了");
    expect(container.textContent).toContain("讨论中");
  });

  // 按钮在 finally 里就放开了,用户可以在第一趟对账还没回来时重试。重试成功之后
  // 不能再冒出上一轮那条红字。
  it("lets a newer action invalidate the previous one's late explanation", async () => {
    let resolveFirst: (payload: { runs: typeof waiting[] }) => void = () => {};
    vi.mocked(api.getActiveWorkflowRuns)
      .mockResolvedValueOnce({ runs: [waiting] })                                    // mount
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))    // 第一次点击的对账
      .mockResolvedValue({ runs: [] });                                              // 重试成功后的对账
    vi.mocked(api.workflowRunGate)
      .mockRejectedValueOnce(new Error("run 不在等待反馈确认的状态"))
      .mockResolvedValueOnce(waiting); // 返回值组件不看,给个类型合法的 run 即可

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    await clickApprove();   // 失败,对账还挂着
    await clickApprove();   // 重试成功,面板刷成空
    expect(container.textContent).toBe("");

    await act(async () => { resolveFirst({ runs: [] }); });
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  // 唤醒后的恢复点:页面重新可见就对账,而不是干等下一次成功轮询。
  it("re-reads when the page becomes visible again", async () => {
    vi.mocked(api.getActiveWorkflowRuns).mockResolvedValue({ runs: [] });

    await act(async () => {
      root.render(<ReviewRunPanel projectId="p1" branch="dev" runUpdate={null} streamEpoch={0} />);
    });
    expect(api.getActiveWorkflowRuns).toHaveBeenCalledTimes(1);

    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(api.getActiveWorkflowRuns).toHaveBeenCalledTimes(2);
  });
});
