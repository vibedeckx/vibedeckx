"use client";

import { createContext, useContext } from "react";

// True when the Agent tab is the one on screen (and the workspace view itself
// is visible). The agent panel stays mounted behind the other tabs — hidden
// with visibility:hidden so its scroll position survives — which also means the
// browser blurs the composer on every tab switch away. This flag is what tells
// the composer to take focus back when the tab returns, mirroring the terminal's
// `active` prop (components/terminal/terminal-panel.tsx).
//
// Defaults to false so a conversation rendered outside the workspace panel never
// grabs focus on mount.
const AgentTabActiveContext = createContext(false);

export const AgentTabActiveProvider = AgentTabActiveContext.Provider;

export function useAgentTabActive(): boolean {
  return useContext(AgentTabActiveContext);
}
