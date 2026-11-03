// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsMenu } from "./commands-menu";
import type { Command } from "@/lib/api";

const commands = [
  { id: "c1", name: "Run tests", content: "run the test suite" },
  { id: "c2", name: "Merge to main", content: "merge this branch into main" },
] as Command[];

function Harness({ onExecute, initiallyOpen = true }: { onExecute: (content: string) => void; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <CommandsMenu
      commands={commands}
      open={open}
      onOpenChange={setOpen}
      onExecute={onExecute}
      onCreate={vi.fn(async () => null)}
      onUpdate={vi.fn(async () => null)}
      onDelete={vi.fn(async () => {})}
    />
  );
}

function rowFor(name: string): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) => el.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("CommandsMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // cmdk observes its list; Radix scrolls the active item into view.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    Element.prototype.scrollIntoView = () => {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("sends a command with one click and closes", () => {
    const onExecute = vi.fn();
    act(() => root.render(<Harness onExecute={onExecute} />));

    act(() => rowFor("Merge to main").click());

    expect(onExecute).toHaveBeenCalledExactlyOnceWith("merge this branch into main");
    expect(document.querySelector("[cmdk-item]")).toBeNull();
  });

  it("opens the editor from the pencil without sending", () => {
    const onExecute = vi.fn();
    act(() => root.render(<Harness onExecute={onExecute} />));

    act(() => rowFor("Run tests").querySelector<HTMLButtonElement>("button[aria-label='Edit Run tests']")!.click());

    expect(onExecute).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("[role='dialog'] input")?.value).toBe("Run tests");
  });

  it("offers creating a command from the footer", () => {
    act(() => root.render(<Harness onExecute={vi.fn()} />));

    const create = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("New command"))!;
    act(() => create.click());

    expect(document.querySelector<HTMLInputElement>("[role='dialog'] input")?.value).toBe("");
  });

  it("filters as you type", () => {
    act(() => root.render(<Harness onExecute={vi.fn()} />));
    const input = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
    // React tracks the value through the native setter, so set it that way.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "merg");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.querySelector<HTMLInputElement>("[cmdk-input]")?.value).toBe("merg");
    expect([...document.querySelectorAll("[cmdk-item]")].map((el) => el.textContent)).toEqual(["Merge to main"]);
  });
});
