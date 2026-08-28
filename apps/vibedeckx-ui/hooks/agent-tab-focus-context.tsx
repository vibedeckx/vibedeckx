"use client";

import { createContext, useContext } from "react";

export interface AgentTabFocusState {
  // True when the Agent tab is the one on screen (and the workspace view itself
  // is visible). The agent panel stays mounted behind the other tabs — hidden
  // with visibility:hidden so its scroll position survives — which also means
  // the browser blurs the composer on every tab switch away. This flag is what
  // tells the composer to take focus back when the tab returns, mirroring the
  // terminal's `active` prop (components/terminal/terminal-panel.tsx).
  active: boolean;
  // Bumped every time the user *asks* for the Agent tab (⌃⇧A / Ctrl+Alt+A, or
  // a click on the tab button). `active` alone is edge-triggered, so it says
  // nothing when the tab is already open — pressing the shortcut from the
  // sidebar, or after clicking into the transcript, would never hand the
  // composer back. The nonce makes that request observable.
  requestNonce: number;
}

// Defaults to inactive so a conversation rendered outside the workspace panel
// never grabs focus on mount.
const AgentTabFocusContext = createContext<AgentTabFocusState>({ active: false, requestNonce: 0 });

export const AgentTabFocusProvider = AgentTabFocusContext.Provider;

export function useAgentTabFocus(): AgentTabFocusState {
  return useContext(AgentTabFocusContext);
}
