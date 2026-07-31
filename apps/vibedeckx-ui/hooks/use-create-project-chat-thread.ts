"use client";

import { useCallback, useEffect, useRef } from "react";
import { api, type ProjectChatThread } from "@/lib/api";

const PROJECT_CHAT_CREATE_INTENT_PREFIX = "vibedeckx:project-chat:create:v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createIntentPayloadHash(message: string | undefined): string {
  const value = message === undefined ? "\u0000" : `\u0001${message}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function createIntentStorageKey(projectId: string, message: string | undefined): string {
  return `${PROJECT_CHAT_CREATE_INTENT_PREFIX}:${encodeURIComponent(projectId)}:${createIntentPayloadHash(message)}`;
}

function readCreateRequestId(key: string): string | undefined {
  try { return window.sessionStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

function persistCreateRequestId(key: string, value: string): void {
  try { window.sessionStorage.setItem(key, value); } catch { /* in-memory fallback remains */ }
}

function clearCreateRequestId(key: string): void {
  try { window.sessionStorage.removeItem(key); } catch { /* storage may be unavailable */ }
}

export function useCreateProjectChatThread(
  projectId: string | null,
): (message?: string) => Promise<ProjectChatThread> {
  const projectIdRef = useRef(projectId);
  const pendingCreateRequestIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  return useCallback(async (message?: string) => {
    const targetProjectId = projectIdRef.current;
    if (!targetProjectId) throw new Error("No project selected");
    const normalized = message === undefined ? undefined : message.trim();
    if (message !== undefined && !normalized) throw new Error("Message is required");

    const intentKey = createIntentStorageKey(targetProjectId, normalized);
    let createRequestId = pendingCreateRequestIdsRef.current.get(intentKey)
      ?? readCreateRequestId(intentKey);
    if (!createRequestId) {
      createRequestId = crypto.randomUUID();
      pendingCreateRequestIdsRef.current.set(intentKey, createRequestId);
      persistCreateRequestId(intentKey, createRequestId);
    } else {
      pendingCreateRequestIdsRef.current.set(intentKey, createRequestId);
    }

    let created: ProjectChatThread;
    try {
      created = await api.createProjectChatThread(targetProjectId, normalized, createRequestId);
    } catch (reason) {
      // A deterministic payload conflict means this key can never succeed for
      // the current intent. Network/5xx failures retain it so retry is exactly
      // once even when the first response was lost.
      if (isRecord(reason) && reason.status === 409) {
        pendingCreateRequestIdsRef.current.delete(intentKey);
        clearCreateRequestId(intentKey);
      }
      throw reason;
    }

    pendingCreateRequestIdsRef.current.delete(intentKey);
    clearCreateRequestId(intentKey);
    return created;
  }, []);
}
