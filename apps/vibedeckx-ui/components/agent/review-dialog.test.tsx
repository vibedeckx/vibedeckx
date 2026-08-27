// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getReviewerCandidate, createWorkflowRun, generateReviewIntentBrief, getActiveWorkflowRuns } =
  vi.hoisted(() => ({
    getReviewerCandidate: vi.fn(),
    createWorkflowRun: vi.fn(),
    generateReviewIntentBrief: vi.fn().mockResolvedValue(null),
    getActiveWorkflowRuns: vi.fn(),
  }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getReviewerCandidate,
      createWorkflowRun,
      generateReviewIntentBrief,
      getActiveWorkflowRuns,
    },
  };
});

import { ReviewDialog } from "./review-dialog";
import { fetchActiveWorkflowRuns, resetWorkflowRunsInflightForTests } from "@/lib/workflow-runs-fetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const realPlatform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");

afterEach(() => {
  act(() => root?.unmount());
  document.body.querySelectorAll("[data-radix-portal]").forEach((node) => node.remove());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  resetWorkflowRunsInflightForTests();
  if (realPlatform) Object.defineProperty(Navigator.prototype, "platform", realPlatform);
});

function setPlatform(platform: string) {
  Object.defineProperty(Navigator.prototype, "platform", {
    get: () => platform,
    configurable: true,
  });
}

async function renderAndOpen(candidate: unknown) {
  getReviewerCandidate.mockResolvedValueOnce(candidate);
  createWorkflowRun.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ReviewDialog
        projectId="p1"
        branch="dev"
        sessionId="s-src"
        currentAgentType="claude-code"
        providers={[
          { type: "claude-code", displayName: "Claude Code", available: true },
          { type: "codex", displayName: "Codex", available: true },
        ]}
      />,
    );
  });
  const trigger = container.querySelector("button")!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button"))
    .find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function startButton(): HTMLButtonElement {
  const found = document.body.querySelector('button[aria-label="Start"]');
  if (!found) throw new Error("start button not found");
  return found as HTMLButtonElement;
}

describe("ReviewDialog reviewer reuse", () => {
  it("defaults to the previous reviewer and submits its session id", async () => {
    await renderAndOpen({
      available: true,
      sessionId: "s-rev",
      title: "Review - Fix login",
      agentType: "codex",
      reason: null,
    });

    expect(document.body.textContent).toContain("Review - Fix login");
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "s-src",
      reviewerSessionId: "s-rev",
    }));
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewerAgentType");
  });

  it("can switch to a new reviewer session and submit an agent type", async () => {
    await renderAndOpen({
      available: true,
      sessionId: "s-rev",
      title: "Review - Fix login",
      agentType: "codex",
      reason: null,
    });

    await act(async () => {
      button("New reviewer session").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Agent");
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "s-src",
      reviewerAgentType: "codex",
    }));
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewerSessionId");
  });

  it("falls back to a new reviewer when the previous one is unavailable", async () => {
    await renderAndOpen({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      reason: "deleted",
    });

    expect(document.body.textContent).toContain("The last reviewer is no longer available");
    expect(document.body.textContent).toContain("Agent");
  });
});

