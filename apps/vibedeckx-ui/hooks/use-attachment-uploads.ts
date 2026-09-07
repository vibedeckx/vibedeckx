import { useCallback, useMemo, useRef, useState } from "react";
import { vfileMarker } from "@/components/agent/vpaste-chip";
import { base64FromDataUrl, readBlobUrlAsDataUrl } from "@/lib/attachment-io";
import {
  base64ByteLength,
  MAX_INLINE_IMAGE_BYTES,
  sniffInlineImageType,
  type InlineImageType,
} from "@/lib/image-sniff";
import type { AttachmentUploadInput, UploadedAttachment } from "./use-agent-session";

/** The subset of a `PromptInput` attachment this hook needs. */
export interface ComposerAttachment {
  id?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
}

/**
 * What an attachment turns into once its bytes are known: either an inline
 * image content part, or a file on the agent's machine referenced by marker.
 */
export type ResolvedAttachment =
  | { kind: "image"; mediaType: InlineImageType; data: string }
  | { kind: "file"; marker: string };

export type AttachmentUploadPhase = "reading" | "inline" | "uploading" | "done" | "error";

export interface AttachmentUploadStatus {
  phase: AttachmentUploadPhase;
  /** 0..1, only meaningful while uploading. */
  progress: number;
  /** Failure text, only set in the `error` phase. */
  message?: string;
}

export type AttachmentUploader = (
  file: AttachmentUploadInput,
  sessionId?: string,
  onProgress?: (fraction: number) => void
) => Promise<UploadedAttachment>;

interface UseAttachmentUploadsOptions {
  upload: AttachmentUploader;
  /**
   * Session the temp file should land next to. On a placeholder conversation
   * this prepares an identity, so it is only ever called for a file that
   * really needs uploading — never for an inline image.
   */
  getUploadTarget: () => Promise<string | undefined>;
}

interface AttachmentRecord {
  name: string;
  promise: Promise<ResolvedAttachment>;
}

/**
 * Drives composer attachments through read → classify → upload **as soon as
 * they are picked**, instead of when the message is sent. By the time the user
 * finishes typing, a file is usually already on the agent's machine and the
 * send is just the message.
 *
 * Classification is made on the bytes, not on `File.type` (browsers derive
 * that from the extension alone): only JPEG / PNG / GIF / WebP content under
 * the API's per-image limit is inlined, with the media type the bytes actually
 * are. Everything else — SVG, HEIC, oversize images, non-images, unreadable
 * blobs — is uploaded and referenced by a `<vfile/>` marker.
 *
 * Attachments removed mid-flight are simply forgotten; their temp file is left
 * to the server's sweeper rather than chased with a delete.
 */
