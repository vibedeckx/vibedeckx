// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiscordButton } from "./discord-button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render(ui: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(ui);
  });
}

describe("DiscordButton", () => {
  it("renders an external invite link when inviteUrl is set", async () => {
    await render(<DiscordButton inviteUrl="https://discord.gg/testinvite" />);
    const link = container!.querySelector('a[aria-label="Join our Discord"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://discord.gg/testinvite");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders nothing when inviteUrl is undefined", async () => {
    await render(<DiscordButton />);
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.textContent).toBe("");
  });
});
