// @vitest-environment jsdom
//
// The connect-token dialog reads the token over the network, so the response
// can land after the dialog it was opened from is gone. Opening remote A,
// closing it, then opening remote B used to let A's late response paint A's
// connect command under B's name — a copy-paste away from pointing a worker at
// the wrong remote.
//
// This repo has no @testing-library/react; component tests drive
// react-dom/client + act and query with document.querySelector.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteServer } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    getRemoteServers: vi.fn(),
    generateRemoteServerToken: vi.fn(),
    rotateRemoteServerToken: vi.fn(),
    revokeRemoteServerToken: vi.fn(),
    testRemoteServer: vi.fn(),
    updateRemoteServer: vi.fn(),
    createRemoteServer: vi.fn(),
    deleteRemoteServer: vi.fn(),
  },
}));

// Radix's Dialog portals its content and gates interaction on pointer events
// jsdom does not implement. What's under test is the component's own
// request/dialog bookkeeping, so the shell is reduced to plain elements.
vi.mock("@/components/ui/dialog", () => {
  type Kids = { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Kids & { open?: boolean }) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children }: Kids) => <div>{children}</div>,
    DialogHeader: ({ children }: Kids) => <div>{children}</div>,
    DialogTitle: ({ children }: Kids) => <h2>{children}</h2>,
    DialogDescription: ({ children }: Kids) => <p data-testid="dialog-description">{children}</p>,
    DialogFooter: ({ children }: Kids) => <div>{children}</div>,
  };
});

import { RemoteServersSettings } from "./remote-servers-settings";
import { api } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getRemoteServers = api.getRemoteServers as unknown as ReturnType<typeof vi.fn>;
const generateRemoteServerToken = api.generateRemoteServerToken as unknown as ReturnType<typeof vi.fn>;

const makeServer = (id: string, name: string): RemoteServer => ({
  id,
  name,
  status: "offline",
  created_at: "",
  updated_at: "",
  cross_remote_access: "off",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;

const flush = () => act(async () => { await Promise.resolve(); });

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("element not found");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const tokenButtons = () => Array.from(document.querySelectorAll('[title="Connect token"]'));
const dialogDescription = () => document.querySelector('[data-testid="dialog-description"]')?.textContent ?? "";
const commandInput = () => document.querySelector("input.font-mono") as HTMLInputElement | null;
const closeButton = () =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Close");

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("connect token dialog with slow responses", () => {
  it("ignores a response that belongs to a remote the dialog has moved on from", async () => {
    getRemoteServers.mockResolvedValue([makeServer("a", "alpha"), makeServer("b", "bravo")]);
    const first = deferred<{ token: string; connectCommand: string }>();
    const second = deferred<{ token: string; connectCommand: string }>();
    generateRemoteServerToken.mockImplementation((id: string) =>
      id === "a" ? first.promise : second.promise,
    );

    await act(async () => { root.render(<RemoteServersSettings />); });
    await flush();

    // Open alpha (request pending), close it, open bravo.
    await click(tokenButtons()[0]);
    await click(closeButton());
    await click(tokenButtons()[1]);
    expect(dialogDescription()).toContain("bravo");

    // Bravo answers first, so the dialog is showing bravo's command...
    await act(async () => {
      second.resolve({ token: "token-b", connectCommand: "connect --token token-b" });
      await second.promise;
    });
    expect(commandInput()?.value).toBe("connect --token token-b");

    // ...and alpha's late response must not overwrite it.
    await act(async () => {
      first.resolve({ token: "token-a", connectCommand: "connect --token token-a" });
      await first.promise;
    });
    expect(dialogDescription()).toContain("bravo");
    expect(commandInput()?.value).toBe("connect --token token-b");
  });

  it("renders the token for the remote that was actually opened", async () => {
    getRemoteServers.mockResolvedValue([makeServer("a", "alpha"), makeServer("b", "bravo")]);
    generateRemoteServerToken.mockImplementation(async (id: string) => ({
      token: `token-${id}`,
      connectCommand: `connect --token token-${id}`,
    }));

    await act(async () => { root.render(<RemoteServersSettings />); });
    await flush();

    await click(tokenButtons()[0]);
    await flush();
    expect(dialogDescription()).toContain("alpha");
    expect(commandInput()?.value).toBe("connect --token token-a");
  });
});
