// @vitest-environment jsdom
//
// The composer's cross-remote chips (docs/cross-remote-session-grants-design.md
// §0.1): a declaration about the NEXT turn, held entirely on the client. What
// you see is what that turn gets — so these cases are about the declaration
// surviving, moving and being asserted exactly as shown.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SessionRemoteGrant } from "@/lib/api";
import { useSessionRemoteGrants, type SessionRemoteGrantsState } from "./use-session-remote-grants";

const ubuntu: SessionRemoteGrant = { id: "srv-a", name: "ubuntu-1", access: "exec", online: true };
const mac: SessionRemoteGrant = { id: "srv-b", name: "mac-mini", access: "read", online: false };
const WS = "p1::main";

describe("useSessionRemoteGrants", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: SessionRemoteGrantsState;

  // One component identity: a conversation switch is a prop change, not a
  // remount, and remounting would hide anything the hook carries across it.
  function Probe({ id, ws, on }: { id: string | null; ws: string; on?: boolean }) {
    latest = useSessionRemoteGrants(id, ws, on);
    return null;
  }

  const render = async (sessionId: string | null, ws = WS, enabled = true) => {
    await act(async () => { root.render(<Probe id={sessionId} ws={ws} on={enabled} />); });
  };

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it("asserts exactly what is on screen, empty included", async () => {
    await render(null);
    expect(latest.selectedIds).toEqual([]);

    await act(async () => { latest.toggle(ubuntu, true); });
    expect(latest.granted).toEqual([ubuntu]);
    expect(latest.selectedIds).toEqual(["srv-a"]);

    await act(async () => { latest.toggle(ubuntu, false); });
    // Not silence: the next turn gets nothing, and says so.
    expect(latest.selectedIds).toEqual([]);
  });

  it("survives a reload, because the declaration is the client's own state", async () => {
    await render(null);
    await act(async () => { latest.toggle(ubuntu, true); });

    // A reload: fresh component, fresh hook, same storage.
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render(null);
    expect(latest.granted).toEqual([ubuntu]);
  });

  it("keeps a revocation across a reload, rather than letting it come back", async () => {
    await render("s1");
    await act(async () => { latest.toggle(ubuntu, true); });
    await act(async () => { latest.toggle(ubuntu, false); });

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render("s1");
    expect(latest.granted).toEqual([]);
  });

  it("hands the pre-session declaration to the conversation it created", async () => {
    // Otherwise the chips would clear on the first message and the SECOND
    // message would assert an empty list, revoking what the first granted.
    await render(null);
    await act(async () => { latest.toggle(ubuntu, true); });

    await act(async () => { latest.adoptInto("s1"); });
    await render("s1");
    expect(latest.granted).toEqual([ubuntu]);
    expect(latest.selectedIds).toEqual(["srv-a"]);

    // And the workspace slot is free again for the next new conversation.
    await render(null);
    expect(latest.granted).toEqual([]);
  });

  it("keeps the chips on screen through the hand-off", async () => {
    // The first send adopts before the new id renders; no render in between
    // may show the chips empty (the composer visibly jumps if one does).
    const seen: SessionRemoteGrantsState[] = [];
    function Watch({ id }: { id: string | null }) {
      seen.push(useSessionRemoteGrants(id, WS));
      return null;
    }
    await act(async () => { root.render(<Watch id={null} />); });
    await act(async () => { seen.at(-1)!.toggle(ubuntu, true); });

    const from = seen.length;
    await act(async () => {
      seen.at(-1)!.adoptInto("s1");
      root.render(<Watch id="s1" />);
    });
    expect(seen.at(-1)!.granted).toEqual([ubuntu]);
    expect(seen.slice(from).map((s) => s.granted.length)).not.toContain(0);
  });

  it("recovers the chips when the hand-off comes after the new id rendered", async () => {
    // Too late to prevent the blink, but the chips must come back: an empty
    // composer would make the second message revoke what the first granted.
    await render(null);
    await act(async () => { latest.toggle(ubuntu, true); });

    await render("s1");
    expect(latest.granted).toEqual([]);
    await act(async () => { latest.adoptInto("s1"); });
    expect(latest.granted).toEqual([ubuntu]);
    expect(latest.selectedIds).toEqual(["srv-a"]);
  });

  it("does not paint a late hand-off over a workspace the user moved to", async () => {
    await render(null, "p1::main");
    await act(async () => { latest.toggle(ubuntu, true); });
    const adoptFromMain = latest.adoptInto;

    await render(null, "p1::feature");
    await act(async () => { adoptFromMain("s1"); });
    expect(latest.granted).toEqual([]);

    // The declaration still reached the conversation it was made for.
    await render("s1", "p1::main");
    expect(latest.granted).toEqual([ubuntu]);
  });

  it("does not let an old conversation walk off with the draft's declaration", async () => {
    // Opening an existing conversation in the same workspace is not the same
    // as creating one from this draft: the declaration must stay where it was.
    await render(null);
    await act(async () => { latest.toggle(ubuntu, true); });

    await render("s-old");
    expect(latest.granted).toEqual([]);

    await render(null);
    expect(latest.granted).toEqual([ubuntu]);
  });

  it("gives each conversation its own declaration", async () => {
    await render("s1");
    await act(async () => { latest.toggle(ubuntu, true); });

    await render("s2");
    expect(latest.granted).toEqual([]);
    await act(async () => { latest.toggle(mac, true); });

    await render("s1");
    expect(latest.granted).toEqual([ubuntu]);
  });

  it("keeps workspaces apart before any conversation exists", async () => {
    await render(null, "p1::main");
    await act(async () => { latest.toggle(ubuntu, true); });

    await render(null, "p1::feature");
    expect(latest.granted).toEqual([]);
  });

  it("says nothing at all when the server does not offer the feature", async () => {
    await render("s1", WS, false);
    await act(async () => { latest.toggle(ubuntu, true); });

    expect(latest.granted).toEqual([]);
    // Undefined, not []: the field is omitted and the grant table untouched.
    expect(latest.selectedIds).toBeUndefined();
  });
});
