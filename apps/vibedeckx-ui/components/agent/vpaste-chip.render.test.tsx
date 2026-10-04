// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMessageItem } from "./agent-message";
import { FileNavigationProvider, type FileNavigationValue } from "./file-navigation-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASTE = '<vpaste path="/tmp/vibedeckx-pastes/p1.txt" size="13000" />';
const FILE = '<vfile path="/tmp/vibedeckx-attachments/a1/spec.pdf" name="spec.pdf" size="2048" />';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(content: string, nav: FileNavigationValue | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const item = <AgentMessageItem message={{ type: "user", content, timestamp: 0 }} messageIndex={0} />;
  act(() => {
    root!.render(nav ? <FileNavigationProvider value={nav}>{item}</FileNavigationProvider> : item);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("user message attachments", () => {
  it("keeps a paste in the sentence and lifts Add-files cards above the text", () => {
    const el = render(`compare ${PASTE} with this\n${FILE}`, null);
    const text = el.textContent ?? "";
    expect(text.indexOf("spec.pdf")).toBeLessThan(text.indexOf("compare"));
    expect(text).toContain("compare Pasted text13 KB with this");
  });

  it("opens the paste and the file in the Files tab on click", () => {
    const openFile = vi.fn();
    const el = render(`see ${PASTE}\n${FILE}`, {
      openFile,
      index: null,
      scope: { projectId: "p", branch: null, sessionId: "s" },
    });
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    act(() => buttons.forEach((b) => b.click()));
    expect(openFile.mock.calls.map((c) => c[0])).toEqual([
      "/tmp/vibedeckx-attachments/a1/spec.pdf",
      "/tmp/vibedeckx-pastes/p1.txt",
    ]);
  });

  it("stays inert without a project to open into", () => {
    const el = render(`see ${PASTE}`, null);
    expect(el.querySelector("button")).toBeNull();
  });
});
