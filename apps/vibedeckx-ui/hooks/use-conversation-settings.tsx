"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  api,
  DEFAULT_CONVERSATION_SETTINGS,
  type ConversationSettings,
} from "@/lib/api";

const SAVE_DEBOUNCE_MS = 500;

interface ConversationSettingsContextValue {
  settings: ConversationSettings;
  loaded: boolean;
  setAgentFontSize: (px: number) => void;
  setChatFontSize: (px: number) => void;
  refresh: () => Promise<void>;
}

const ConversationSettingsContext = createContext<ConversationSettingsContextValue | null>(null);

export function ConversationSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ConversationSettings>(DEFAULT_CONVERSATION_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  // Track the next-to-save value and the timer so debouncing works correctly
  // across rapid setter calls and flushes on unmount.
  const pendingRef = useRef<Partial<ConversationSettings>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getConversationSettings();
      setSettings(next);
    } catch {
      // Keep prior/default settings on failure
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const flush = useCallback(async () => {
    const payload = pendingRef.current;
    pendingRef.current = {};
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (Object.keys(payload).length === 0) return;
    try {
      // Intentionally do not `setSettings(response)` — local state already
      // reflects the desired value; applying the server echo here would race
      // an in-flight save against a later drag and visually rubber-band.
      await api.updateConversationSettings(payload);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save font size");
    }
  }, []);

  const scheduleSave = useCallback(
    (partial: Partial<ConversationSettings>) => {
      pendingRef.current = { ...pendingRef.current, ...partial };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const setAgentFontSize = useCallback(
    (px: number) => {
      setSettings((prev) => ({ ...prev, agentFontSize: px }));
      scheduleSave({ agentFontSize: px });
    },
    [scheduleSave],
  );

  const setChatFontSize = useCallback(
    (px: number) => {
      setSettings((prev) => ({ ...prev, chatFontSize: px }));
      scheduleSave({ chatFontSize: px });
    },
    [scheduleSave],
  );

  // Flush any pending save on unmount so a drag-then-navigate doesn't drop the write.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // Fire-and-forget; best effort.
        const payload = pendingRef.current;
        pendingRef.current = {};
        if (Object.keys(payload).length > 0) {
          api.updateConversationSettings(payload, { keepalive: true }).catch(() => {
            // Swallow — we are unmounting and cannot show toast reliably.
          });
        }
      }
    };
  }, []);

  const value = useMemo(
    () => ({ settings, loaded, setAgentFontSize, setChatFontSize, refresh }),
    [settings, loaded, setAgentFontSize, setChatFontSize, refresh],
  );

  return (
    <ConversationSettingsContext.Provider value={value}>
      {children}
    </ConversationSettingsContext.Provider>
  );
}

export function useConversationSettings(): ConversationSettingsContextValue {
  const ctx = useContext(ConversationSettingsContext);
  if (!ctx) {
    return {
      settings: DEFAULT_CONVERSATION_SETTINGS,
      loaded: false,
      setAgentFontSize: () => {},
      setChatFontSize: () => {},
      refresh: async () => {},
    };
  }
  return ctx;
}
