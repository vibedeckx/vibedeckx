import { describe, it, expect } from "vitest";
import { projectInitials } from "./project-initials";

describe("projectInitials", () => {
  it("takes the first letter of each of the first two words", () => {
    expect(projectInitials("orchestrator-core")).toBe("oc");
    expect(projectInitials("web_ui")).toBe("wu");
    expect(projectInitials("api/gateway")).toBe("ag");
    expect(projectInitials("Edge Runner")).toBe("er");
  });

  it("falls back to the leading characters of a single word", () => {
    expect(projectInitials("vibedeckx")).toBe("vi");
  });

  it("emits one letter when asked, even for multi-word names", () => {
    expect(projectInitials("orchestrator-core", 1)).toBe("o");
    expect(projectInitials("vibedeckx", 1)).toBe("v");
  });

  it("slices by code point so astral characters survive intact", () => {
    // "a🧩b".slice(0, 2) cuts the emoji's surrogate pair and renders as "a�".
    expect(projectInitials("a🧩b")).toBe("a🧩");
    expect(projectInitials("🧩core", 1)).toBe("🧩");
    expect(projectInitials("🧩 core")).toBe("🧩c");
  });

  it("keeps non-Latin names readable", () => {
    expect(projectInitials("编排核心")).toBe("编排");
    expect(projectInitials("编排核心", 1)).toBe("编");
  });

  it("returns empty string when the name yields nothing, never a placeholder", () => {
    expect(projectInitials("")).toBe("");
    expect(projectInitials("   ")).toBe("");
    expect(projectInitials("---")).toBe("");
  });
});
