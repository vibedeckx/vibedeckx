// Recovery for JS/CSS chunk load failures — a lazy chunk that 404s after a
// deploy (the server keeps only the latest build), or any chunk that times out
// because the network went away mid-load (e.g. a laptop's maintenance wake
// that sleeps again seconds later).
//
// `installChunkRecovery` is inlined into <head> by app/layout.tsx via
// `toString()`, so it runs before any chunk is requested and keeps working
// even when the chunk holding the React tree never arrives. That makes it
// SELF-CONTAINED by contract: no imports, no closure over module scope, ES2019
// syntax only (no async/await — a transpiler helper would break the string).
//
// Policy:
// - Only chunk errors trigger a reload; ordinary errors never do.
// - A reload happens only while the page is visible AND a same-origin probe
//   (`/build-id.json`, no-store, timeout) succeeds. `navigator.onLine` and the
//   `online` event are treated as hints to probe sooner, never as proof.
// - Reloads are counted in sessionStorage so the cap survives the reload. The
//   count clears only once the app has actually mounted (`appMounted`, called
//   by ClientProviders) and then run HEALTHY_RESET_MS without a chunk error —
//   a timer started at script run would expire while a timed-out chunk request
//   is still hanging, and the cap would never be reached. Past the cap, or
//   without working storage, recovery gives up and the error UI offers a
//   manual reload.
// - One probe at a time; once reload() is called every further trigger is
//   ignored.

export type ChunkRecoveryStatus = "scheduled" | "exhausted" | "unavailable";

export interface ChunkRecoveryApi {
  recover(detail: string): ChunkRecoveryStatus;
  appMounted(): void;
}

// Mirror of the installer's CHUNK_RE, for error boundaries.
export const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading (CSS )?chunk .* failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export const CHUNK_RECOVERY_GLOBAL = "__vibedeckxChunkRecovery";

export function installChunkRecovery(win: Window): void {
  const KEY = "vibedeckx-chunk-recovery";
  const MAX_RELOADS = 3;
  const HEALTHY_RESET_MS = 60000;
  const PROBE_TIMEOUT_MS = 8000;
  const RETRY_BASE_MS = 2000;
  const RETRY_MAX_MS = 60000;
  // Same pattern as CHUNK_ERROR_RE above (a test pins the two together).
  const CHUNK_RE =
    /ChunkLoadError|Loading (CSS )?chunk .* failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

  const doc = win.document;
  let pending = false; // a chunk error was seen on this page
  let probing = false;
  let reloading = false;
  let probeFailures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;

  function readCount(): number | null {
    try {
      return Number(win.sessionStorage.getItem(KEY)) || 0;
    } catch {
      return null;
    }
  }

  function writeCount(n: number): boolean {
    try {
      if (n === 0) win.sessionStorage.removeItem(KEY);
      else win.sessionStorage.setItem(KEY, String(n));
      return true;
    } catch {
      return false;
    }
  }

  function wake() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    attempt();
  }

  function scheduleRetry() {
    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, probeFailures), RETRY_MAX_MS);
    probeFailures++;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      attempt();
    }, delay);
  }

  function attempt() {
    if (probing || reloading) return; // the in-flight probe decides what's next
    if (doc.visibilityState !== "visible") return; // visibilitychange re-enters
    probing = true;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = setTimeout(function () {
      if (controller) controller.abort();
    }, PROBE_TIMEOUT_MS);
    win
      .fetch("/build-id.json?probe=" + Date.now(), {
        cache: "no-store",
        signal: controller ? controller.signal : undefined,
      })
      .then(function (res) {
        clearTimeout(timeout);
        if (!res.ok) throw new Error("probe HTTP " + res.status);
        probing = false;
        // Hidden while the probe was out (tab switch, lid closed): wait for
        // the visibilitychange listener instead of reloading in the dark.
        if (doc.visibilityState !== "visible") return;
        const count = readCount();
        if (count === null || !writeCount(count + 1)) return; // never reload uncounted
        reloading = true;
        win.location.reload();
      })
      .catch(function () {
        clearTimeout(timeout);
        probing = false;
        scheduleRetry();
      });
  }

  function recover(detail: string): "scheduled" | "exhausted" | "unavailable" {
    const count = readCount();
    if (count === null) {
      console.error("[ChunkRecovery] no reload-persistent counter, not reloading: " + detail);
      return "unavailable";
    }
    if (count >= MAX_RELOADS) {
      console.error("[ChunkRecovery] still failing after " + count + " reloads, giving up: " + detail);
      return "exhausted";
    }
    if (!pending) {
      pending = true;
      console.warn("[ChunkRecovery] chunk failed to load, reloading once the site is reachable: " + detail);
      doc.addEventListener("visibilitychange", function () {
        if (doc.visibilityState === "visible") wake();
      });
      win.addEventListener("online", wake);
      attempt();
    }
    return "scheduled";
  }

  function textOf(reason: unknown): string {
    if (reason && typeof reason === "object") {
      const r = reason as { name?: unknown; message?: unknown };
      return String(r.name || "") + ": " + String(r.message || "");
    }
    return String(reason);
  }

  // Dynamic import / chunk-loader rejections nobody caught.
  win.addEventListener("unhandledrejection", function (event) {
    const text = textOf(event.reason);
    if (CHUNK_RE.test(text)) recover(text);
  });
  // Uncaught chunk errors, plus <script>/<link> load failures for build
  // assets — those don't bubble, so listen in the capture phase.
  win.addEventListener(
    "error",
    function (event) {
      const target = event.target as { tagName?: string; src?: string; href?: string; rel?: string } | null;
      if (target && (target.tagName === "SCRIPT" || (target.tagName === "LINK" && target.rel === "stylesheet"))) {
        const url = target.src || target.href || "";
        if (url.indexOf("/_next/static/") !== -1) recover("failed to load " + url);
        return;
      }
      const message = (event as ErrorEvent).message;
      if (message && CHUNK_RE.test(message)) recover(message);
    },
    true,
  );

  function appMounted() {
    if (healthTimer !== null) return;
    healthTimer = setTimeout(function () {
      if (!pending) writeCount(0);
    }, HEALTHY_RESET_MS);
  }

  // Literal, not CHUNK_RECOVERY_GLOBAL: this body must not close over module scope.
  (win as unknown as Record<string, ChunkRecoveryApi>)["__vibedeckxChunkRecovery"] = {
    recover: recover,
    appMounted: appMounted,
  };
}

export const CHUNK_RECOVERY_SCRIPT = `(${installChunkRecovery.toString()})(window);`;

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === "ChunkLoadError" || CHUNK_ERROR_RE.test(String(message ?? ""));
}

// The React tree mounted, i.e. every boot chunk arrived; starts the
// healthy-run timer that clears the reload count.
export function markAppMounted(): void {
  if (typeof window === "undefined") return;
  const api = (window as unknown as Record<string, ChunkRecoveryApi | undefined>)[CHUNK_RECOVERY_GLOBAL];
  if (api) api.appMounted();
}

// Hand a caught chunk error (from an error boundary) to the head script.
export function requestChunkRecovery(detail: string): ChunkRecoveryStatus {
  if (typeof window === "undefined") return "unavailable";
  const api = (window as unknown as Record<string, ChunkRecoveryApi | undefined>)[CHUNK_RECOVERY_GLOBAL];
  return api ? api.recover(detail) : "unavailable";
}
