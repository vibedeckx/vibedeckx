"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionRemoteGrant } from "@/lib/api";
import {
  adoptDeclaration, declarationKey, readDeclaration, writeDeclaration,
} from "@/lib/remote-grant-declarations";

export interface SessionRemoteGrantsState {
  /** Machines the next turn of this conversation may reach. */
  granted: SessionRemoteGrant[];
  /**
   * What to assert with the next message. What you see is what that turn
   * gets — an empty list is a real answer, not silence. Undefined only when
   * the server does not offer the feature at all, so the field is omitted and
   * the grant table is left alone.
   */
  selectedIds: string[] | undefined;
  toggle: (server: SessionRemoteGrant, granted: boolean) => void;
  /**
   * Hand this composer's declaration to the conversation it just created.
   *
   * Called by the sender, never inferred from a session id appearing: opening
   * an OLD conversation in the same workspace would otherwise walk off with
   * the declaration meant for the new one being composed.
   */
  adoptInto: (sessionId: string) => void;
}

/**
 * The composer's cross-remote chips
 * (docs/cross-remote-session-grants-design.md §8, §0.1).
 *
 * A declaration about the NEXT turn, held entirely on the client. Nothing is
 * read from or written to the server here: the selection rides with the
 * message that asserts it, and what a turn actually ran under is visible on
 * that message's own `<vremotes>` chip in the transcript.
 *
 * So a turn already running is unaffected by unticking a chip — that only
 * says how the turn after it should run. And a conversation opened on another
 * machine starts with no declaration, which means its next turn gets nothing
 * until that user says otherwise: what they see is what they get.
 */
export function useSessionRemoteGrants(
  sessionId: string | null,
  /** Identifies the composer before a conversation exists. */
  workspaceKey: string,
  /** False on a server that cannot mint a gateway token: the chips do nothing. */
  enabled = true,
): SessionRemoteGrantsState {
  const [granted, setGranted] = useState<SessionRemoteGrant[]>([]);

  useEffect(() => {
    if (!enabled) {
      setGranted([]);
      return;
    }
    setGranted(readDeclaration(declarationKey(sessionId, workspaceKey)));
  }, [sessionId, workspaceKey, enabled]);

  const toggle = useCallback((server: SessionRemoteGrant, grant: boolean) => {
    if (!enabled) return;
    setGranted((current) => {
      const next = grant
        ? (current.some((g) => g.id === server.id) ? current : [...current, server])
        : current.filter((g) => g.id !== server.id);
      writeDeclaration(declarationKey(sessionId, workspaceKey), next);
      return next;
    });
  }, [sessionId, workspaceKey, enabled]);

  const adoptInto = useCallback((createdSessionId: string) => {
    if (!enabled) return;
    adoptDeclaration(workspaceKey, createdSessionId);
    // The effect re-reads on the id change too; setting it here means the
    // chips never blink through empty while that lands.
    setGranted(readDeclaration(declarationKey(createdSessionId, workspaceKey)));
  }, [workspaceKey, enabled]);

  return { granted, selectedIds: enabled ? granted.map((g) => g.id) : undefined, toggle, adoptInto };
}
