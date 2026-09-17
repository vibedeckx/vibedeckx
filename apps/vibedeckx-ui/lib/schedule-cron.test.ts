import { describe, expect, it, vi } from "vitest";
import { buildCron, DEFAULT_BUILDER, describeCron, formatInZone, parseCron, previewCron, type CronBuilder } from "./schedule-cron";

describe("schedule-cron builder", () => {
  const shapes: Array<[string, Partial<CronBuilder>]> = [
    ["*/15 * * * *", { frequency: "minutes", interval: 15 }],
    ["30 * * * *", { frequency: "hourly", minute: 30 }],
    ["0 9 * * *", { frequency: "daily", time: "09:00" }],
    ["5 18 * * 1-5", { frequency: "weekdays", time: "18:05" }],
    ["0 9 * * 1,3,5", { frequency: "weekly", time: "09:00", weekdays: [1, 3, 5] }],
    ["0 9 15 * *", { frequency: "monthly", time: "09:00", dayOfMonth: 15 }],
  ];

  it.each(shapes)("round-trips %s", (expr, expected) => {
    const parsed = parseCron(expr);
    expect(parsed).toMatchObject(expected);
    expect(buildCron(parsed!)).toBe(expr);
  });

  it.each([
    "*/7 * * * *", // uneven interval
    "0 9 1-7 * 1", // dom + dow
    "0 9 * 1 *", // month restricted
    "0 9-17 * * *", // hour range
    "0 0 9 * * *", // 6-field
    "garbage",
  ])("leaves %s to the custom editor", (expr) => {
    expect(parseCron(expr)).toBeNull();
  });

  it("sorts weekly days", () => {
    expect(buildCron({ ...DEFAULT_BUILDER, frequency: "weekly", weekdays: [5, 0, 2] })).toBe("0 9 * * 0,2,5");
  });
});

describe("previewCron", () => {
  it("describes and lists next runs in the schedule timezone", () => {
    const preview = previewCron("0 9 * * 1-5", "Asia/Shanghai");
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.description).toBe("At 09:00, Monday through Friday");
    expect(preview.nextRuns).toHaveLength(3);
    for (const run of preview.nextRuns) {
      expect(formatInZone(run, "Asia/Shanghai")).toContain("09:00");
    }
  });

  it("describes restricted day-of-month + weekday as OR, matching croner's firing", () => {
    const either = " (runs when either the day of month or the weekday matches)";
    expect(describeCron("0 9 1-7 * 1")).toBe(`At 09:00, between day 1 and 7 of the month, or on Monday${either}`);
    expect(describeCron("0 9 1-7 * 1-5")).toBe(`At 09:00, between day 1 and 7 of the month, Monday through Friday${either}`);
    expect(describeCron("0 9 * * 1-5")).toBe("At 09:00, Monday through Friday");
  });

  it("fires on either day field (OR), not only when both match", () => {
    // Thu Sep 10: OR hits the next Mondays; AND would wait until Mon Oct 5.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    try {
      const preview = previewCron("0 9 1-7 * 1", "UTC");
      expect(preview.ok && preview.nextRuns.map((d) => d.toISOString())).toEqual([
        "2026-09-14T09:00:00.000Z",
        "2026-09-21T09:00:00.000Z",
        "2026-09-28T09:00:00.000Z",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports invalid cron and timezone", () => {
    expect(previewCron("0 9 * *", "UTC").ok).toBe(false);
    expect(previewCron("0 9 * * *", "Mars/Olympus")).toEqual({ ok: false, error: "Invalid timezone: Mars/Olympus" });
  });
});
