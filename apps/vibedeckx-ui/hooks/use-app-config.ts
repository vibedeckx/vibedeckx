"use client";

import { useState, useEffect } from "react";
import { api, type AppConfig } from "@/lib/api";

export function useAppConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getConfig()
      .then(setConfig)
      .catch((err) => {
        console.error("Failed to fetch app config:", err);
        // Default to no-auth mode on error
        setConfig({ authEnabled: false });
      })
      .finally(() => setLoading(false));
  }, []);

  return { config, loading };
}
