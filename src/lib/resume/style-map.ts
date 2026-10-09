/**
 * Canonical resume template paragraph styles.
 * Word often stores styleId without underscores (company_period → companyperiod).
 */

export function normalizeStyleId(styleId: string): string {
  return (styleId || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
}

/** Logical field → accepted styleIds / style names (normalized). */
export const STYLE_ALIASES = {
  name: ["name", "headername"],
  title: ["resumetitle", "headertitle", "title"],
  country: ["country"],
  phone: ["phone"],
  email: ["email"],
  linkedin: ["linkedin"],
  summary: ["summary"],
  skillCat: ["skillcat"],
  skillItem: ["skillitem"],
  companyPeriod: ["companyperiod"],
  companyLocation: ["companylocation"],
  companyName: ["companyname"],
  companyRole: ["companyrole"],
  expSection: ["expsection"],
  degree: ["degree"],
  universityName: ["universityname"],
  universityPeriod: ["universityperiod"],
  headerName: ["headername"],
  headerTitle: ["headertitle"],
} as const;

export type StyleField = keyof typeof STYLE_ALIASES;

export function styleMatches(styleId: string, field: StyleField): boolean {
  const n = normalizeStyleId(styleId);
  if (!n) return false;
  return (STYLE_ALIASES[field] as readonly string[]).includes(n);
}

export function isAnyStyle(styleId: string, fields: StyleField[]): boolean {
  return fields.some((f) => styleMatches(styleId, f));
}

/** Template is "styled" if it uses our custom content styles (not just Heading*). */
export function looksLikeStyledTemplate(styleIds: string[]): boolean {
  const markers: StyleField[] = [
    "summary",
    "skillCat",
    "skillItem",
    "expSection",
    "companyPeriod",
    "companyName",
    "companyRole",
    "name",
    "headerName",
  ];
  let hits = 0;
  for (const id of styleIds) {
    if (isAnyStyle(id, markers)) hits += 1;
    if (hits >= 3) return true;
  }
  return false;
}
