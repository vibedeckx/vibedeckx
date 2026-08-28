"use client";

// Marks the characters of `text` that the locate query fuzzy-matched with a
// find-in-page-style background block. Consecutive hits merge into one run so
// a substring match reads as a single highlighted chunk, not per-letter
// confetti. Falls back to plain text when the query doesn't match (the list
// dims that row anyway).

import { useMemo } from "react";
import { fuzzyMatchIndices } from "@/lib/fuzzy";

interface Segment {
  text: string;
  hit: boolean;
}

function segment(text: string, indices: number[]): Segment[] {
  const hit = new Set(indices);
  const segments: Segment[] = [];
  for (const [i, ch] of Array.from(text).entries()) {
    const last = segments[segments.length - 1];
    if (last && last.hit === hit.has(i)) last.text += ch;
    else segments.push({ text: ch, hit: hit.has(i) });
  }
  return segments;
}

export function LocateMatchText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => {
    const indices = fuzzyMatchIndices(query, text);
    return indices ? segment(text, indices) : null;
  }, [query, text]);
  if (!segments) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) =>
        s.hit ? (
          <span key={i} className="rounded-[2px] bg-primary/40">
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}
