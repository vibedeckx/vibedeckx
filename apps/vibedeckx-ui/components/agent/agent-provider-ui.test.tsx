// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMenu } from "./branch-menu";

vi.mock("@/components/ui/dropdown-menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass, DropdownMenuContent: Pass, DropdownMenuLabel: Pass,
    DropdownMenuTrigger: Pass, DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, onSelect }: { children?: ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
  };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(node); });
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("provider-driven controls", () => {
  it.each([["third", "Third Agent"], ["fx", "fx"]])("renders and branches to %s with a neutral avatar", async (type, displayName) => {
    const onBranch = vi.fn();
    await render(<BranchMenu agentType="codex" currentAgentName="Codex" alternateProviders={[{ type, displayName }]} onBranch={onBranch} />);
    const option = [...container!.querySelectorAll("button")].find((b) => b.textContent === displayName)!;
    expect(option.querySelector(".bg-muted.text-muted-foreground")).not.toBeNull();
    await act(async () => { option.click(); });
    expect(onBranch).toHaveBeenCalledWith(type);
  });
});
