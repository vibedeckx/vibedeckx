import { describe, it, expect } from "vitest";
import { splitVPasteMarkers, vfileMarker } from "./vpaste-chip";

describe("splitVPasteMarkers", () => {
  it("parses vpaste and vfile markers in one string, in order", () => {
    const text = `see <vpaste path="/tmp/p.txt" size="10" /> and ${vfileMarker({ path: "/tmp/a/spec.pdf", name: "spec.pdf", size: 2048 })} end`;
    expect(splitVPasteMarkers(text)).toEqual([
      { kind: "text", text: "see " },
      { kind: "chip", path: "/tmp/p.txt", size: 10 },
      { kind: "text", text: " and " },
      { kind: "chip", path: "/tmp/a/spec.pdf", name: "spec.pdf", size: 2048 },
      { kind: "text", text: " end" },
    ]);
  });

  it("returns a single text segment when there is no marker", () => {
    expect(splitVPasteMarkers("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });

  it("does not treat a malformed vfile tag as a chip", () => {
    const text = '<vfile path="/tmp/x" size="1" />';
    expect(splitVPasteMarkers(text)).toEqual([{ kind: "text", text }]);
  });
});

describe("vfileMarker", () => {
  it("round-trips through the parser", () => {
    const m = vfileMarker({ path: "/tmp/att/notes.md", name: "notes.md", size: 7 });
    expect(m).toBe('<vfile path="/tmp/att/notes.md" name="notes.md" size="7" />');
    expect(splitVPasteMarkers(m)).toEqual([{ kind: "chip", path: "/tmp/att/notes.md", name: "notes.md", size: 7 }]);
  });
});
