"use client";

import { useState, useEffect } from "react";
import { parseUrlState, type UrlState } from "@/lib/url-state";
import { restoreLastLocation } from "@/lib/last-location";

/**
 * Hook that reads app state from the URL path.
 * Listens to popstate so browser back/forward updates state.
 * A fresh load of the bare root first restores the last remembered location.
 */
export function useUrlState(): UrlState {
  const [state, setState] = useState<UrlState>(() => {
    restoreLastLocation();
    return parseUrlState();
  });

  useEffect(() => {
    const onPopState = () => setState(parseUrlState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return state;
}
