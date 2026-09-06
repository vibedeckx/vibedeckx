// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptInput, usePromptInputAttachments } from "./prompt-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type ProbeApi = { add: (files: File[]) => void };
let probe: ProbeApi;

function Probe({ onReady }: { onReady: (api: ProbeApi) => void }) {
  const attachments = usePromptInputAttachments();
  useEffect(() => { onReady({ add: attachments.add }); }, [attachments.add, onReady]);
  return <span data-testid="count">{attachments.files.length}</span>;
}

beforeEach(() => {
  // jsdom has neither; the component only needs opaque URLs.
  let n = 0;
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: () => `blob:http://x/${++n}`,
    revokeObjectURL: () => {},
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderWith(onSubmit: () => Promise<void>) {
  await act(async () => {
    root.render(
      <PromptInput onSubmit={onSubmit}>
        <Probe onReady={(api) => { probe = api; }} />
        <textarea name="message" defaultValue="hi" />
      </PromptInput>,
    );
  });
  await act(async () => {
    probe.add([new File(["%PDF"], "spec.pdf", { type: "application/pdf" })]);
  });
  expect(container.querySelector('[data-testid="count"]')!.textContent).toBe("1");
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // blob → data URL conversion and the onSubmit promise settle on microtasks
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("PromptInput attachments across submit", () => {
  it("clears attachments when onSubmit resolves", async () => {
    await renderWith(async () => {});
    await submit();
    expect(container.querySelector('[data-testid="count"]')!.textContent).toBe("0");
  });

  it("keeps attachments when onSubmit rejects so the user can retry", async () => {
    // The composer rethrows attachment-upload failures (too large, old
    // worker, network) for exactly this reason.
    await renderWith(async () => { throw new Error("upload failed"); });
    await submit();
    expect(container.querySelector('[data-testid="count"]')!.textContent).toBe("1");
  });
});
