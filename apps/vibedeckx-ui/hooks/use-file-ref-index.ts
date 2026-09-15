"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useGlobalEventStream } from "@/hooks/global-event-stream";
import { buildFileRefIndex, type FileRefIndex } from "@/lib/file-ref/file-ref-index";

interface Args {
  projectId: string | null;
  branch?: string | null;
  target?: "local" | "remote";
  // Only load when the workspace view is actually active. The panel is kept
  // mounted (hidden via CSS) on other views like project-info, so without this
  // gate it would fetch the default checkout's file list the moment a project is
  // opened — wasted work, since there's no agent conversation to resolve against
  // until a workspace is shown. Defaults to enabled.
  enabled?: boolean;
}

type FileListResult = { files: string[]; truncated: boolean; root?: string };

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

// Several sessions on one branch can end within the same second (a commander
// and its spawned reviewers); one list-files per burst is plenty.
const REFRESH_DEBOUNCE_MS = 250;

// Loads the project's flat file list (with retry for not-yet-ready remotes) once
// per project/branch/target and builds a resolution index. Returns null only
// while loading (refs stay plain text and upgrade to links when the index
// arrives). Persistent failure yields an EMPTY index rather than null: no repo
// ref will resolve either way, but a non-null index is what lets FileRefLink
// keep linking paths outside the repo (`/tmp/shot.png`), which are read by
// path and never needed the list in the first place.
//
// The list is a snapshot, so it is re-pulled when the working tree is known to
// have changed: an agent on this branch finished a turn (the files it just
// created become linkable in the reply that mentions them), or the Files tab
// wrote to this checkout. A refresh keeps the current index in place until the
// new one lands — nulling it would flash every link back to plain text — and a
// failed refresh simply leaves the old index standing. Resolution happens at
// render time from context, so swapping the index restyles anchors in place
// without remounting the markdown tree.
export function useFileRefIndex({
  projectId,
  branch,
  target,
  enabled = true,
}: Args): FileRefIndex | null {
  const [index, setIndex] = useState<FileRefIndex | null>(null);
  const keyRef = useRef(0);
  const refreshSeqRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setIndex(null);
    // Skip until the workspace view is active (see `enabled`). `branch` may be
    // null here — that's the default checkout (main), which we DO want to load —
    // so gate on `enabled`, not on branch presence.
    if (!enabled || !projectId) return;
    const key = ++keyRef.current;
    loadFilesWithRetry(() => api.listProjectFiles(projectId, branch, target), {
      cancelled: () => key !== keyRef.current,
    }).then((res) => {
      if (key !== keyRef.current) return;
      setIndex(res ? buildFileRefIndex(res.files, res.root) : buildFileRefIndex([]));
    });
    return () => {
      // A scope change abandons any refresh queued for the old scope.
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [projectId, branch, target, enabled]);

  useGlobalEventStream((evt) => {
    if (!enabled || !projectId) return;
    const turnEnded = evt.type === "session:taskCompleted" || evt.type === "session:finished";
    const treeWritten = evt.type === "files:changed";
    if (!turnEnded && !treeWritten) return;
    if (evt.projectId !== projectId) return;
    // Both event kinds carry the workspace branch (null = root checkout); a
    // turn on another branch touched another working tree.
    if ((evt.branch ?? null) !== (branch ?? null)) return;

    if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    const key = keyRef.current;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      const seq = ++refreshSeqRef.current;
      // Single attempt: the retry ladder exists for a remote whose worktree is
      // not checked out yet; a tree that just changed is by definition there.
      api
        .listProjectFiles(projectId, branch, target)
        .then((res) => {
          if (key !== keyRef.current || seq !== refreshSeqRef.current) return;
          setIndex(buildFileRefIndex(res.files, res.root));
        })
        .catch(() => {
          /* keep the current index */
        });
    }, REFRESH_DEBOUNCE_MS);
  });

  return index;
}
