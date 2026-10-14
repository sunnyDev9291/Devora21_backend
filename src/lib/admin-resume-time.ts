import { AppError } from "../middleware/errorHandler";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TZ_SAFE = /^[A-Za-z0-9_+\-/]+$/;

export type AnalyticsPreset =
  | "today"
  | "week"
  | "last7"
  | "last30"
  | "last90"
  | "month"
  | "all"
  | "custom";

export type AnalyticsWindow = {
  timezone: string;
  preset: AnalyticsPreset;
  /** Inclusive local date YYYY-MM-DD (in timezone). */
  fromDate: string;
  /** Inclusive local date YYYY-MM-DD (in timezone). */
  toDate: string;
  /** UTC instant for range start (inclusive). */
  rangeStart: Date;
  /** UTC instant for range end (exclusive). */
  rangeEnd: Date;
  /** Previous equal-length window; null when preset=all. */
  previousStart: Date | null;
  previousEnd: Date | null;
  previousFromDate: string | null;
  previousToDate: string | null;
};

export function assertValidTimezone(timezone: string): string {
  const tz = timezone.trim() || "UTC";
  if (!TZ_SAFE.test(tz)) {
    throw new AppError(400, "Invalid timezone");
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch {
    throw new AppError(400, "Invalid timezone");
  }
  return tz;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar parts for an instant in a timezone. */
export function zonedYmd(
  date: Date,
  timeZone: string
): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const wd = get("weekday");
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { y, m, d, weekday: map[wd] ?? 0 };
}

export function formatYmd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Convert a local wall time in `timeZone` to a UTC Date.
 * Uses iterative offset correction (no extra deps).
 */
export function zonedLocalToUtc(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  let utc = Date.UTC(y, m - 1, d, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const asZoned = zonedYmd(new Date(utc), timeZone);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mi = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const s = Number(parts.find((p) => p.type === "second")?.value ?? "0");
    const wanted = Date.UTC(y, m - 1, d, hour, minute, second);
    const got = Date.UTC(asZoned.y, asZoned.m - 1, asZoned.d, h, mi, s);
    utc += wanted - got;
  }
  return new Date(utc);
}

export function startOfZonedDay(ymd: string, timeZone: string): Date {
  if (!DATE_ONLY.test(ymd)) {
    throw new AppError(400, "from/to must be YYYY-MM-DD");
  }
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedLocalToUtc(y, m, d, 0, 0, 0, timeZone);
}

/** Exclusive end = start of next local day. */
export function endExclusiveOfZonedDay(ymd: string, timeZone: string): Date {
  if (!DATE_ONLY.test(ymd)) {
    throw new AppError(400, "from/to must be YYYY-MM-DD");
  }
  const start = startOfZonedDay(ymd, timeZone);
  // Add ~36h then re-normalize to next local midnight via parts+1 day is messy;
  // walk forward 1 calendar day in local parts.
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedLocalToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    0,
    timeZone
  );
}

function addLocalDays(ymd: string, delta: number, timeZone: string): string {
  const start = startOfZonedDay(ymd, timeZone);
  const shifted = new Date(start.getTime() + delta * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
  const p = zonedYmd(shifted, timeZone);
  return formatYmd(p.y, p.m, p.d);
}

function daysBetweenInclusive(fromYmd: string, toYmd: string, timeZone: string): number {
  const a = startOfZonedDay(fromYmd, timeZone).getTime();
  const b = startOfZonedDay(toYmd, timeZone).getTime();
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000))) + 1;
}

export function listYmdRange(fromYmd: string, toYmd: string, timeZone: string): string[] {
  const out: string[] = [];
  let cur = fromYmd;
  const guard = 400;
  for (let i = 0; i < guard; i += 1) {
    out.push(cur);
    if (cur === toYmd) break;
    cur = addLocalDays(cur, 1, timeZone);
  }
  return out;
}

/**
 * Resolve analytics window.
 * Week = Monday 00:00 local → now (ISO).
 * Month = 1st of current local month → now.
 * Today = local midnight → now.
 * All = earliest sensible (1970) → now (no previous window).
 */
