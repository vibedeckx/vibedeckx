import { describe, expect, it } from "vitest";
import { runLineProbe } from "./line-probe.js";

// A fake line-protocol CLI: echoes each stdin line back as {"echo": <line>}.
const ECHO = `process.stdin.setEncoding("utf8");let b="";process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);process.stdout.write(JSON.stringify({echo:l})+"\\n");}});setInterval(()=>{},1000);`;
const node = (script: string) => ({ command: process.execPath, args: ["-e", script] });

describe("runLineProbe", () => {
  it("writes the initial lines, can send more, and resolves on the answer", async () => {
    const seen: string[] = [];
    const result = await runLineProbe(node(ECHO), {
      initial: ["one\n"],
      onLine: (line) => {
        const { echo } = JSON.parse(line) as { echo: string };
        seen.push(echo);
        return echo === "one" ? { write: "two\n" } : { done: seen.join(",") };
      },
      timeoutMs: 10_000,
    });
    expect(result).toBe("one,two");
  });

  it("rejects when the CLI exits first, times out, or onLine throws", async () => {
    await expect(runLineProbe(node("process.exit(3)"), { initial: [], onLine: () => {}, timeoutMs: 10_000 })).rejects.toThrow(/exited \(3\)/);
    await expect(runLineProbe(node(ECHO), { initial: [], onLine: () => {}, timeoutMs: 200 })).rejects.toThrow(/did not answer within 200 ms/);
    await expect(runLineProbe(node(ECHO), { initial: ["x\n"], onLine: () => { throw new Error("bad shape"); }, timeoutMs: 10_000 })).rejects.toThrow("bad shape");
  });

  it("rejects a missing binary", async () => {
    await expect(runLineProbe({ command: "/nonexistent/cli", args: [] }, { initial: [], onLine: () => {}, timeoutMs: 10_000 })).rejects.toThrow();
  });
});
