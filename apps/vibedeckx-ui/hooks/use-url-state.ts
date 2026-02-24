"use client";

import { useState, useEffect } from "react";
import { parseUrlState, type UrlState } from "@/lib/url-state";

/**
 * Hook that reads app state from the URL path.
 * Listens to popstate so browser back/forward updates state.
 */
export function useUrlState(): UrlState {
  const [state, setState] = useState<UrlState>(parseUrlState);

  useEffect(() => {
    const onPopState = () => setState(parseUrlState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return state;
}
