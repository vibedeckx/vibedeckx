"use client";

// Type-to-locate: with no input focused, typing engages an inline typeahead
// over the active scope's list (VS Code tree find / IntelliJ speed search
// style). Matches highlight in place in the owning list — there is no result
// palette; the list itself is the result. ↑↓ cycles matches in list order,
// Enter commits, Space fires the scope's secondary commit when it defines
// one (queries are whitespace-insensitive, so Space is free to repurpose),
// Esc/Backspace-to-empty/click disengage, Tab cycles to the next registered
// scope. Deliberately NO idle timeout: the chip makes the
// mode visible and every exit is explicit (Esc, click, focusing an input,
// committing) — a query that vanishes on its own mid-thought reads as flaky.
//
// Scopes (the sidebar workspace list today; executors/files later) register
// via useLocateScope and render their own feedback (row highlight + chip)
// from useLocateEngagement. The controller consumes keys on window in the
// capture phase with stopPropagation, so while engaged nothing leaks to other
// global shortcuts ('?', tab hotkeys) or to React handlers underneath.

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
import { fuzzyScore } from "@/lib/fuzzy";
import { isEditableTarget } from "@/lib/editable-target";
import { LocateChip } from "./locate-chip";

export interface LocateItem {
  id: string;
  /** The text the query is fuzzy-matched against (branch name, executor name…). */
  text: string;
}

export interface LocateScopeConfig {
  id: string;
  /** Shown in the chip, e.g. "Workspaces". */
  label: string;
  /** Higher wins when several scopes are registered at once. */
  priority: number;
  getItems: () => LocateItem[];
  /** Enter: the scope's primary action for the selected item. */
  onCommit: (item: LocateItem) => void;
  /** Space: an optional secondary action (e.g. expand an executor's output). */
  onSecondaryCommit?: (item: LocateItem) => void;
}

interface EngagedState {
  scopeId: string;
  label: string;
  query: string;
  /** Ids of matching items, in list order (cycling follows the visible list). */
  matchIds: string[];
  selectedId: string | null;
}

interface LocateContextValue {
  engaged: EngagedState | null;
  registerScope: (scope: LocateScopeConfig) => () => void;
}

const LocateContext = createContext<LocateContextValue>({
  engaged: null,
  registerScope: () => () => {},
});

// Typing into an open overlay must not engage: Radix menus have their own
// letter typeahead, dialogs host their own controls. Exported for sibling
// keyboard features (e.g. the executor-target arrow switcher) that need the
// same layering guard.
export const isInOverlay = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]') !== null;

const consume = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

// Matches keep list order so ↑↓ moves visually; the initial selection is the
// best-scoring match so a bare Enter still jumps to the likeliest target.
function computeState(scope: LocateScopeConfig, query: string): EngagedState {
  const matchIds: string[] = [];
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const item of scope.getItems()) {
    const score = fuzzyScore(query, item.text);
    if (score === null) continue;
    matchIds.push(item.id);
    if (score > bestScore) {
      bestScore = score;
      bestId = item.id;
    }
  }
  return { scopeId: scope.id, label: scope.label, query, matchIds, selectedId: bestId };
}

