"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { buildFileRefIndex, type FileRefIndex } from "@/lib/file-ref/file-ref-index";

interface Args {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
}

type FileListResult = { files: string[]; truncated: boolean };

// Backoff schedule (~15s total) for remote projects whose file list isn't ready
// at mount: the remote can answer with an empty list before its worktree is
// checked out. Without retry we'd cache that empty list forever.
const DEFAULT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

// Fetch the file list, retrying past empty/failed results until files arrive or
// the retry budget is exhausted. Returns the last result (possibly empty), or
// null if every attempt threw / the caller cancelled. Pure and injectable so it
// can be unit-tested without React or real timers.
export async function loadFilesWithRetry(
  fetchFiles: () => Promise<FileListResult>,
  opts: {
    delaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    cancelled?: () => boolean;
  } = {},
): Promise<FileListResult | null> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cancelled = opts.cancelled ?? (() => false);

  for (let attempt = 0; ; attempt++) {
    if (cancelled()) return null;
    let res: FileListResult | null = null;
    try {
      res = await fetchFiles();
    } catch {
      res = null;
    }
    if (cancelled()) return null;
    if (res && res.files.length > 0) return res; // got files — done
    if (attempt >= delays.length) return res; // out of retries — return last (empty or null)
    await sleep(delays[attempt]);
  }
}

// Loads the project's flat file list (with retry for not-yet-ready remotes) once
// per project/branch/target and builds a resolution index. Returns null while
// loading or on persistent failure (refs stay plain text and upgrade to links
// when the index arrives).
export function useFileRefIndex({ projectId, branch, target }: Args): FileRefIndex | null {
  const [index, setIndex] = useState<FileRefIndex | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    setIndex(null);
    if (!projectId) return;
    const key = ++keyRef.current;
    loadFilesWithRetry(() => api.listProjectFiles(projectId, branch, target), {
      cancelled: () => key !== keyRef.current,
    }).then((res) => {
      // TEMP DEBUG — remove after diagnosing cross-project file mixing
      console.log("[fileref-mix] load landed", {
        requestedProjectId: projectId,
        branch,
        target,
        key,
        keyRefNow: keyRef.current,
        stale: key !== keyRef.current,
        files: res?.files.length ?? null,
        sample: res?.files.slice(0, 4),
      });
      if (key !== keyRef.current || !res) return;
      setIndex(buildFileRefIndex(res.files));
    });
  }, [projectId, branch, target]);

  return index;
}
