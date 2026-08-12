// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { FileNavigationProvider } from "./file-navigation-context";
import { AgentMarkdown } from "./agent-markdown";
import { AgentMessageItem } from "./agent-message";
import type { AgentMessage } from "@/hooks/use-agent-session";

// Guards the session-switch flash: Streamdown's default `streaming` mode holds
// its parsed blocks in state and commits them from an effect, so the FIRST
// painted frame of every message is empty — on a session switch that is every
// assistant message collapsing to header height (~46px) and growing back ~100ms
// later, which reads as content flickering even though no data moved.
//
// The assertion has to look at the pre-effect commit, because once effects run
// both modes converge. flushSync commits the render without draining the
// passive-effect queue, which is exactly the state the browser paints.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MESSAGE = "hello **world**";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function renderFirstPaint(streaming: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <FileNavigationProvider value={{ openFile: () => {}, index: null }}>
        <AgentMarkdown streaming={streaming}>{MESSAGE}</AgentMarkdown>
      </FileNavigationProvider>
    );
  });
  return container;
}

// Let the deferred commit land inside act(), so the pending update doesn't
// surface as an act warning after the test has finished.
const settle = () => act(async () => {});

describe("AgentMarkdown first paint", () => {
  it("renders history markdown in the first committed frame", async () => {
    expect(renderFirstPaint(false).textContent).toContain("hello");
    await settle();
  });

  it("still defers the actively streaming message", async () => {
    // Not a requirement in itself — it documents why the default had to change,
    // and pins that `streaming` keeps Streamdown's deferred path.
    expect(renderFirstPaint(true).textContent).not.toContain("hello");
    await settle();
    expect(container?.textContent).toContain("hello");
  });
});

// A workflow-injected user turn is markdown too, and while its turn runs it is
// the tail message — the one the conversation marks as streaming. Nothing is
// appended to it though, so the deferred path buys nothing and costs the same
// 46px→full flash on every session switch. The renderer, not the call site,
// is what makes that unrepresentable.
describe("AgentMessageItem markdown mode", () => {
  it("keeps a tail workflow user turn on the first-paint path", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const message = {
      type: "user",
      content: MESSAGE,
      origin: "workflow",
      timestamp: 0,
    } as AgentMessage;

    flushSync(() => {
      root!.render(
        <FileNavigationProvider value={{ openFile: () => {}, index: null }}>
          <AgentMessageItem message={message} messageIndex={0} streaming />
        </FileNavigationProvider>
      );
    });

    expect(container.textContent).toContain("hello");
    await settle();
  });
});
