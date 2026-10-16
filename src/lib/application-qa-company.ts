/**
 * Derive a human company name from page title / apply URL when the extension
 * does not send an explicit companyName.
 */

function decodePathSegment(seg: string): string {
  try {
    return decodeURIComponent(seg.replace(/\+/g, " ")).trim();
  } catch {
    return seg.trim();
  }
}

function titleCaseSlug(slug: string): string {
  const cleaned = slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  // Keep existing capitalization if it already has spaces / mixed case from URL decode.
  if (/[A-Z]/.test(cleaned) && cleaned.includes(" ")) return cleaned;
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** "AI-Enabled QA Engineer @ Scale Army Careers" → "Scale Army Careers" */
export function companyFromPageTitle(pageTitle?: string | null): string | undefined {
  const title = String(pageTitle ?? "").trim();
  if (!title) return undefined;
  const at = title.lastIndexOf(" @ ");
  if (at === -1) {
    const at2 = title.lastIndexOf("@");
    if (at2 <= 0) return undefined;
    const company = title.slice(at2 + 1).trim();
    return company || undefined;
  }
  const company = title.slice(at + 3).trim();
  return company || undefined;
}

/** ATS / career-site path heuristics. */
export function companyFromTabUrl(tabUrl?: string | null): string | undefined {
  if (!tabUrl?.trim()) return undefined;
  let u: URL;
  try {
    u = new URL(tabUrl.trim());
  } catch {
    return undefined;
  }

  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) return undefined;

  // jobs.ashbyhq.com/{Company}/...
  if (host.includes("ashbyhq.com") && parts[0]) {
    return titleCaseSlug(decodePathSegment(parts[0])) || undefined;
  }
  // boards.greenhouse.io/{company}/...
  if (host.includes("greenhouse.io") && parts[0] && parts[0] !== "embed") {
    return titleCaseSlug(decodePathSegment(parts[0])) || undefined;
  }
  // jobs.lever.co/{company}/...
  if (host.includes("lever.co") && parts[0]) {
    return titleCaseSlug(decodePathSegment(parts[0])) || undefined;
  }
  // *.myworkdayjobs.com/{company}/...
  if (host.includes("myworkdayjobs.com") && parts[0]) {
    return titleCaseSlug(decodePathSegment(parts[0])) || undefined;
  }
  // job-boards.greenhouse.io / similar: first path segment often company
  if (host.includes("job-boards.") && parts[0]) {
    return titleCaseSlug(decodePathSegment(parts[0])) || undefined;
  }

  return undefined;
}

export function deriveCompanyName(input: {
  pageTitle?: string | null;
  tabUrl?: string | null;
  companyName?: string | null;
}): string | undefined {
  const explicit = String(input.companyName ?? "").trim();
  if (explicit) return explicit;
  return (
    companyFromPageTitle(input.pageTitle) ||
    companyFromTabUrl(input.tabUrl) ||
    undefined
  );
}
