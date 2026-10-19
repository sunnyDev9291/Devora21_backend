/**
 * Skills as category → item list (AI / FE shape).
 * DOCX fill still uses newline "Category: item, item" strings.
 */

export type SkillsObject = Record<string, string[]>;

export function isSkillsObject(value: unknown): value is SkillsObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) =>
      Array.isArray(v) &&
      (v as unknown[]).every((item) => typeof item === "string" || typeof item === "number")
  );
}

/** Normalize AI/FE skills object values to string[]. */
export function normalizeSkillsObject(value: unknown): SkillsObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: SkillsObject = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cat = key.trim();
    if (!cat || /^\d+$/.test(cat)) continue;
    if (Array.isArray(raw)) {
      out[cat] = raw
        .map((item) => String(item ?? "").replace(/\*\*/g, "").trim())
        .filter(Boolean);
    } else if (typeof raw === "string") {
      out[cat] = raw
        .split(/[,;•|/]+/)
        .map((p) => p.replace(/\*\*/g, "").trim())
        .filter(Boolean);
    } else if (raw == null) {
      out[cat] = [];
    } else {
      const text = String(raw).trim();
      out[cat] = text ? [text] : [];
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Object → DOCX / internal string: "Cat: a · b\nCat2: c" */
export function skillsObjectToLines(skills: SkillsObject): string {
  return Object.entries(skills)
    .map(([cat, items]) => {
      const list = items.map((i) => i.trim()).filter(Boolean);
      return list.length ? `${cat}: ${list.join(" · ")}` : `${cat}:`;
    })
    .join("\n");
}

/** String lines → object (legacy AI / stored content). */
export function skillsLinesToObject(skills: string): SkillsObject {
  const out: SkillsObject = {};
  for (const line of (skills || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      const items = trimmed
        .split(/[,;]+/)
        .map((p) => p.replace(/\*\*/g, "").trim())
        .filter(Boolean);
      if (items.length) {
        out.Other = [...(out.Other ?? []), ...items];
      }
      continue;
    }
    const cat = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (!cat) continue;
    out[cat] = rest
      ? rest
          .split(/[,;•|/]+/)
          .map((p) => p.replace(/\*\*/g, "").trim())
          .filter(Boolean)
      : [];
  }
  return out;
}

/** Accept string or object → canonical line string for DOCX. */
export function coerceSkillsToLines(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const obj = normalizeSkillsObject(value);
  if (obj) return skillsObjectToLines(obj);
  return "";
}

/** Accept string or object → object for FE / AI contract. */
export function coerceSkillsToObject(value: unknown): SkillsObject {
  if (typeof value === "string") return skillsLinesToObject(value);
  const obj = normalizeSkillsObject(value);
  return obj ?? {};
}
