import { Cron } from "croner";
import cronstrue from "cronstrue";

/**
 * Friendly schedule builder <-> 5-field cron. Storage stays `cron_expr` +
 * `timezone`; the builder only covers the common shapes and anything else
 * round-trips through the raw "custom" editor untouched.
 */
export type Frequency = "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export interface CronBuilder {
  frequency: Exclude<Frequency, "custom">;
  /** Minutes between runs ("minutes" only); always a divisor of 60 so runs stay evenly spaced. */
  interval: number;
  /** Minute of the hour ("hourly" only). */
  minute: number;
  /** "HH:MM" for daily / weekdays / weekly / monthly. */
  time: string;
  /** 0 = Sunday … 6 = Saturday ("weekly" only). */
  weekdays: number[];
  /** 1–31 ("monthly" only). */
  dayOfMonth: number;
}

export const MINUTE_INTERVALS = [5, 10, 15, 20, 30] as const;

export const DEFAULT_BUILDER: CronBuilder = {
  frequency: "daily",
  interval: 15,
  minute: 0,
  time: "09:00",
  weekdays: [1],
  dayOfMonth: 1,
};

function splitTime(time: string): [number, number] {
  const [h, m] = time.split(":").map((part) => parseInt(part, 10));
  return [Number.isInteger(h) ? h : 0, Number.isInteger(m) ? m : 0];
}

function joinTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function buildCron(b: CronBuilder): string {
  const [hour, minute] = splitTime(b.time);
  switch (b.frequency) {
    case "minutes": return `*/${b.interval} * * * *`;
    case "hourly": return `${b.minute} * * * *`;
    case "daily": return `${minute} ${hour} * * *`;
    case "weekdays": return `${minute} ${hour} * * 1-5`;
    case "weekly": return `${minute} ${hour} * * ${[...b.weekdays].sort((x, y) => x - y).join(",")}`;
    case "monthly": return `${minute} ${hour} ${b.dayOfMonth} * *`;
  }
}

function intIn(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = parseInt(field, 10);
  return n >= min && n <= max ? n : null;
}

/** Recognize a builder shape; null means "edit it as custom cron". */
export function parseCron(expr: string): CronBuilder | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields;
  if (month !== "*") return null;

  const interval = /^\*\/(\d{1,2})$/.exec(min);
  if (interval && hour === "*" && dom === "*" && dow === "*") {
    const n = parseInt(interval[1], 10);
    return (MINUTE_INTERVALS as readonly number[]).includes(n) ? { ...DEFAULT_BUILDER, frequency: "minutes", interval: n } : null;
  }

  const m = intIn(min, 0, 59);
  if (m === null) return null;
  if (hour === "*") {
    return dom === "*" && dow === "*" ? { ...DEFAULT_BUILDER, frequency: "hourly", minute: m } : null;
  }
  const h = intIn(hour, 0, 23);
  if (h === null) return null;
  const time = joinTime(h, m);

  if (dom === "*" && dow === "*") return { ...DEFAULT_BUILDER, frequency: "daily", time };
  if (dom === "*" && dow === "1-5") return { ...DEFAULT_BUILDER, frequency: "weekdays", time };
  if (dom === "*") {
    const days = dow.split(",").map((d) => intIn(d, 0, 6));
    if (days.some((d) => d === null)) return null;
    const unique = [...new Set(days as number[])];
    return { ...DEFAULT_BUILDER, frequency: "weekly", time, weekdays: unique };
  }
  if (dow === "*") {
    const d = intIn(dom, 1, 31);
    return d === null ? null : { ...DEFAULT_BUILDER, frequency: "monthly", time, dayOfMonth: d };
  }
  return null;
}

export type CronPreview =
  | { ok: true; description: string | null; nextRuns: Date[] }
  | { ok: false; error: string };

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Same acceptance rules as the backend's validateCron (croner), plus a human description. */
export function previewCron(expr: string, timezone: string, count = 3): CronPreview {
  if (!isValidTimezone(timezone)) return { ok: false, error: `Invalid timezone: ${timezone}` };
  let nextRuns: Date[];
  try {
    const job = new Cron(expr.trim(), { paused: true, timezone });
    nextRuns = job.nextRuns(count);
    job.stop();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, description: describeCron(expr), nextRuns };
}

/** True for a day-of-week field that leaves no day out, e.g. "0,1,2,3,4,5,6" or "0-6". */
function coversEveryWeekday(field: string): boolean {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const [from, to] = part.split("-");
    const start = Number(from);
    const end = to === undefined ? start : Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return false;
    // Cron accepts 7 for Sunday alongside 0.
    for (let d = start; d <= end; d++) days.add(d % 7);
  }
  return days.size === 7;
}

export function describeCron(expr: string): string | null {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  const dowIndex = parts.length === 5 ? 4 : 5;
  // A weekday list naming all seven days is the same schedule as no weekday
  // restriction, so let cronstrue describe the simpler form rather than
  // reciting every day.
  if (parts[dowIndex] && parts[dowIndex] !== "*" && coversEveryWeekday(parts[dowIndex])) {
    parts[dowIndex] = "*";
  }
  let description: string;
  try {
    description = cronstrue.toString(parts.join(" "), { use24HourTimeFormat: true, verbose: false });
  } catch {
    return null;
  }
  // Without a day clause "At 09:00" alone reads like a one-off; cronstrue omits
  // the "every day" that makes it a schedule, so put it back.
  if (/^At \d{2}:\d{2}$/.test(description)) description += ", every day";
  // "At 09:00, only on Monday" — the "only" carries nothing the day list
  // doesn't already say, and the preview line is tight.
  description = description.replace(/, only (on|in) /g, ", $1 ");
  // croner fires when EITHER day field matches once both are restricted, but
  // cronstrue reads as AND whatever logicalAndDayFields says (", and on Monday",
  // or a bare ", Monday through Friday" for ranges) — so say it outright.
  const [dom, dow] = parts.length === 5 ? [parts[2], parts[4]] : [parts[3], parts[5]];
  const restricted = (field: string | undefined) => field !== undefined && field !== "*" && field !== "?";
  if (restricted(dom) && restricted(dow)) {
    const i = description.lastIndexOf(", and on ");
    if (i !== -1) description = `${description.slice(0, i)}, or on ${description.slice(i + ", and on ".length)}`;
    description += " (runs when either the day of month or the weekday matches)";
  }
  // "Monday, Wednesday, and Friday" -> "Monday, Wednesday, Friday". Only lists
  // of three or more carry that comma, and the preview line is tight. Runs
  // last: the day-field clause above keys off cronstrue's own ", and on ".
  description = description.replace(/, and /g, ", ");
  return description;
}

/** "Fri, Sep 18, 09:00" rendered in the schedule's own timezone. */
export function formatInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function listTimezones(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/**
 * Next-run label in the schedule's timezone, with the viewer's local time
 * appended when the two zones disagree on the wall clock.
 */
export function formatNextRun(date: Date, scheduleTimezone: string): string {
  if (!isValidTimezone(scheduleTimezone)) return date.toLocaleString();
  const inSchedule = `${formatInZone(date, scheduleTimezone)} (${scheduleTimezone})`;
  const localLabel = formatInZone(date, browserTimezone());
  return localLabel === formatInZone(date, scheduleTimezone) ? inSchedule : `${inSchedule} · your time ${localLabel}`;
}
