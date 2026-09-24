/**
 * Replace job-title core while preserving seniority tokens
 * (Junior, Mid, Senior, Staff, Principal, Lead, …).
 *
 * Example: template "Senior Software Engineer" + AI "Data Engineer"
 *       → "Senior Data Engineer"
 */

const SENIORITY_RE =
  /\b(Junior|Jr\.?|Mid(?:-Level)?|Middle|Senior|Sr\.?|Staff|Principal|Lead|Chief)\b/gi;

function extractSeniority(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(SENIORITY_RE)) {
    const key = m[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(m[0]);
  }
  return found;
}

function stripSeniority(text: string): string {
  return text
    .replace(SENIORITY_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prefer seniority from the template role; use AI role's job-title core.
 */
export function syncRolePreservingSeniority(
  templateRole: string,
  aiRole: string
): string {
  const ai = aiRole.trim();
  const base = templateRole.trim();
  if (!ai) return base;
  if (!base) return ai;

  const seniority =
    extractSeniority(base).length > 0
      ? extractSeniority(base)
      : extractSeniority(ai);
  const core = stripSeniority(ai) || stripSeniority(base) || ai;

  if (seniority.length === 0) return core;
  return `${seniority.join(" ")} ${core}`.replace(/\s+/g, " ").trim();
}
