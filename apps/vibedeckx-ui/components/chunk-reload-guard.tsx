"use client";

import { useEffect } from "react";

// The one *hard* failure mode of running a stale tab past a deploy: hashed
// chunk filenames change per build and the server keeps only the latest
// build, so a lazy-loaded route or on-demand module (e.g. a Shiki grammar)
// the old tab never fetched now 404s and its dynamic import rejects. A reload
// fetches the new HTML → new filenames → self-heals. This guard is the last
// resort behind the SSE skew banner and the hidden-tab silent reload — it
// only fires if the user out-raced both.
const RELOAD_GUARD_KEY = "vibedeckx-chunk-reload-at";
// A second failure inside this window means the chunk is missing in the *new*
// build too (broken deploy) — reloading again would loop forever.
const RELOAD_LOOP_WINDOW_MS = 30_000;

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

function reloadOnce(detail: string): void {
  // The loop guard must survive the reload, so it lives in sessionStorage. If
  // the marker cannot be read AND written (storage disabled), skip the
  // automatic reload entirely — a broken build would otherwise reload forever.
  // The user still has the update pill / a manual refresh.
  let lastAt: number;
  try {
    lastAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0;
    if (Date.now() - lastAt >= RELOAD_LOOP_WINDOW_MS) {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    }
  } catch {
    console.error(`[ChunkReloadGuard] no reload-persistent guard available, not reloading: ${detail}`);
    return;
  }
  if (Date.now() - lastAt < RELOAD_LOOP_WINDOW_MS) {
    console.error(`[ChunkReloadGuard] chunk still failing after reload, giving up: ${detail}`);
    return;
  }
  console.warn(`[ChunkReloadGuard] stale chunk detected, reloading: ${detail}`);
  window.location.reload();
}

export function ChunkReloadGuard() {
  useEffect(() => {
    // Dynamic import failures surface as unhandled rejections; <script>/asset
    // load failures for route chunks surface as window "error" events.
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { name?: string; message?: string } | undefined;
      const text = `${reason?.name ?? ""}: ${reason?.message ?? String(event.reason ?? "")}`;
      if (CHUNK_ERROR_RE.test(text)) reloadOnce(text);
    };
    const onError = (event: ErrorEvent) => {
      if (event.message && CHUNK_ERROR_RE.test(event.message)) reloadOnce(event.message);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
  return null;
}