export function LocateProvider({ children }: { children: ReactNode }) {
  const scopesRef = useRef<Map<string, LocateScopeConfig>>(new Map());
  const [engaged, setEngaged] = useState<EngagedState | null>(null);
  const engagedRef = useRef<EngagedState | null>(null);
  useEffect(() => {
    engagedRef.current = engaged;
  }, [engaged]);
  const disengage = useCallback(() => {
    setEngaged(null);
  }, []);

  const registerScope = useCallback(
    (scope: LocateScopeConfig) => {
      scopesRef.current.set(scope.id, scope);
      return () => {
        scopesRef.current.delete(scope.id);
        if (engagedRef.current?.scopeId === scope.id) disengage();
      };
    },
    [disengage],
  );

  useEffect(() => {
    const engage = (next: EngagedState) => {
      setEngaged(next);
    };
    const activeScope = () => {
      let best: LocateScopeConfig | null = null;
      for (const scope of scopesRef.current.values()) {
        if (!best || scope.priority > best.priority) best = scope;
      }
      return best;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const current = engagedRef.current;

      if (!current) {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        // '?' is reserved for the shortcuts overlay; a leading space stays a
        // plain (scroll) key. Both still work inside an active query.
        if (event.key.length !== 1 || event.key === " " || event.key === "?") return;
        if (isEditableTarget(event.target) || isInOverlay(event.target)) return;
        const scope = activeScope();
        if (!scope) return;
        const next = computeState(scope, event.key);
        consume(event);
        engage(next);
        return;
      }

      // The keyboard moved to a deeper layer mid-query (an input, or an
      // overlay opened via a modifier combo that passed through below) —
      // hand it back unconsumed so Esc/typing target that layer, not us.
      if (isEditableTarget(event.target) || isInOverlay(event.target)) {
        disengage();
        return;
      }
      const scope = scopesRef.current.get(current.scopeId);
      if (!scope) {
        disengage();
        return;
      }

      if (event.key === "Escape") {
        // First Esc only clears the query; region release (focus-region.tsx)
        // never sees this event thanks to stopPropagation.
        consume(event);
        disengage();
        return;
      }
      if (event.key === "Enter" || (event.key === " " && scope.onSecondaryCommit)) {
        consume(event);
        const selected =
          current.selectedId !== null
            ? scope.getItems().find((item) => item.id === current.selectedId)
            : undefined;
        const commit = event.key === "Enter" ? scope.onCommit : scope.onSecondaryCommit!;
        disengage();
        if (selected) commit(selected);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        consume(event);
        const count = current.matchIds.length;
        if (count === 0) return;
        const index = current.selectedId !== null ? current.matchIds.indexOf(current.selectedId) : -1;
        const nextIndex =
          event.key === "ArrowDown" ? (index + 1) % count : (index - 1 + count) % count;
        engage({ ...current, selectedId: current.matchIds[nextIndex] });
        return;
      }
      if (event.key === "Backspace") {
        consume(event);
        const query = current.query.slice(0, -1);
        if (!query) {
          disengage();
          return;
        }
        engage(computeState(scope, query));
        return;
      }
      if (event.key === "Tab") {
        consume(event);
        const scopes = [...scopesRef.current.values()].sort((a, b) => b.priority - a.priority);
        if (scopes.length > 1) {
          const index = scopes.findIndex((s) => s.id === current.scopeId);
          engage(computeState(scopes[(index + 1) % scopes.length], current.query));
        }
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        consume(event);
        engage(computeState(scope, current.query + event.key));
        return;
      }
      // Anything else (PageDown, F-keys…) passes through and keeps the query.
    };

    const onPointerDown = () => {
      if (engagedRef.current) disengage();
    };

    // Disengage the moment focus lands in an input or overlay (Cmd+K opens
    // the switcher, Cmd+J a menu — both pass through the engaged handler as
    // modifier combos). Without this the query would linger until the next
    // keydown, and a following Esc would tear down both layers at once.
    const onFocusIn = (event: FocusEvent) => {
      if (!engagedRef.current) return;
      if (isEditableTarget(event.target) || isInOverlay(event.target)) disengage();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
    };
  }, [disengage]);

  const value = useMemo(() => ({ engaged, registerScope }), [engaged, registerScope]);
  return (
    <LocateContext.Provider value={value}>
      {children}
      {engaged && <LocateChip query={engaged.query} matchCount={engaged.matchIds.length} />}
    </LocateContext.Provider>
  );
}

/**
 * Register a locate scope while `enabled`. The config is read through a ref on
 * every use, so callers can pass fresh closures without re-registering — but
 * the PRESENCE of optional handlers (onSecondaryCommit) is captured at
 * registration time: provide them unconditionally or not at all.
 */
export function useLocateScope(config: LocateScopeConfig, enabled: boolean) {
  const { registerScope } = useContext(LocateContext);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    if (!enabled) return;
    return registerScope({
      id: configRef.current.id,
      label: configRef.current.label,
      priority: configRef.current.priority,
      getItems: () => configRef.current.getItems(),
      onCommit: (item) => configRef.current.onCommit(item),
      // Presence decides whether Space is a secondary commit or plain input,
      // so only register a wrapper when the config actually defines one.
      onSecondaryCommit: configRef.current.onSecondaryCommit
        ? (item) => configRef.current.onSecondaryCommit?.(item)
        : undefined,
    });
  }, [enabled, registerScope]);
}

export interface LocateEngagement {
  query: string;
  label: string;
  matchSet: Set<string>;
  matchCount: number;
  selectedId: string | null;
}

/** The engagement state for one scope, or null when it isn't the one typing targets. */
export function useLocateEngagement(scopeId: string): LocateEngagement | null {
  const { engaged } = useContext(LocateContext);
  return useMemo(() => {
    if (!engaged || engaged.scopeId !== scopeId) return null;
    return {
      query: engaged.query,
      label: engaged.label,
      matchSet: new Set(engaged.matchIds),
      matchCount: engaged.matchIds.length,
      selectedId: engaged.selectedId,
    };
  }, [engaged, scopeId]);
}
