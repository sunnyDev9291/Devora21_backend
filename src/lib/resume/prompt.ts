import type { ResumeTemplateLayout, TemplateJobSkeleton } from "./types";
import { extractFileNamePatternFromPrompt } from "./filename";
import { resumeJsonOutputContract } from "./output-contract";

/**
 * AI writes ONLY: title, summary, skills, experience bullets, fileName.
 * Identity / education / company headers stay in the DOCX template.
 */
export function buildResumeSystemPrompt(
  layout: ResumeTemplateLayout,
  profilePrompt: string
): string {
  return [
    "You generate ONLY these resume fields: title, summary, skills, experience bullets, fileName.",
    "Do NOT invent or change header_name, header_title, name, email, phone, LinkedIn, education,",
    "company name, company dates, company role, or company location — those stay fixed in the DOCX template.",
    "Skill category COUNT and bullet COUNT per job are FIXED by the template structure below.",
    "CRITICAL: For every experience, bullets.length MUST equal that job's template bullet count.",
    "Write that many NEW bullets yourself — never fewer, never more, never empty strings.",
    "Follow the PROFILE WRITING PROMPT for wording/tone of the fields you do write.",
    "",
    "===== PROFILE WRITING PROMPT (absolute for wording) =====",
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
      return `${idx + 1}. company="${job.company}" | dates="${job.dates}" | fixed project names: ${names}`;
    });
    blocks.push(
      [
        `Frozen template jobs (${input.jobs.length}) — keep company/dates/project names:`,
        structureLines.join("\n"),
        `Return exactly ${input.jobs.length} experience entries (project field text only).`,
      ].join("\n")
    );
  } else {
    const structureLines = input.jobs.map((job, idx) => {
      return `${idx + 1}. company="${job.company}" | role="${job.role}" | dates="${job.dates}" | bullets.length MUST be ${job.bulletCount}`;
    });
    const countSummary = input.jobs
      .map((job, idx) => `exp[${idx}].bullets.length=${job.bulletCount}`)
      .join(", ");
    blocks.push(
      [
        `Frozen template jobs (${input.jobs.length}) — company/role/dates/location stay in the DOCX:`,
        structureLines.join("\n"),
        `Return exactly ${input.jobs.length} experience entries.`,
        `HARD RULE: ${countSummary}.`,
        "You must AUTHOR each bullet (non-empty). Do not omit bullets or return a shorter array.",
        "For each entry: copy company/role/dates from the frozen list; write ONLY the bullets array",
        "with exactly the required length. Do not change company headers in the document.",
      ].join("\n")
    );
  }

  blocks.push(
    "Also return: title (resume headline), summary, skills, optional fileName."
  );

  return blocks.filter((b) => b.trim()).join("\n\n");
}
