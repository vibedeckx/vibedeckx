import { useGlobalEventStream } from "@/hooks/global-event-stream";

/**
 * Surface a commander-created agent session into an already-open agent window.
 *
 * The agent panel normally only (re)loads its session on mount / workspace
 * switch / manual history pick. When the Main Chat commander spawns a new agent
 * session on THIS workspace in the background, the panel would otherwise not
 * show it (only the workspace dot lights up). This hook listens to the shared
 * `/api/events` stream and, when a `session:status` event names a session for
 * this workspace that differs from the one currently loaded, calls
 * `onSurface(sessionId)` so the caller can navigate to it.
 *
 * Mode-agnostic: remote `session:status` events already carry the local
 * `remote-{mode}-{project}-{remoteId}` id, which the existing load path
 * resolves the same as a local id — so `event.sessionId` passes through verbatim.
 *
 * No internal refs are needed: `useGlobalEventStream` refreshes its listener
 * ref every render, so this inline closure always reads fresh argument values.
 */
export function useSurfaceCommanderSession(
  projectId: string | null,
  branch: string | null,
  currentSessionId: string | null,
  onSurface: (sessionId: string) => void,
): void {
  useGlobalEventStream((data) => {
    if (data.type !== "session:status") return;
    const evt = data as unknown as {
      type: "session:status";
      projectId: string;
      branch: string | null;
      sessionId: string;
      status: "running" | "stopped" | "error";
    };
    // Only surface newly-active sessions. A `stopped`/`error` event must NOT
    // pull the panel back: clicking "New Conversation" stops the prior session
    // (even when idle) to avoid an orphan process, which emits a `stopped`
    // event for that just-closed id. With the panel already cleared
    // (currentSessionId === null) that id would otherwise pass the dedup guard
    // below and get surfaced right back into the URL — re-loading the session
    // the user just dismissed. Commander spawns always emit `running` first.
    if (evt.status !== "running") return;
    // Only this workspace (normalize null branches before comparing).
    if (!projectId || evt.projectId !== projectId) return;
    if ((evt.branch ?? null) !== (branch ?? null)) return;
    // Dedup / loop-guard: ignore the session already loaded in the panel — its
    // own subsequent running/stopped events carry the same id.
    if (!evt.sessionId || evt.sessionId === currentSessionId) return;
    onSurface(evt.sessionId);
  });
}