describe("ReviewDialog intent brief", () => {
  it("pre-generates on open without waiting for the reviewer candidate", async () => {
    // Distillation is the long pole (model calls, tens of seconds); anything
    // serial ahead of it lands on the user as submit-time latency.
    let resolveCandidate: (value: unknown) => void = () => {};
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { resolveCandidate = resolve; }));
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ReviewDialog projectId="p1" branch="dev" sessionId="s-src" />);
    });
    await act(async () => {
      container!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(generateReviewIntentBrief).toHaveBeenCalledWith("p1", "s-src");
    await act(async () => {
      resolveCandidate(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  // Omitting the field would read server-side as "the client never tried" and
  // trigger a second full distillation inside the create request.
  it("reports a failed pre-generation as an attempt rather than omitting it", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce(null);
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ intentBrief: "" }));
  });

  // A rejection means the request never got an answer (auth, 404, network) —
  // the route returns 200 + {brief: null} when distillation itself yields
  // nothing. Nothing was distilled, so the server's own pass is still worth
  // having: omit the field rather than suppressing it with "".
  it("omits the field when the pre-generation request never reached the server", async () => {
    generateReviewIntentBrief.mockRejectedValueOnce(new Error("Failed to generate intent brief: 503"));
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("intentBrief");
  });

  it("sends the pre-generated brief when there is one", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce("the brief");
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ intentBrief: "the brief" }));
  });

  // Props can change under an open dialog (a commander surfacing a freshly
  // spawned session). Submitting the previous session's brief would hand the
  // reviewer another conversation's intent as this one's.
  it("re-generates when the session changes under an open dialog", async () => {
    getReviewerCandidate.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    createWorkflowRun.mockResolvedValue({});
    generateReviewIntentBrief
      .mockResolvedValueOnce("brief for s-a")
      .mockResolvedValueOnce("brief for s-b");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (sessionId: string) => act(async () => {
      root!.render(<ReviewDialog projectId="p1" branch="dev" sessionId={sessionId} />);
    });

    await render("s-a");
    await act(async () => {
      container!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await render("s-b");

    expect(generateReviewIntentBrief).toHaveBeenCalledTimes(2);
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "s-b",
      intentBrief: "brief for s-b",
    }));
  });

  // Reuse continues the reviewer's own context, so no brief rides along.
  it("omits the brief entirely when reusing a reviewer", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce("the brief");
    await renderAndOpen({ available: true, sessionId: "s-rev", title: "Prev", agentType: "codex", reason: null });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("intentBrief");
  });
});

describe("ReviewDialog review span", () => {
  it("sends reviewSpan this_turn by default on a fresh review", async () => {
    await renderAndOpen({
      available: false,
      sessionId: null,
      title: null,
      agentType: null,
      reason: "deleted",
    });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ reviewSpan: "this_turn" }),
    );
  });

  it("keeps the scope and context rows stable in reuse mode", async () => {
    await renderAndOpen({
      available: true,
      sessionId: "s-rev",
      title: "Prev",
      agentType: "claude-code",
      reason: null,
    });
    // reuse mode is auto-selected when a reusable candidate exists
    const texts = Array.from(document.body.querySelectorAll("span"))
      .map((el) => el.textContent);
    expect(texts).toContain("Scope");
    // A reused reviewer already carries earlier rounds' context. Keep the row
    // for stable dialog height, but lock it to With context.
    expect(texts).toContain("Context");
    expect(button("With context").disabled).toBe(true);
    expect(button("With context").getAttribute("aria-pressed")).toBe("true");
    expect(button("Blind").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Recommended");
  });
});

describe("ReviewDialog review context", () => {
  it("defaults to briefed and omits the mode field", async () => {
    await renderAndOpen({
      available: false, sessionId: null, title: null, agentType: null, reason: "deleted",
    });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewContextMode");
  });

  it("sends blind and drops the brief when Blind is selected", async () => {
    generateReviewIntentBrief.mockResolvedValueOnce("the brief");
    await renderAndOpen({
      available: false, sessionId: null, title: null, agentType: null, reason: "deleted",
    });
    await act(async () => {
      button("Blind").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      reviewContextMode: "blind",
    }));
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("intentBrief");
  });
});

describe("ReviewDialog shortcut hint", () => {
  it("shows Ctrl+Enter on Linux and Windows", async () => {
    setPlatform("Linux x86_64");
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    const hint = document.body.querySelector('kbd[title="Ctrl+Enter"]');
    expect(hint?.textContent).toBe("Ctrl⏎");
  });

  it("shows Command+Enter on macOS", async () => {
    setPlatform("MacIntel");
    await renderAndOpen({ available: false, sessionId: null, title: null, agentType: null, reason: "deleted" });
    const hint = document.body.querySelector('kbd[title="Command+Enter"]');
    expect(hint?.textContent).toBe("⌘⏎");
  });
});

/**
 * The branch's workflow-runs poll carries `reviewedSessionIds`, so the dialog
 * knows whether a "continue last reviewer" choice can exist BEFORE it opens —
 * including when a keyboard shortcut opens it, which no hover prefetch could
 * cover. These tests drive the real store (not a mock of it) so the read path
 * — module snapshot → useSyncExternalStore → derived selection — is exercised
 * end to end.
 */
async function seedBranchSnapshot(reviewedSessionIds: string[] | undefined) {
  getActiveWorkflowRuns.mockResolvedValue({
    runs: [],
    ...(reviewedSessionIds ? { reviewedSessionIds } : {}),
  });
  await fetchActiveWorkflowRuns("p1", "dev");
}

