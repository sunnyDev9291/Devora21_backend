/**
 * Whole-token skill bolding — e.g. "git" must not bold inside "Digital".
 * Also format skills to mirror template skillsets style.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bold whole-token matches of skill terms inside text (markdown **). */
export function boldSkillTermsWholeToken(text: string, skillTerms: string[]): string {
  if (!text || skillTerms.length === 0) return text;

  const terms = [...new Set(skillTerms.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );

  let result = text;
  for (const term of terms) {
    // Skip if already wrapped as **term**
    const re = new RegExp(`(?<!\\*)\\b(${escapeRegExp(term)})\\b(?!\\*)`, "gi");
    result = result.replace(re, (match, _g1, offset: number, full: string) => {
      const before = full.slice(Math.max(0, offset - 2), offset);
      const after = full.slice(offset + match.length, offset + match.length + 2);
      if (before === "**" || after.startsWith("**")) {
        return match;
      }
      return `**${match}**`;
    });
  }
  return result;
}

export function collectSkillTermsFromSkillsBlock(skills: string): string[] {
  const terms: string[] = [];
  for (const line of skills.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    const value = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
    for (const part of value.split(/[,;|/]/)) {
      const t = part.replace(/\*\*/g, "").trim();
      if (t) terms.push(t);
    }
  }
  return terms;
}

/**
 * Format AI skills to match template sample style:
 * - If template uses "Label: values" lines → keep that style
 * - If template is a plain comma/list block → plain list, strip new category labels for bullets layout
 */
export function formatSkillsToTemplateStyle(
  skills: string,
  templateSample: string,
  layout: "bullets" | "projects"
): string {
  const sample = templateSample.trim();
  const ai = skills.trim();
  if (!ai) return ai;

  const sampleLines = sample.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sampleHasCategories = sampleLines.some((l) => /^[^:]{2,40}:\s+\S/.test(l));

  if (layout === "bullets" && !sampleHasCategories) {
    // Plain list — strip category labels if AI invented them
    return ai
      .split(/\r?\n/)
      .map((line) => {
        const m = line.match(/^[^:]{2,40}:\s*(.+)$/);
        return (m ? m[1] : line).trim();
      })
      .filter(Boolean)
      .join(sample.includes("\n") ? "\n" : ", ");
  }

  if (sampleHasCategories) {
    const labels = sampleLines
      .map((l) => {
        const m = l.match(/^([^:]{2,40}):/);
        return m ? m[1].trim() : null;
      })
      .filter((x): x is string => Boolean(x));

    const aiLines = ai.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const byLabel = new Map<string, string>();
    for (const line of aiLines) {
      const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
      if (m) {
        byLabel.set(m[1].trim().toLowerCase(), m[2].trim());
      }
    }

    if (labels.length > 0) {
      return labels
        .map((label) => {
          const value =
            byLabel.get(label.toLowerCase()) ||
            aiLines.find((l) => l.toLowerCase().startsWith(label.toLowerCase())) ||
            "";
          const cleaned = value.replace(new RegExp(`^${escapeRegExp(label)}:\\s*`, "i"), "");
          return `${label}: ${cleaned || value}`.trim();
        })
        .join("\n");
    }
  }

  return ai;
}
