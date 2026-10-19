import type { ResumeTemplateLayout, TemplateJobSkeleton } from "./types";
import { resumeJsonOutputContract } from "./output-contract";

function countSkillCategorySlots(skillsSample: string): number {
  const lines = skillsSample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return Math.max(lines.length, 1);
}

/**
 * Read skill ITEM count range from profile writing prompt, e.g.
 * "MUST be 50–54", "58-62", "Aim ~60".
 */
export function extractSkillItemCountRange(
  customPrompt: string
): { min: number; max: number } | null {
  const text = customPrompt || "";
  const rangePatterns = [
    /SKILLS\s*COUNT[\s\S]{0,240}?MUST\s+be\s+(\d+)\s*[–\-~to]+\s*(\d+)/i,
    /total\s+concrete\s+tech\s+items\s+MUST\s+be\s+(\d+)\s*[–\-~to]+\s*(\d+)/i,
    /tech\s+items[^\n]{0,80}?MUST\s+be\s+(\d+)\s*[–\-~to]+\s*(\d+)/i,
    /Aim\s*~?\s*(\d+)\s+concrete\s+tech\s+items/i,
  ];
  for (const re of rangePatterns) {
    const m = text.match(re);
    if (!m) continue;
    if (m[2]) {
      const min = Number(m[1]);
      const max = Number(m[2]);
      if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
        return { min, max };
      }
    } else if (m[1]) {
      const target = Number(m[1]);
      if (Number.isFinite(target) && target > 0) {
        return { min: Math.max(1, target - 2), max: target + 2 };
      }
    }
  }
  return null;
}

/** Count comma/bullet-separated skill items across "Category: a, b" lines. */
export function countSkillItemsInSkillsBlock(skills: string): number {
  const lines = (skills || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let total = 0;
  for (const line of lines) {
    const colon = line.indexOf(":");
    const itemsPart = colon >= 0 ? line.slice(colon + 1) : line;
    const items = itemsPart
      .split(/[,•|/]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    total += items.length;
  }
  return total;
}

function formatCompanyBulletCounts(
  layout: ResumeTemplateLayout,
  jobs: TemplateJobSkeleton[]
): string {
  if (layout === "projects") {
    return jobs
      .map((job, idx) => {
        const names = job.projectNames.map((n) => `"${n}"`).join(", ");
        return `${idx + 1}. dates="${job.dates}" | projects: ${names}`;
      })
      .join("\n");
  }
  return jobs
    .map(
      (job, idx) =>
        `${idx + 1}. dates="${job.dates}" | bullets: ${job.bulletCount}`
    )
    .join("\n");
}

/**
 * @deprecated Mode-1 uses a single user message. Kept for callers that still import it.
 */
export function buildResumeSystemPrompt(
  _layout: ResumeTemplateLayout,
  _profilePrompt: string
): string {
  return "Return ONLY one valid JSON object. No markdown fences, no commentary.";
}

/**
 * Single user message for Mode-1 resume generation:
 * Job title → JD → template slot counts → profile prompt → output JSON shape.
 */
export function buildResumeUserPrompt(input: {
  jobTitle: string;
  jobDescription: string;
  customPrompt: string;
  layout: ResumeTemplateLayout;
  jobs: TemplateJobSkeleton[];
  skillsSample: string;
}): string {
  const categoryCount = countSkillCategorySlots(input.skillsSample);

  const parts: string[] = [
    `Job title : "${input.jobTitle || "Target role"}"`,
    "",
    `Job Description :`,
    input.jobDescription?.trim() || "(none provided)",
    "",
    `Each Company's bullet count (from template analysis):`,
    formatCompanyBulletCounts(input.layout, input.jobs),
    "",
    `Skill Category count : ${categoryCount}`,
    "",
    input.customPrompt.trim(),
    "",
    `Output structure:`,
    "Return ONLY one valid JSON object (no markdown fences, no commentary).",
    resumeJsonOutputShapeOnly(input.layout),
  ];

  return parts.join("\n");
}

/** Compact JSON shape block (matches Mode-1 render contract). */
function resumeJsonOutputShapeOnly(layout: ResumeTemplateLayout): string {
  // Reuse full contract text; it already includes the shape the user requested.
  return resumeJsonOutputContract(layout);
}