export function resolveAnalyticsWindow(input: {
  preset?: string;
  from?: string;
  to?: string;
  timezone?: string;
}): AnalyticsWindow {
  const timezone = assertValidTimezone(input.timezone ?? "UTC");
  const now = new Date();
  const todayParts = zonedYmd(now, timezone);
  const todayYmd = formatYmd(todayParts.y, todayParts.m, todayParts.d);

  let preset = (input.preset ?? "month").trim().toLowerCase() as AnalyticsPreset;
  if (
    ![
      "today",
      "week",
      "last7",
      "last30",
      "last90",
      "month",
      "all",
      "custom",
    ].includes(preset)
  ) {
    throw new AppError(
      400,
      "preset must be today|week|last7|last30|last90|month|all|custom"
    );
  }

  let fromDate: string;
  let toDate = todayYmd;
  const hasExplicitRange = Boolean(input.from?.trim() && input.to?.trim());

  // FE often sends from/to with last7 / last30 / custom — prefer explicit bounds.
  if (hasExplicitRange || preset === "custom") {
    if (!input.from || !input.to) {
      throw new AppError(400, "from and to are required when preset=custom");
    }
    fromDate = input.from.trim();
    toDate = input.to.trim();
    if (!DATE_ONLY.test(fromDate) || !DATE_ONLY.test(toDate)) {
      throw new AppError(400, "from/to must be YYYY-MM-DD");
    }
    if (startOfZonedDay(fromDate, timezone) > startOfZonedDay(toDate, timezone)) {
      throw new AppError(400, "from must be on or before to");
    }
  } else if (preset === "today") {
    fromDate = todayYmd;
  } else if (preset === "week") {
    // Monday-start ISO week in local TZ.
    const daysFromMonday = (todayParts.weekday + 6) % 7; // Mon=0 … Sun=6
    fromDate = addLocalDays(todayYmd, -daysFromMonday, timezone);
  } else if (preset === "last7") {
    fromDate = addLocalDays(todayYmd, -6, timezone);
  } else if (preset === "last30") {
    fromDate = addLocalDays(todayYmd, -29, timezone);
  } else if (preset === "last90") {
    fromDate = addLocalDays(todayYmd, -89, timezone);
  } else if (preset === "month") {
    fromDate = formatYmd(todayParts.y, todayParts.m, 1);
  } else {
    // all
    fromDate = "1970-01-01";
  }

  const rangeStart = startOfZonedDay(fromDate, timezone);
  // Explicit/custom ranges end at end-of-toDate; rolling presets end at now.
  const rangeEnd =
    hasExplicitRange || preset === "custom"
      ? endExclusiveOfZonedDay(toDate, timezone)
      : now;

  let previousStart: Date | null = null;
  let previousEnd: Date | null = null;
  let previousFromDate: string | null = null;
  let previousToDate: string | null = null;

  if (preset !== "all") {
    const lenDays = daysBetweenInclusive(fromDate, toDate, timezone);
    previousToDate = addLocalDays(fromDate, -1, timezone);
    previousFromDate = addLocalDays(previousToDate, -(lenDays - 1), timezone);
    previousStart = startOfZonedDay(previousFromDate, timezone);
    previousEnd = startOfZonedDay(fromDate, timezone);
  }

  return {
    timezone,
    preset,
    fromDate,
    toDate,
    rangeStart,
    rangeEnd,
    previousStart,
    previousEnd,
    previousFromDate,
    previousToDate,
  };
}

/** Absolute KPI windows (always from local calendar, independent of custom range). */
export function absoluteKpiWindows(timezone: string, now = new Date()) {
  const tz = assertValidTimezone(timezone);
  const todayParts = zonedYmd(now, tz);
  const todayYmd = formatYmd(todayParts.y, todayParts.m, todayParts.d);
  const daysFromMonday = (todayParts.weekday + 6) % 7;
  const weekStartYmd = addLocalDays(todayYmd, -daysFromMonday, tz);
  const monthStartYmd = formatYmd(todayParts.y, todayParts.m, 1);

  return {
    todayStart: startOfZonedDay(todayYmd, tz),
    weekStart: startOfZonedDay(weekStartYmd, tz),
    monthStart: startOfZonedDay(monthStartYmd, tz),
    now,
  };
}
