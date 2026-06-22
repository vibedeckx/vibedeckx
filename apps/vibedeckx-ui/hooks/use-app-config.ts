"use client";

import { useState, useEffect } from "react";
import { api, getPersistedConfig, type AppConfig } from "@/lib/api";

export function useAppConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Read any previously persisted config synchronously so the auth provider
    // can mount on this render without waiting for the /api/config round-trip
    // (which otherwise sits on the critical path before Clerk even starts
    // loading). This is intentionally done in an effect rather than as the
    // useState initializer to keep the first render identical to the
    // statically-exported HTML and avoid a hydration mismatch.
    const persisted = getPersistedConfig();
    if (persisted) {
      setConfig(persisted);
      setLoading(false);
    }

    // Always revalidate against the server in the background.
    api.getConfig()
      .then(setConfig)
      .catch((err) => {
        console.error("Failed to fetch app config:", err);
        // Only fall back to no-auth mode when we had nothing cached; otherwise
        // keep the persisted config rather than flapping the UI on a transient
        // network error.
        if (!persisted) setConfig({ authEnabled: false });
      })
      .finally(() => setLoading(false));
  }, []);

  return { config, loading };
}