/** Opens the dialog while the candidate check is still in flight. */
async function renderAndOpenPending() {
  let settle!: (candidate: unknown) => void;
  // mockReset, not just clear: afterEach's clearAllMocks leaves the
  // once-queue intact, and the never-reviewed case deliberately never
  // consumes its queued value — which the next test would then pick up.
  getReviewerCandidate.mockReset();
  getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
  createWorkflowRun.mockResolvedValue({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ReviewDialog
        projectId="p1"
        branch="dev"
        sessionId="s-src"
        currentAgentType="claude-code"
        providers={[
          { type: "claude-code", displayName: "Claude Code", available: true },
          { type: "codex", displayName: "Codex", available: true },
        ]}
      />,
    );
  });
  const trigger = container.querySelector("button")!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return { settle: async (candidate: unknown) => {
    await act(async () => {
      settle(candidate);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } };
}

function radio(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button[role="radio"]'))
    .find((node) => node.textContent?.includes(text));
  if (!found) throw new Error(`radio not found: ${text}`);
  return found as HTMLButtonElement;
}

const AVAILABLE_CANDIDATE = {
  available: true,
  sessionId: "s-rev",
  title: "Review - Fix login",
  agentType: "codex",
  lastActiveAt: null,
  reason: null,
};


function cancelButton(): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button"))
    .find((node) => node.textContent?.trim() === "Cancel");
  if (!found) throw new Error("Cancel button not found");
  return found as HTMLButtonElement;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function reviewDialog(sessionId: string) {
  return (
    <ReviewDialog
      projectId="p1"
      branch="dev"
      sessionId={sessionId}
      currentAgentType="claude-code"
      providers={[
        { type: "claude-code", displayName: "Claude Code", available: true },
        { type: "codex", displayName: "Codex", available: true },
      ]}
    />
  );
}

const UNAVAILABLE_CANDIDATE = {
  available: false,
  sessionId: null,
  title: null,
  agentType: null,
  lastActiveAt: null,
  reason: "busy",
};

describe("ReviewDialog prior-review snapshot", () => {
  // The common case. Nothing to continue ⇒ nothing to ask, and no window in
  // which Start sits disabled waiting for an answer of "no". The snapshot is
  // seeded through the real fetch layer and no ancestor rerenders between
  // seeding and opening — a prop would still be `undefined` here.
  it("skips the candidate request entirely when the branch says never reviewed", async () => {
    await seedBranchSnapshot([]);
    await renderAndOpenPending();

    expect(getReviewerCandidate).not.toHaveBeenCalled();
    expect(startButton().disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Continue last reviewer");
    expect(document.body.textContent).not.toContain("Checking last reviewer");
  });

  // Frame one, not "after the request lands": the card is drawn and selected
  // from the snapshot, with only its metadata pending.
  it("selects Continue last reviewer on the first rendered frame", async () => {
    await seedBranchSnapshot(["s-src"]);
    const { settle } = await renderAndOpenPending();

    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain("Loading details…");
    expect(startButton().disabled).toBe(false);

    await settle(AVAILABLE_CANDIDATE);
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Review - Fix login");
  });

  // The old failure: the late callback set the selection unconditionally, so a
  // user who picked New during the wait was silently switched back.
  it("never overrides an explicit New choice made before the candidate resolves", async () => {
    await seedBranchSnapshot(["s-src"]);
    const { settle } = await renderAndOpenPending();

    await act(async () => {
      radio("New reviewer session").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(AVAILABLE_CANDIDATE);

    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("true");
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ reviewerAgentType: "codex" }));
    expect(createWorkflowRun.mock.calls[0][0]).not.toHaveProperty("reviewerSessionId");
  });

  // Submitting inside the check's window resolves it behind the spinner. When
  // the optimistic guess loses, the run is NOT started with a substitute
  // reviewer — the user asked to continue a specific one.
  it("aborts the submit when the optimistically selected reviewer turns out unavailable", async () => {
    await seedBranchSnapshot(["s-src"]);
    let settleCandidate!: (candidate: unknown) => void;
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleCandidate = resolve; }));
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ReviewDialog projectId="p1" branch="dev" sessionId="s-src" />);
    });
    await act(async () => {
      container!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(startButton().disabled).toBe(false);
    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      settleCandidate({ available: false, sessionId: null, title: null, agentType: null, reason: "busy" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createWorkflowRun).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("The last reviewer is no longer available");
    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("true");
  });

  // Compat: a worker that predates the field sends nothing, which must not be
  // read as "never reviewed". Unknown ⇒ exactly the pre-existing behaviour,
  // including Start blocked until the check lands.
  it("keeps the old blocking behaviour when the snapshot is unknown", async () => {
    await seedBranchSnapshot(undefined);
    const { settle } = await renderAndOpenPending();

    expect(getReviewerCandidate).toHaveBeenCalledTimes(1);
    expect(startButton().disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Continue last reviewer");

    await settle(AVAILABLE_CANDIDATE);
    expect(startButton().disabled).toBe(false);
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
  });
});

