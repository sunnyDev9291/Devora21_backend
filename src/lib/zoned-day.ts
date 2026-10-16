import { AppError } from "../middleware/errorHandler";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Offset such that: localWallAsUtcMs = utcMs + offsetMs
 * (i.e. how far ahead the timezone wall-clock is vs UTC at that instant).
 */
function getTimeZoneOffsetMs(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(utcDate);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return asUtc - utcDate.getTime();
}

/** UTC instant for YYYY-MM-DD HH:mm:ss as wall time in `timeZone`. */
export function zonedWallTimeToUtc(
  dateYmd: string,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const m = YMD_RE.exec(dateYmd.trim());
  if (!m) {
    throw new AppError(400, "date must be YYYY-MM-DD");
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const wallAsUtc = Date.UTC(y, mo - 1, d, hour, minute, second);

  // Two-pass offset (handles DST boundaries).
  let guess = new Date(wallAsUtc);
  let offset = getTimeZoneOffsetMs(guess, timeZone);
  guess = new Date(wallAsUtc - offset);
  offset = getTimeZoneOffsetMs(guess, timeZone);
  return new Date(wallAsUtc - offset);
}

/**
 * Half-open UTC interval [start, end) covering the calendar day `dateYmd`
 * in `timeZone` (default America/New_York).
 */
export function zonedDayBoundsUtc(
  dateYmd: string,
  timeZone = "America/New_York"
): { start: Date; end: Date } {
  const tz = timeZone.trim() || "America/New_York";
  try {
    // Validate IANA zone early.
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new AppError(400, `Invalid timezone: ${tz}`);
  }

  const start = zonedWallTimeToUtc(dateYmd, 0, 0, 0, tz);

  const m = YMD_RE.exec(dateYmd.trim())!;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Next calendar day via Date.UTC overflow.
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const nextYmd = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  const end = zonedWallTimeToUtc(nextYmd, 0, 0, 0, tz);

  return { start, end };
}

export function parseOptionalIsoDate(raw: string | undefined): Date | undefined {
  if (!raw?.trim()) return undefined;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) {
    throw new AppError(400, `Invalid ISO datetime: ${raw}`);
  }
  return d;
}
