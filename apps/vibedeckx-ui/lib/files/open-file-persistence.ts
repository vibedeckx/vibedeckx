// Persists the Files panel's open state (selected file + back/forward history +
// scroll position) per project/branch/target, so switching projects or
// refreshing the page restores where the user left off. The whole feature's
// localStorage access lives here; everything is wrapped so a disabled/full/
// corrupt store degrades to "no restore" rather than throwing.

const STORAGE_KEY = "vibedeckx:files:views";
const SCHEMA_VERSION = 1;
const MAX_VIEWS = 30;
const KEY_SEP = "|";

export interface PersistedHistory {
  entries: { path: string; line: number | null }[];
  index: number;
}

export interface PersistedFileView {
  selectedFile: string | null;
  history: PersistedHistory;
  scrollTop: number;
}

interface StoredRecord extends PersistedFileView {
  updatedAt: number;
}

interface StoredBlob {
  v: number;
  views: Record<string, StoredRecord>;
}

// Identifies one persisted view. Mirrors the file-content cache key in
// use-file-browser.ts, minus the file path.
export function makeKey(
  projectId: string,
  branch: string | null | undefined,
  target: "local" | "remote" | undefined
): string {
  return [projectId, branch ?? "", target ?? ""].join(KEY_SEP);
}

function emptyBlob(): StoredBlob {
  return { v: SCHEMA_VERSION, views: {} };
}

function readBlob(): StoredBlob {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyBlob();
    const parsed = JSON.parse(raw) as StoredBlob;
    if (!parsed || parsed.v !== SCHEMA_VERSION || !parsed.views || typeof parsed.views !== "object") {
      return emptyBlob();
    }
    return parsed;
  } catch {
    return emptyBlob();
  }
}

function writeBlob(blob: StoredBlob): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Quota exceeded or storage disabled — drop the write silently.
  }
}

export function loadView(key: string): PersistedFileView | null {
  const rec = readBlob().views[key];
  if (!rec) return null;
  return {
    selectedFile: rec.selectedFile,
    history: rec.history,
    scrollTop: rec.scrollTop,
  };
}

export function saveView(key: string, view: PersistedFileView): void {
  const blob = readBlob();
  blob.views[key] = { ...view, updatedAt: Date.now() };
  // Evict the oldest entries once past the cap.
  const keys = Object.keys(blob.views);
  if (keys.length > MAX_VIEWS) {
    keys
      .sort((a, b) => blob.views[a].updatedAt - blob.views[b].updatedAt)
      .slice(0, keys.length - MAX_VIEWS)
      .forEach((k) => delete blob.views[k]);
  }
  writeBlob(blob);
}

export function clearView(key: string): void {
  const blob = readBlob();
  if (blob.views[key]) {
    delete blob.views[key];
    writeBlob(blob);
  }
}