/**
 * The candidate answer outlives a close and a session switch, while the effect
 * that would refresh it only runs a frame later. Anything read during that
 * frame must therefore be scoped to the session it actually answers for.
 */
describe("ReviewDialog candidate state is scoped to its session and open cycle", () => {
  // `running` and `busy` are ordinary transient verdicts, so last open cycle's
  // answer is not evidence about this one. Trusting it hid a card that had
  // since become reusable, and only inserted it once the new request landed —
  // the exact delayed-card jump this whole change exists to remove.
  it("re-asks on reopen when the previous verdict was unavailable", async () => {
    await seedBranchSnapshot(["s-src"]);
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockResolvedValueOnce(UNAVAILABLE_CANDIDATE);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });

    await click(container!.querySelector("button")!);
    expect(document.body.textContent).not.toContain("Continue last reviewer");
    await click(cancelButton());

    // The reviewer has since gone idle. Reopen with the re-check pending so
    // the frames before it lands are observable: the card must already be
    // there, drawn from the snapshot, not inserted after the response.
    let settleSecond!: (candidate: unknown) => void;
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleSecond = resolve; }));
    await click(container!.querySelector("button")!);

    expect(getReviewerCandidate).toHaveBeenCalledTimes(2);
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      settleSecond(AVAILABLE_CANDIDATE);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Review - Fix login");
  });

  // The mirror case, and the one that was a correctness bug rather than a
  // cosmetic one: a stale "available" made start() skip the in-flight check
  // and submit a reviewer id the server had already stopped accepting.
  it("waits for the new check on reopen instead of submitting the previous verdict", async () => {
    await seedBranchSnapshot(["s-src"]);
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockResolvedValueOnce(AVAILABLE_CANDIDATE);
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });

    await click(container!.querySelector("button")!);
    expect(document.body.textContent).toContain("Review - Fix login");
    await click(cancelButton());

    // The reviewer has since been taken by another run. Reopen and press Start
    // immediately — the click resolves the pending check behind the spinner
    // and must take the agreed abort path, not create a run.
    let settleSecond!: (candidate: unknown) => void;
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleSecond = resolve; }));
    await click(container!.querySelector("button")!);
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      startButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      settleSecond(UNAVAILABLE_CANDIDATE);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createWorkflowRun).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("The last reviewer is no longer available");
    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("true");
  });

  it("does not carry an explicit reviewer choice across a session switch", async () => {
    await seedBranchSnapshot(["s-src", "s-other"]);
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockResolvedValue(AVAILABLE_CANDIDATE);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });
    await click(container!.querySelector("button")!);

    await click(radio("New reviewer session"));
    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("true");

    // The choice was about s-src. s-other gets to start from its own default.
    await act(async () => { root!.render(reviewDialog("s-other")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
  });

  it("never shows the previous session's reviewer after a session switch", async () => {
    await seedBranchSnapshot(["s-src", "s-other"]);
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockResolvedValueOnce(AVAILABLE_CANDIDATE);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });
    await click(container!.querySelector("button")!);
    expect(document.body.textContent).toContain("Review - Fix login");

    // Switch the session under the open dialog. The old answer is tagged with
    // s-src, so it stops counting the moment the prop changes — not one frame
    // later when the effect re-runs.
    let settleSecond!: (candidate: unknown) => void;
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleSecond = resolve; }));
    await act(async () => { root!.render(reviewDialog("s-other")); });

    expect(document.body.textContent).not.toContain("Review - Fix login");
    expect(document.body.textContent).toContain("Loading details…");

    await act(async () => {
      settleSecond({ ...AVAILABLE_CANDIDATE, sessionId: "s-rev2", title: "Review - Other" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Review - Other");
  });

  it("clears an explicit reviewer choice when the dialog closes on a successful start", async () => {
    await seedBranchSnapshot(["s-src"]);
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockResolvedValue(AVAILABLE_CANDIDATE);
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });

    await click(container!.querySelector("button")!);
    await click(radio("New reviewer session"));
    await click(startButton());
    expect(createWorkflowRun).toHaveBeenCalledTimes(1);

    // That close is programmatic, not a user-driven onOpenChange — the path
    // that used to leak the override into the next open's first frame.
    await click(container!.querySelector("button")!);
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
  });

  // The reuse card unmounts when the check says unavailable. If the mode kept
  // pointing at it, New would render selected while Start still took the reuse
  // branch and aborted without starting anything.
  it("collapses an explicit Continue choice to New once reuse turns unavailable", async () => {
    await seedBranchSnapshot(["s-src"]);
    let settleCandidate!: (candidate: unknown) => void;
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleCandidate = resolve; }));
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });
    await click(container!.querySelector("button")!);

    await click(radio("Continue last reviewer"));
    await act(async () => {
      settleCandidate(UNAVAILABLE_CANDIDATE);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).not.toContain("Continue last reviewer");
    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("true");

    await click(startButton());
    expect(createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerAgentType: "codex" }),
    );
  });
});

