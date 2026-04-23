"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from "@/lib/api";

interface TerminalSettingsContextValue {
  settings: TerminalSettings;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const TerminalSettingsContext = createContext<TerminalSettingsContextValue | null>(null);

export function TerminalSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getTerminalSettings();
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

  const value = useMemo(() => ({ settings, loaded, refresh }), [settings, loaded, refresh]);

  return <TerminalSettingsContext.Provider value={value}>{children}</TerminalSettingsContext.Provider>;
}

export function useTerminalSettings(): TerminalSettingsContextValue {
  const ctx = useContext(TerminalSettingsContext);
  if (!ctx) {
    return { settings: DEFAULT_TERMINAL_SETTINGS, loaded: false, refresh: async () => {} };
  }
  return ctx;
}
