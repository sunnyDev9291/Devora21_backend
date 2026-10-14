import type { ResumeTemplateLayout, TemplateJobSkeleton } from "./types";
import { extractFileNamePatternFromPrompt } from "./filename";
import { resumeJsonOutputContract } from "./output-contract";

/**
 * AI writes ONLY: title, summary, skills, experience bullets, fileName.
 * Company/role/dates meta comes from the PROFILE WRITING PROMPT.
 * DOCX company_period / company_info headers are never overwritten on render.
 */
export function buildResumeSystemPrompt(
  layout: ResumeTemplateLayout,
  profilePrompt: string
): string {
  return [
    "You generate ONLY these resume fields: title, summary, skills, experience bullets, fileName.",
    "Do NOT invent or change header_name, header_title, name, email, phone, LinkedIn, or education — those stay in the DOCX.",
    "Company name, role, and employment dates MUST come from the PROFILE WRITING PROMPT (work history / company meta),",
    "NOT from sample text in the DOCX template.",
    "On render, company_period / company_info in the DOCX stay unchanged; only experience bullets are written into slots.",
    "Skill category COUNT and bullet COUNT per job are FIXED by the template structure below.",
    "CRITICAL: For every experience, bullets.length MUST equal that job's template bullet count.",
    "Write that many NEW bullets yourself — never fewer, never more, never empty strings.",
    "Follow the PROFILE WRITING PROMPT for wording/tone and for which companies/roles/dates to use.",
    "",
    "===== PROFILE WRITING PROMPT (absolute for wording + company meta) =====",
    profilePrompt.trim(),
    "===== END PROFILE WRITING PROMPT =====",
    "",
    resumeJsonOutputContract(layout),
  ].join("\n");
}

function countSkillCategorySlots(skillsSample: string): number {
  const lines = skillsSample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return Math.max(lines.length, 1);
}

export function buildResumeUserPrompt(input: {
  jobTitle: string;
  jobDescription: string;
  customPrompt: string;
  layout: ResumeTemplateLayout;
  jobs: TemplateJobSkeleton[];
  skillsSample: string;
}): string {
  const blocks: string[] = [];

  blocks.push(`Target job title (for tailoring):\n${input.jobTitle}`);
  blocks.push(`Job description:\n${input.jobDescription || ""}`);

  const skillSlots = countSkillCategorySlots(input.skillsSample);
  if (input.layout === "bullets") {
    blocks.push(
      [
        `Template skill slots (FIXED): exactly ${skillSlots} "Label: items" line(s) in skills.`,
        "Rewrite category labels/items for this job; do not change the line count.",
      ].join("\n")
    );
  }

  const namePattern = extractFileNamePatternFromPrompt(input.customPrompt);
  if (namePattern) {
    blocks.push(`File name pattern from profile prompt:\n${namePattern}`);
  }

  if (input.layout === "projects") {
    const structureLines = input.jobs.map((job, idx) => {
      const names = job.projectNames.map((n) => `"${n}"`).join(", ");
      return `${idx + 1}. dates="${job.dates}" | fixed project names: ${names}`;
    });
    blocks.push(
      [
        `Template experience slots (${input.jobs.length}) — match by dates (company_period):`,
        structureLines.join("\n"),
        "Company/role/dates CONTENT comes from the PROFILE WRITING PROMPT.",
        `Set each experience.dates to the matching template period string (exact).`,
        `Return exactly ${input.jobs.length} experience entries (project field text only).`,
      ].join("\n")
    );
  } else {
    const structureLines = input.jobs.map((job, idx) => {
      return `${idx + 1}. dates="${job.dates}" | bullets.length MUST be ${job.bulletCount}`;
    });
    const countSummary = input.jobs
      .map((job, idx) => `exp[${idx}].bullets.length=${job.bulletCount}`)
      .join(", ");
    blocks.push(
      [
        `Template experience slots (${input.jobs.length}) — MATCH KEY is dates (company_period in the DOCX):`,
        structureLines.join("\n"),
        "Company name / role / employment story: take from the PROFILE WRITING PROMPT, not from the template sample text.",
        "For each slot: set experiences[i].dates to that slot's dates string EXACTLY (needed to place bullets on render).",
        "Fill company and role from the profile prompt meta that belongs to that period.",
        `Return exactly ${input.jobs.length} experience entries.`,
        `HARD RULE: ${countSummary}.`,
        "You must AUTHOR each bullet (non-empty). Do not omit bullets or return a shorter array.",
        "Write ONLY new bullets for each slot. Do not change company_period / company_info in the document (render leaves them alone).",
      ].join("\n")
    );
  }

  blocks.push(
    "Also return: title (resume headline), summary, skills, optional fileName."
  );

  return blocks.filter((b) => b.trim()).join("\n\n");
}