/**
 * The snapshot is monotonic, so an open dialog can watch a session go from
 * never-reviewed to reviewed — a review that finished elsewhere while it sat
 * open. That transition must produce the card immediately, not a window in
 * which New is selected and submittable while the card is already on its way.
 */
describe("ReviewDialog reacts to the snapshot flipping under an open dialog", () => {
  it("shows and selects Continue the moment the branch reports a first review", async () => {
    await seedBranchSnapshot([]);
    getReviewerCandidate.mockReset();
    createWorkflowRun.mockResolvedValue({});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });
    await click(container!.querySelector("button")!);

    expect(getReviewerCandidate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Continue last reviewer");

    // A review completes elsewhere; the next poll unions its source session in.
    let settleCandidate!: (candidate: unknown) => void;
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleCandidate = resolve; }));
    await act(async () => {
      getActiveWorkflowRuns.mockResolvedValue({ runs: [], reviewedSessionIds: ["s-src"] });
      await fetchActiveWorkflowRuns("p1", "dev", { force: true });
    });

    // Same render as the flip — not after the request that it just triggered.
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
    expect(radio("New reviewer session").getAttribute("aria-checked")).toBe("false");
    expect(getReviewerCandidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      settleCandidate(AVAILABLE_CANDIDATE);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Review - Fix login");
  });
});

/**
 * A null candidate is the backend's "there is no last reviewer". Whether that
 * is worth an amber notice depends entirely on whether anything had promised
 * one — and the snapshot that does the promising can arrive mid-flight.
 */
describe("ReviewDialog explains a vanished reviewer only when one was promised", () => {
  it("stays silent when an unknown snapshot yields no candidate", async () => {
    await seedBranchSnapshot(undefined);
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockResolvedValueOnce(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });

    await click(container!.querySelector("button")!);

    // Never reviewed, and nothing ever claimed otherwise. Saying the last
    // reviewer is gone would invent one.
    expect(document.body.textContent).not.toContain("no longer available");
    expect(document.body.textContent).not.toContain("Only option");
    expect(document.body.textContent).not.toContain("Continue last reviewer");
  });

  it("explains the demotion when the snapshot promised a card mid-flight", async () => {
    await seedBranchSnapshot(undefined);
    let settleCandidate!: (candidate: unknown) => void;
    getReviewerCandidate.mockReset();
    getReviewerCandidate.mockReturnValueOnce(new Promise((resolve) => { settleCandidate = resolve; }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(reviewDialog("s-src")); });
    await click(container!.querySelector("button")!);

    // The snapshot lands while the check is in flight and draws the card. The
    // id it carries belongs to a run retention has since reclaimed, so the
    // check comes back with nothing behind it.
    await act(async () => {
      getActiveWorkflowRuns.mockResolvedValue({ runs: [], reviewedSessionIds: ["s-src"] });
      await fetchActiveWorkflowRuns("p1", "dev", { force: true });
    });
    expect(radio("Continue last reviewer").getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      settleCandidate(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // A closure-captured snapshot would still read `undefined` here and let the
    // card disappear without a word.
    expect(document.body.textContent).not.toContain("Continue last reviewer");
    expect(document.body.textContent).toContain("The last reviewer is no longer available");
  });
});
