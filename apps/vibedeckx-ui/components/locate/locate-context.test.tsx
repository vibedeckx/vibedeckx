// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LocateProvider, useLocateScope, useLocateEngagement } from "./locate-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  { id: "__main__", text: "main" },
  { id: "alpha-ui", text: "alpha-ui" },
  { id: "beta-api", text: "beta-api" },
];

let commits: string[] = [];

// Renders the engagement the way a list would consume it, flattened to text.
function Probe({ secondary = false }: { secondary?: boolean }) {
  useLocateScope(
    {
      id: "workspaces",
      label: "Workspaces",
      priority: 0,
      getItems: () => ITEMS,
      onCommit: (item) => commits.push(item.id),
      onSecondaryCommit: secondary ? (item) => commits.push(`secondary:${item.id}`) : undefined,
    },
    true,
  );
  const engagement = useLocateEngagement("workspaces");
  return (
    <div data-testid="state">
      {engagement
        ? `${engagement.query}|${engagement.selectedId}|${engagement.matchCount}`
        : "idle"}
    </div>
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  commits = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <LocateProvider>
        <Probe />
      </LocateProvider>,
    );
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

const state = () => container!.querySelector('[data-testid="state"]')!.textContent;

// Returns true when the event was NOT consumed (dispatchEvent semantics), i.e.
// it would still reach other layers.
function press(init: KeyboardEventInit, target: EventTarget = window): boolean {
  let passedThrough = true;
  act(() => {
    passedThrough = target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
  return passedThrough;
}

const type = (text: string, target: EventTarget = window) => {
  for (const key of text) press({ key }, target);
};

describe("LocateProvider", () => {
  it("engages on typing, fuzzy-selects the best match, and commits on Enter", () => {
    type("alp");
    expect(state()).toBe("alp|alpha-ui|1");

    expect(press({ key: "Enter" })).toBe(false); // consumed
    expect(state()).toBe("idle");
    expect(commits).toEqual(["alpha-ui"]);
  });

  it("cycles matches in list order with the arrows, starting from the best match", () => {
    type("a"); // subsequence of all three; alpha-ui scores best (boundary hit)
    expect(state()).toBe("a|alpha-ui|3");

    press({ key: "ArrowDown" });
    expect(state()).toBe("a|beta-api|3");
    press({ key: "ArrowDown" }); // wraps in list order
    expect(state()).toBe("a|__main__|3");
    press({ key: "ArrowUp" });
    expect(state()).toBe("a|beta-api|3");
  });

  it("edits with Backspace and disengages when the query empties", () => {
    type("be");
    expect(state()).toBe("be|beta-api|1");

    press({ key: "Backspace" });
    expect(state()).toBe("b|beta-api|1");
    press({ key: "Backspace" });
    expect(state()).toBe("idle");
  });

  it("consumes Escape to clear the query, shielding outer Esc handlers", () => {
    type("a");
    expect(press({ key: "Escape" })).toBe(false); // consumed
    expect(state()).toBe("idle");
    // A second Esc is no longer ours.
    expect(press({ key: "Escape" })).toBe(true);
  });

  it("fires the secondary commit on Space when the scope defines one", () => {
    // Handler presence is captured at registration, so mount fresh.
    act(() => root!.unmount());
    root = createRoot(container!);
    act(() => {
      root!.render(
        <LocateProvider>
          <Probe secondary />
        </LocateProvider>,
      );
    });
    type("alp");
    expect(press({ key: " " })).toBe(false); // consumed
    expect(state()).toBe("idle");
    expect(commits).toEqual(["secondary:alpha-ui"]);
  });

  it("treats Space as plain input when the scope has no secondary commit", () => {
    type("alp");
    press({ key: " " });
    // Query grows (whitespace is ignored by the matcher), still engaged.
    expect(state()).toBe("alp |alpha-ui|1");
  });

  it("lets modifier combos pass through while engaged (Cmd+K stays reachable)", () => {
    type("a");
    expect(press({ key: "k", metaKey: true })).toBe(true); // not consumed
    expect(state()).toBe("a|alpha-ui|3"); // still engaged
  });

  it("hands Esc back to an overlay layer instead of eating it", () => {
    type("a");
    // A keyboard-opened Radix menu: focus sits on a menu item.
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.appendChild(item);
    document.body.appendChild(menu);

    // Esc from inside the overlay passes through (the menu closes) and the
    // stale query is dropped rather than double-consumed.
    expect(press({ key: "Escape" }, item)).toBe(true);
    expect(state()).toBe("idle");
  });

  it("disengages when focus moves into an input (quick-switcher regression)", () => {
    type("a");
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => input.focus());
    expect(state()).toBe("idle");
    // The following Esc belongs entirely to the input's layer.
    expect(press({ key: "Escape" }, input)).toBe(true);
  });

  it("does not engage from an editable target or on reserved keys", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(press({ key: "a" }, input)).toBe(true);
    expect(state()).toBe("idle");

    expect(press({ key: "?" })).toBe(true); // reserved for the shortcuts overlay
    expect(press({ key: " " })).toBe(true);
    expect(state()).toBe("idle");
  });
});
