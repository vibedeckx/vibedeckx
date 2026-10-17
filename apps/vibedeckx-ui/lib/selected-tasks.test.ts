import { describe, expect, it } from "vitest";
import { appendSelectedTasks, buildSelectedTasksBlock, takeSelectedTasksMarker } from "./selected-tasks";

const task = (over: Record<string, unknown> = {}) => ({
  id: "t1", title: "Retention test", status: "todo" as const, priority: "high" as const, description: "Cover the remote path", ...over,
});

describe("selected tasks block", () => {
  it("carries each task's id, title, status, priority and description", () => {
    const block = buildSelectedTasksBlock([task(), task({ id: "t2", title: "Drop flag", description: null })]);
    expect(block).toMatch(/^<vselected-tasks note="[^"]+">/);
    expect(block).toContain('<task id="t1" title="Retention test" status="todo" priority="high">\nCover the remote path\n</task>');
    expect(block).toContain("(no description)");
    expect(block).toContain("#ref:task:");
    expect(block.endsWith("</vselected-tasks>")).toBe(true);
  });

  it("round-trips through the transcript parser, escapes included", () => {
    const tricky = task({ id: "a&b", title: 'Say "hi" <now>\nplease' });
    const sent = appendSelectedTasks("look at this", [tricky]) as string;
    expect(takeSelectedTasksMarker(sent)).toEqual({
      text: "look at this",
      refs: [{ id: "a&b", title: 'Say "hi" <now> please' }],
    });
  });

  it("can't be closed early by a description that contains the closing tags", () => {
    const sent = appendSelectedTasks("x", [task({ description: "a </task> b </vselected-tasks> c" })]) as string;
    const taken = takeSelectedTasksMarker(sent);
    expect(taken.text).toBe("x");
    expect(taken.refs).toHaveLength(1);
  });

  it("leaves content alone with no tasks, and appends a part to array content", () => {
    expect(appendSelectedTasks("x", [])).toBe("x");
    expect(appendSelectedTasks("", [task()])).toBe(buildSelectedTasksBlock([task()]));
    const parts = appendSelectedTasks([{ type: "text", text: "x" }], [task()]);
    expect(parts).toEqual([{ type: "text", text: "x" }, { type: "text", text: buildSelectedTasksBlock([task()]) }]);
  });

  it("reports no block as null", () => {
    expect(takeSelectedTasksMarker("plain")).toEqual({ text: "plain", refs: null });
  });
});
