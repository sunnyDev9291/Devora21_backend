import { Prisma } from "@prisma/client";
import { AppError } from "../middleware/errorHandler";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Max rows returned when filtering by company / job title (typeahead). */
export const COMPANY_TYPEAHEAD_LIMIT = 50;

export interface ArchiveListFilters {
  company?: string;
  /** Case-insensitive substring on jobTitle. */
  jobTitle?: string;
  jd?: string;
  from?: string;
  to?: string;
  q?: string;
  /** When true with company, require case-insensitive exact match. */
  exact?: boolean;
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

/** Trim and collapse internal whitespace for company / title matching & storage. */
export function normalizeCompanyQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export const normalizeJobTitleQuery = normalizeCompanyQuery;

function escapeIlikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function parseExactFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function normalizeArchiveListFilters(
  filters: ArchiveListFilters
): ArchiveListFilters {
  const company = filters.company
    ? normalizeCompanyQuery(filters.company)
    : undefined;
  const jobTitle = filters.jobTitle
    ? normalizeJobTitleQuery(filters.jobTitle)
    : undefined;

  return {
    company: company || undefined,
    jobTitle: jobTitle || undefined,
    jd: filters.jd?.trim() || undefined,
    from: filters.from?.trim() || undefined,
    to: filters.to?.trim() || undefined,
    q: filters.q?.trim() || undefined,
    exact: Boolean(filters.exact) && Boolean(company),
  };
}

export function hasArchiveListFilters(filters: ArchiveListFilters): boolean {
  return Boolean(
    filters.company ||
      filters.jobTitle ||
      filters.jd ||
      filters.from ||
      filters.to ||
      filters.q
  );
}

/** True when company/jobTitle typeahead should cap result count. */
export function isCompanyTypeahead(filters: ArchiveListFilters): boolean {
  return Boolean(filters.company || filters.jobTitle);
}

export function buildArchiveWhereSql(
  userId: string,
  filters: ArchiveListFilters
): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`"userId" = ${userId}`];

  if (filters.company) {
    if (filters.exact) {
      conditions.push(Prisma.sql`"companyName" ILIKE ${filters.company}`);
    } else {
      const pattern = `%${escapeIlikePattern(filters.company)}%`;
      conditions.push(
        Prisma.sql`"companyName" ILIKE ${pattern} ESCAPE '\\'`
      );
    }
  }

  if (filters.jobTitle) {
    const pattern = `%${escapeIlikePattern(filters.jobTitle)}%`;
    conditions.push(Prisma.sql`"jobTitle" ILIKE ${pattern} ESCAPE '\\'`);
  }

  if (filters.jd) {
    conditions.push(
      Prisma.sql`COALESCE("jobDescription", '') ILIKE ${`%${escapeIlikePattern(filters.jd)}%`} ESCAPE '\\'`
    );
  }

  if (filters.from) {
    conditions.push(Prisma.sql`"bidAt" >= ${parseDateBound(filters.from, "start")}`);
  }

  if (filters.to) {
    conditions.push(Prisma.sql`"bidAt" <= ${parseDateBound(filters.to, "end")}`);
  }

  if (filters.q) {
    const pattern = `%${escapeIlikePattern(filters.q)}%`;
    conditions.push(Prisma.sql`(
      "jobTitle" ILIKE ${pattern} ESCAPE '\\'
      OR "companyName" ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE("jobDescription", '') ILIKE ${pattern} ESCAPE '\\'
      OR "resumeFileName" ILIKE ${pattern} ESCAPE '\\'
      OR "bidAt"::text ILIKE ${pattern} ESCAPE '\\'
    )`);
  }

  return Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
}

export { parseExactFlag };
