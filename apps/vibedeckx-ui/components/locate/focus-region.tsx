"use client";

// Lightweight "which region owns the keyboard" state. There is no real DOM
// focus to lean on — focus usually sits on <body> — so the region follows the
// user's last interaction: pointerdown/focusin inside an element marked
// `data-focus-region` claims it, and an unconsumed Escape releases the right
// panel back to the default region. Type-to-locate (locate-context.tsx) reads
// this to decide which scope typing should target; the right panel's tab
// underline color reflects it.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isEditableTarget } from "@/lib/editable-target";

export type FocusRegion = "default" | "right-panel";

interface FocusRegionContextValue {
  region: FocusRegion;
  setRegion: (region: FocusRegion) => void;
}

const FocusRegionContext = createContext<FocusRegionContextValue>({
  region: "default",
  setRegion: () => {},
});

export function useFocusRegion(): FocusRegionContextValue {
  return useContext(FocusRegionContext);
}

// Portaled overlays (dialogs, menus) are outside every marked region; a null
// here means "leave the region alone" so opening/closing them doesn't churn it.
const resolveRegion = (target: EventTarget | null): FocusRegion | null => {
  const el = target instanceof Element ? target.closest("[data-focus-region]") : null;
  if (!el) return null;
  return el.getAttribute("data-focus-region") === "right-panel" ? "right-panel" : "default";
};

// Radix overlays close on Escape without preventDefault-ing the native event,
// so "was Esc already spent on closing something?" needs a DOM probe.
const hasOpenOverlay = () =>
  document.querySelector(
    '[data-state="open"]:is([role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"])',
  ) !== null;

export function FocusRegionProvider({ children }: { children: ReactNode }) {
  const [region, setRegion] = useState<FocusRegion>("default");

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const next = resolveRegion(event.target);
      if (next) setRegion(next);
    };
    const onFocusIn = (event: FocusEvent) => {
      const next = resolveRegion(event.target);
      if (next) setRegion(next);
    };
    // Escape peels one layer per press: overlays consume it first (checked
    // via defaultPrevented / open-overlay probe); a focused input gets
    // blurred (so Esc in the agent composer steps out of the textarea); only
    // then does an idle Esc release the right panel. Bubble phase, so inner
    // handlers — including the locate controller's capture listener, which
    // stops propagation while a query is active — all get first refusal.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (hasOpenOverlay()) return;
      if (isEditableTarget(event.target)) {
        (event.target as HTMLElement).blur();
        return;
      }
      setRegion("default");
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const value = useMemo(() => ({ region, setRegion }), [region]);
  return <FocusRegionContext.Provider value={value}>{children}</FocusRegionContext.Provider>;
}
