/**
 * Skills reshape: template = FORMAT only; writing instructions / AI win for
 * category count, names, order, and items (no caps to template sample).
 */

const CATEGORY_LINE_RE = /^([^:]{2,40}):\s*(.*)$/;

/** Franco plain text is "Frontend:React" (TAB, no space). Treat as category. */
const SAMPLE_HAS_CATEGORY_RE = /^[^:]{2,40}:\s*\S/;

function normalizeCategoryLine(line: string): string {
  const m = line.match(CATEGORY_LINE_RE);
  if (!m) return line.replace(/\*\*/g, "").trim();
  // Keep "Label: values" (values may be empty — e.g. required "Other:" last).
  const value = m[2].replace(/\*\*/g, "").trim();
  return value ? `${m[1].trim()}: ${value}` : `${m[1].trim()}:`;
}

/**
 * Format AI skills for the template:
 * - Template sample = FORMAT cue only (category vs plain look)
 * - Category NAMES, ORDER, COUNT, and items come from writing instructions / AI
 * - Do NOT remap onto template sample labels
 * - Do NOT cap / slice to template sample line count
 * - Preserve every AI category line, including trailing "Other:"
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
  const sampleHasCategories = sampleLines.some((l) => SAMPLE_HAS_CATEGORY_RE.test(l));

  const aiLines = ai
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Keep "Other:" even with no items — label-only lines still match CATEGORY_LINE_RE.
  const categoryLines = aiLines.filter((l) => /^[^:]{2,40}:\s*/.test(l));

  // Writing instructions / AI categories always win when present — never remap or cap.
  if (categoryLines.length > 0) {
    return categoryLines.map(normalizeCategoryLine).join("\n");
  }

  // Plain AI list: only strip invented labels when template is also plain (bullets).
  if (layout === "bullets" && !sampleHasCategories) {
    const stripped = aiLines
      .map((line) => {
        const m = line.match(CATEGORY_LINE_RE);
        return (m ? m[2] : line).replace(/\*\*/g, "").trim();
      })
      .filter(Boolean);
    return stripped.join(sample.includes("\n") ? "\n" : ", ");
  }

  return aiLines.map((l) => l.replace(/\*\*/g, "").trim()).filter(Boolean).join("\n");
}

/** Category labels from a skills block (for tab-stop sizing). */
export function collectCategoryLabels(skills: string): string[] {
  const labels: string[] = [];
  for (const line of skills.split(/\r?\n/)) {
    const m = line.trim().match(CATEGORY_LINE_RE);
    if (m) labels.push(m[1].trim());
  }
  return labels;
}
