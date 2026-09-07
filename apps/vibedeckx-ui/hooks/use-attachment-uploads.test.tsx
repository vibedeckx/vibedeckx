// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useAttachmentUploads,
  type AttachmentUploader,
  type AttachmentUploads,
  type ComposerAttachment,
} from "./use-attachment-uploads";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pdf: ComposerAttachment = {
  id: "a1",
  filename: "spec.pdf",
  mediaType: "application/pdf",
  url: "data:application/pdf;base64,JVBERi0=",
};
const png: ComposerAttachment = {
  id: "a2",
  filename: "shot.png",
  mediaType: "image/png",
  url: "data:image/png;base64,iVBORw0KGgo=",
};

let container: HTMLDivElement;
let root: Root;
let hook: AttachmentUploads;
let upload: ReturnType<typeof vi.fn> & AttachmentUploader;
let getUploadTarget: ReturnType<typeof vi.fn> & (() => Promise<string | undefined>);

function Harness() {
  hook = useAttachmentUploads({ upload, getUploadTarget });
  return null;
}

beforeEach(async () => {
  upload = vi.fn(async (file, _sessionId, onProgress) => {
    onProgress?.(0.5);
    return { path: `/tmp/att/${file.name}`, name: file.name, size: 5, mediaType: null };
  }) as ReturnType<typeof vi.fn> & AttachmentUploader;
  getUploadTarget = vi.fn(async () => "s-new") as ReturnType<typeof vi.fn> & (() => Promise<string | undefined>);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const track = async (files: ComposerAttachment[]) => {
  await act(async () => { hook.track(files); });
};

/**
 * Attachments are read, classified and uploaded when the user picks them, so
 * sending is usually just the message. The composer only awaits the result.
 */
describe("useAttachmentUploads", () => {
  it("uploads a picked file before anything is submitted", async () => {
    await track([pdf]);

    expect(upload).toHaveBeenCalledWith(
      { name: "spec.pdf", mediaType: "application/pdf", contentBase64: "JVBERi0=" },
      "s-new",
      expect.any(Function),
    );
    expect(hook.statusOf("a1")).toEqual({ phase: "done", progress: 1 });
  });

  it("keeps an image in memory instead of uploading it", async () => {
    await track([png]);

    expect(upload).not.toHaveBeenCalled();
    // No upload means no session had to be prepared for it either.
    expect(getUploadTarget).not.toHaveBeenCalled();
    expect(hook.statusOf("a2")).toEqual({ phase: "inline", progress: 1 });
  });

  it("reports upload progress while the bytes are in flight", async () => {
    let report!: (fraction: number) => void;
    upload.mockImplementationOnce((
      _file: unknown,
      _sessionId?: string,
      onProgress?: (fraction: number) => void
    ) => {
      report = onProgress!;
      return new Promise(() => {}); // never settles: hold the uploading phase
    });
    await track([pdf]);

    await act(async () => { report(0.25); });
    expect(hook.statusOf("a1")).toEqual({ phase: "uploading", progress: 0.25 });
  });

  it("resolves to markers and image parts without re-uploading", async () => {
    await track([png, pdf]);
    let resolved!: Awaited<ReturnType<AttachmentUploads["resolve"]>>;
    await act(async () => { resolved = await hook.resolve([png, pdf]); });

    expect(resolved.images).toEqual([{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(resolved.markers).toEqual(['<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />']);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("processes a file it never saw, so a send that races the pick still works", async () => {
    let resolved!: Awaited<ReturnType<AttachmentUploads["resolve"]>>;
    await act(async () => { resolved = await hook.resolve([pdf]); });

    expect(resolved.markers).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure on the chip and rejects the resolve", async () => {
    upload.mockRejectedValue(new Error("worker too old"));
    await track([pdf]);

    expect(hook.statusOf("a1")).toEqual({ phase: "error", progress: 0, message: "worker too old" });
    await act(async () => {
      await expect(hook.resolve([pdf])).rejects.toThrow(/worker too old/);
    });
  });

  it("retries a failed attachment without touching the others", async () => {
    upload.mockRejectedValueOnce(new Error("network"));
    await track([pdf]);
    expect(hook.statusOf("a1")?.phase).toBe("error");

    await act(async () => { hook.retry(pdf); });
    expect(hook.statusOf("a1")).toEqual({ phase: "done", progress: 1 });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("forgets an attachment the user removed", async () => {
    await track([pdf]);
    await track([]);

    expect(hook.statusOf("a1")).toBeUndefined();
  });

  it("fails an attachment whose bytes cannot be read", async () => {
    await track([{ ...pdf, url: "blob:http://x/1" }]);

    expect(upload).not.toHaveBeenCalled();
    expect(hook.statusOf("a1")?.message).toBe("Could not read spec.pdf");
  });
});
