"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ChatStream,
  EMPTY_CHAT_STREAM_STATE,
  chatWorkspaceKey,
  type ChatStreamState,
} from "./chat-stream";

export type { AgentMessage, AgentSessionStatus, ChatSession } from "./chat-stream";

const noopSubscribe = () => () => {};
const getEmptyState = () => EMPTY_CHAT_STREAM_STATE;
const noopAction = async () => {};
const noopSetDraft = () => {};

/**
 * Main Chat for one workspace.
 *
 * Thin React binding over `ChatStream`: the stream is the external store
 * (`useSyncExternalStore`), the one Effect here is start/stop on mount and
 * unmount. Switching workspace is handled by identity, not by Effects that
 * reset state — the caller keys the component on `projectId:branch` (see
 * react.dev "Resetting all state when a prop changes"), and as belt-and-braces
 * the hook swaps in a fresh stream during render if the props change anyway.
 *
 * Revisiting a workspace paints its last transcript on the first render (the
 * stream is constructed from a module-level snapshot) while the replay runs.
 */
export function useChatSession(projectId: string | null, branch: string | null) {
  const key = projectId ? chatWorkspaceKey(projectId, branch) : null;
  const [stream, setStream] = useState<ChatStream | null>(() =>
    projectId ? new ChatStream(projectId, branch) : null,
  );
  if ((stream?.key ?? null) !== key) {
    // "Adjusting some state when a prop changes": React re-renders immediately
    // with the replacement; the mismatched stream never starts.
    setStream(projectId ? new ChatStream(projectId, branch) : null);
  }

  useEffect(() => {
    if (!stream) return;
    stream.start();
    return () => stream.stop();
  }, [stream]);

  const state: ChatStreamState = useSyncExternalStore(
    stream?.subscribe ?? noopSubscribe,
    stream?.getSnapshot ?? getEmptyState,
    stream?.getSnapshot ?? getEmptyState,
  );

  return {
    ...state,
    sendMessage: stream?.sendMessage ?? noopAction,
    stopGeneration: stream?.stopGeneration ?? noopAction,
    restartSession: stream?.restartSession ?? noopAction,
    setDraft: stream?.setDraft ?? noopSetDraft,
    setEventListening: stream?.setEventListening ?? noopAction,
  };
}
