// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptInput, PromptInputAttachment, usePromptInputAttachments } from "./prompt-input";

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

const count = () => container.querySelector('[data-testid="count"]')!.textContent;

async function mount(props: Partial<Parameters<typeof PromptInput>[0]> = {}) {
  await act(async () => {
    root.render(
      <PromptInput onSubmit={async () => {}} {...props}>
        <Probe onReady={(api) => { probe = api; }} />
        <textarea name="message" defaultValue="hi" />
      </PromptInput>,
    );
  });
}

async function renderWith(onSubmit: () => Promise<void>) {
  await mount({ onSubmit });
  await act(async () => {
    probe.add([new File(["%PDF"], "spec.pdf", { type: "application/pdf" })]);
  });
  expect(count()).toBe("1");
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

describe("PromptInput maxFileSize at pick time", () => {
  const small = () => new File(["ok"], "small.txt", { type: "text/plain" });
  const big = () => new File([new Uint8Array(200)], "big.bin", { type: "application/octet-stream" });

  it("drops only the oversize files from a mixed pick and reports them by name", async () => {
    const onError = vi.fn();
    await mount({ maxFileSize: 100, onError });
    await act(async () => { probe.add([small(), big()]); });

    expect(count()).toBe("1");
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err.code).toBe("max_file_size");
    expect(err.files.map((f: File) => f.name)).toEqual(["big.bin"]);
    expect(err.message).toContain("big.bin");
  });

  it("adds nothing and reports when every file is oversize", async () => {
    const onError = vi.fn();
    await mount({ maxFileSize: 100, onError });
    await act(async () => { probe.add([big()]); });

    expect(count()).toBe("0");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "max_file_size" }));
  });

  it("does not limit size when maxFileSize is unset", async () => {
    const onError = vi.fn();
    await mount({ onError });
    await act(async () => { probe.add([big()]); });
    expect(count()).toBe("1");
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("PromptInput submit payload", () => {
  it("carries the attachment id so callers can match work started at pick time", async () => {
    const seen: { id?: string; url?: string }[] = [];
    await mount({ onSubmit: async (message) => { seen.push(...message.files); } });
    await act(async () => { probe.add([new File(["%PDF"], "spec.pdf", { type: "application/pdf" })]); });
    await submit();

    expect(seen).toHaveLength(1);
    expect(typeof seen[0].id).toBe("string");
  });

  it("leaves blob URLs alone when the caller already read the bytes", async () => {
    const seen: { url?: string }[] = [];
    await mount({
      skipAttachmentConversion: true,
      onSubmit: async (message) => { seen.push(...message.files); },
    });
    await act(async () => { probe.add([new File(["%PDF"], "spec.pdf", { type: "application/pdf" })]); });
    await submit();

    expect(seen[0].url).toMatch(/^blob:/);
  });
});

describe("PromptInputAttachment status", () => {
  const chip = (status?: Parameters<typeof PromptInputAttachment>[0]["status"]) =>
    act(async () => {
      root.render(
        <PromptInput onSubmit={async () => {}}>
          <PromptInputAttachment
            data={{ id: "a1", type: "file", filename: "spec.pdf", mediaType: "application/pdf", url: "blob:http://x/1" }}
            status={status}
          />
        </PromptInput>,
      );
    });

  it("draws a progress bar sized to the uploaded fraction", async () => {
    await chip({ phase: "uploading", progress: 0.42 });
    const bar = container.querySelector<HTMLElement>('[data-testid="attachment-progress"]');
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe("42%");
  });

  it("shows no progress bar once the upload is done", async () => {
    await chip({ phase: "done", progress: 1 });
    expect(container.querySelector('[data-testid="attachment-progress"]')).toBeNull();
  });

  it("renders nothing extra without a status", async () => {
    await chip();
    expect(container.querySelector('[data-testid="attachment-progress"]')).toBeNull();
  });
});
