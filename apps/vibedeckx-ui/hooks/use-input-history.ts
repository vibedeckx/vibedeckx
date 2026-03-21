import { useCallback, useRef } from "react";
import type { KeyboardEvent } from "react";

const MAX_HISTORY = 50;

/**
 * Provides terminal-style up/down arrow history navigation for a text input.
 * - ArrowUp (when cursor is at position 0): recalls previous sent message
 * - ArrowDown (when cursor is at end): recalls next sent message or restores draft
 */
export function useInputHistory(setInput: (value: string) => void) {
  const historyRef = useRef<string[]>([]);
  const cursorRef = useRef(-1); // -1 = not navigating history
  const draftRef = useRef(""); // saves current input when history navigation starts

  const push = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const history = historyRef.current;
    // Skip duplicate of the most recent entry
    if (history.length > 0 && history[history.length - 1] === trimmed) {
      cursorRef.current = -1;
      return;
    }
    history.push(trimmed);
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
    cursorRef.current = -1;
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const history = historyRef.current;
      if (history.length === 0) return;

      if (e.key === "ArrowUp") {
        // Only intercept when cursor is at position 0 (start of text)
        if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) return;

        e.preventDefault();

        if (cursorRef.current === -1) {
          // Starting history navigation — save current draft
          draftRef.current = textarea.value;
          cursorRef.current = history.length - 1;
        } else if (cursorRef.current > 0) {
          cursorRef.current--;
        } else {
          return; // already at oldest entry
        }

        setInput(history[cursorRef.current]);
      } else if (e.key === "ArrowDown") {
        if (cursorRef.current === -1) return; // not navigating history

        // Only intercept when cursor is at the end of text
        const len = textarea.value.length;
        if (textarea.selectionStart !== len || textarea.selectionEnd !== len) return;

        e.preventDefault();

        if (cursorRef.current < history.length - 1) {
          cursorRef.current++;
          setInput(history[cursorRef.current]);
        } else {
          // Past newest entry — restore draft
          cursorRef.current = -1;
          setInput(draftRef.current);
        }
      } else {
        // Any other key resets history navigation cursor
        // (user started editing, so they're done navigating)
        if (cursorRef.current !== -1) {
          cursorRef.current = -1;
        }
      }
    },
    [setInput]
  );

  return { push, handleKeyDown };
}