export function useAttachmentUploads(options: UseAttachmentUploadsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const recordsRef = useRef(new Map<string, AttachmentRecord>());
  /**
   * Ids whose finished work must survive their absence from the attachment
   * list — a submission takes the chips out of the composer the moment it has
   * their content, and has to be able to put the very same (already uploaded)
   * attachments back if the send fails.
   */
  const retainedRef = useRef(new Set<string>());
  const [statuses, setStatuses] = useState<Map<string, AttachmentUploadStatus>>(new Map());

  const setStatus = useCallback((id: string, status: AttachmentUploadStatus) => {
    setStatuses((prev) => {
      const current = prev.get(id);
      if (current && current.phase === status.phase && current.progress === status.progress
        && current.message === status.message) {
        return prev;
      }
      const next = new Map(prev);
      next.set(id, status);
      return next;
    });
  }, []);

  /**
   * Read the bytes, decide inline vs file, and upload when it is a file.
   * `onStatus` is omitted for attachments this hook never saw (a send that
   * raced the pick), which still need the same pipeline just without a chip to
   * report into.
   */
  const process = useCallback(async (
    file: ComposerAttachment,
    onStatus?: (status: AttachmentUploadStatus) => void
  ): Promise<ResolvedAttachment> => {
    const name = file.filename || "attachment";
    onStatus?.({ phase: "reading", progress: 0 });

    const dataUrl = await readBlobUrlAsDataUrl(file.url);
    const base64 = base64FromDataUrl(dataUrl ?? undefined);
    if (!base64) {
      throw new Error(`Could not read ${name}`);
    }

    const sniffed = sniffInlineImageType(base64);
    if (sniffed && base64ByteLength(base64) <= MAX_INLINE_IMAGE_BYTES) {
      onStatus?.({ phase: "inline", progress: 1 });
      return { kind: "image", mediaType: sniffed, data: base64 };
    }

    onStatus?.({ phase: "uploading", progress: 0 });
    const sessionId = await optionsRef.current.getUploadTarget();
    const uploaded = await optionsRef.current.upload(
      { name, mediaType: file.mediaType || undefined, contentBase64: base64 },
      sessionId,
      (progress) => onStatus?.({ phase: "uploading", progress })
    );
    onStatus?.({ phase: "done", progress: 1 });
    return { kind: "file", marker: vfileMarker(uploaded) };
  }, []);

  const start = useCallback((file: ComposerAttachment, id: string) => {
    const promise = process(file, (status) => setStatus(id, status));
    // Mark handled so a removed-before-send failure is not an unhandled
    // rejection; `resolve` still sees the rejection when it awaits.
    promise.catch((e: unknown) => {
      setStatus(id, {
        phase: "error",
        progress: 0,
        message: e instanceof Error ? e.message : "Upload failed",
      });
    });
    recordsRef.current.set(id, { name: file.filename || "attachment", promise });
  }, [process, setStatus]);

  /** Reconcile against the composer's current attachment list. */
  const track = useCallback((files: ComposerAttachment[]) => {
    const present = new Set<string>();
    for (const file of files) {
      if (!file.id) continue;
      present.add(file.id);
      if (!recordsRef.current.has(file.id)) start(file, file.id);
    }
    const keep = (id: string) => present.has(id) || retainedRef.current.has(id);
    for (const id of Array.from(recordsRef.current.keys())) {
      if (!keep(id)) recordsRef.current.delete(id);
    }
    setStatuses((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map<string, AttachmentUploadStatus>();
      for (const [id, status] of prev) if (keep(id)) next.set(id, status);
      return next.size === prev.size ? prev : next;
    });
  }, [start]);

  /** Hold these records while their attachments are out of the list. */
  const retain = useCallback((ids: string[]) => {
    for (const id of ids) retainedRef.current.add(id);
  }, []);

  /**
   * Stop holding them. `drop` also forgets the work itself — for a send that
   * succeeded, where nothing will ask for those bytes or markers again.
   */
  const release = useCallback((ids: string[], drop: boolean) => {
    for (const id of ids) {
      retainedRef.current.delete(id);
      if (drop) recordsRef.current.delete(id);
    }
    if (!drop) return;
    setStatuses((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
  }, []);

  const retry = useCallback((file: ComposerAttachment) => {
    if (!file.id) return;
    recordsRef.current.delete(file.id);
    start(file, file.id);
  }, [start]);

  const statusOf = useCallback(
    (id: string | undefined): AttachmentUploadStatus | undefined => (id ? statuses.get(id) : undefined),
    [statuses]
  );

  /**
   * Await every attachment in submission order. Throws on the first failure so
   * the composer can keep the draft (and the files) for a retry.
   */
  const resolve = useCallback(async (files: ComposerAttachment[]): Promise<{
    images: { mediaType: InlineImageType; data: string }[];
    markers: string[];
  }> => {
    const images: { mediaType: InlineImageType; data: string }[] = [];
    const markers: string[] = [];
    for (const file of files) {
      const record = file.id ? recordsRef.current.get(file.id) : undefined;
      const resolved = record ? await record.promise : await process(file);
      if (resolved.kind === "image") images.push({ mediaType: resolved.mediaType, data: resolved.data });
      else markers.push(resolved.marker);
    }
    return { images, markers };
  }, [process]);

  /**
   * True while any attachment is still being read or uploaded. The composer
   * blocks sending on it: a send would otherwise clear the draft and then sit
   * waiting on the upload, which reads as a message that vanished.
   */
  const pending = useMemo(
    () => Array.from(statuses.values()).some((s) => s.phase === "reading" || s.phase === "uploading"),
    [statuses]
  );

  return { track, retry, retain, release, statusOf, resolve, pending };
}

export type AttachmentUploads = ReturnType<typeof useAttachmentUploads>;
