import { Prisma } from "@prisma/client";
import { AppError } from "../middleware/errorHandler";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ArchiveListFilters {
  company?: string;
  jd?: string;
  from?: string;
  to?: string;
  q?: string;
}

export function parseBidAt(datetime: string): Date {
  const parsed = new Date(datetime);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "datetime must be a valid ISO 8601 UTC timestamp");
  }
  return parsed;
}

export function parseDateBound(dateStr: string, bound: "start" | "end"): Date {
  if (!DATE_ONLY_PATTERN.test(dateStr)) {
    throw new AppError(400, "from/to must be YYYY-MM-DD");
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));

  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    throw new AppError(400, "from/to must be YYYY-MM-DD");
  }

  if (bound === "start") {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  return new Date(`${dateStr}T23:59:59.999Z`);
}

export function normalizeArchiveListFilters(filters: ArchiveListFilters): ArchiveListFilters {
  return {
    company: filters.company?.trim() || undefined,
    jd: filters.jd?.trim() || undefined,
    from: filters.from?.trim() || undefined,
    to: filters.to?.trim() || undefined,
    q: filters.q?.trim() || undefined,
  };
}

export function hasArchiveListFilters(filters: ArchiveListFilters): boolean {
  return Boolean(filters.company || filters.jd || filters.from || filters.to || filters.q);
}

export function buildArchiveWhereSql(
  userId: string,
  filters: ArchiveListFilters
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`"userId" = ${userId}`];

  if (filters.company) {
    conditions.push(Prisma.sql`"companyName" ILIKE ${`%${filters.company}%`}`);
  }

  if (filters.jd) {
    conditions.push(Prisma.sql`COALESCE("jobDescription", '') ILIKE ${`%${filters.jd}%`}`);
  }

  if (filters.from) {
    conditions.push(Prisma.sql`"bidAt" >= ${parseDateBound(filters.from, "start")}`);
  }

  if (filters.to) {
    conditions.push(Prisma.sql`"bidAt" <= ${parseDateBound(filters.to, "end")}`);
  }

  if (filters.q) {
    const pattern = `%${filters.q}%`;
    conditions.push(Prisma.sql`(
      "jobTitle" ILIKE ${pattern}
      OR "companyName" ILIKE ${pattern}
      OR COALESCE("jobDescription", '') ILIKE ${pattern}
      OR "resumeFileName" ILIKE ${pattern}
      OR "bidAt"::text ILIKE ${pattern}
    )`);
  }

  return Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
}
