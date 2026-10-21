import { describe, expect, it } from "vitest";
import { parseWindowsFileTime, processIdentitySupported } from "./process-identity.js";

describe("Windows process identity", () => {
  it("takes the FILETIME PowerShell prints, digits only", () => {
    expect(parseWindowsFileTime("134056421234567890\r\n")).toBe("134056421234567890");
    expect(parseWindowsFileTime("")).toBeUndefined();
    expect(parseWindowsFileTime("Get-Process : Cannot find a process")).toBeUndefined();
    expect(processIdentitySupported("win32")).toBe(true);
  });
});
