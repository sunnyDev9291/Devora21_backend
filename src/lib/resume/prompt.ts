import type { ResumeTemplateLayout, TemplateJobSkeleton } from "./types";
import { extractFileNamePatternFromPrompt } from "./filename";
import { resumeJsonOutputContract } from "./output-contract";

/**
 * Priority (highest → lowest) when instructions conflict:
 * 1) JSON shape + template slot counts (backend)
 * 2) PROFILE WRITING PROMPT (wording, company meta, tone)
 * 3) Job description (tailoring target)
 *
 * AI writes ONLY: title, summary, skills, experience bullets/projects, fileName.
 * Company/role/dates meta comes from the PROFILE WRITING PROMPT.
 * DOCX company_period / company_info headers are never overwritten on render.
 */
export function buildResumeSystemPrompt(
  layout: ResumeTemplateLayout,
  profilePrompt: string
): string {
  return [
    "You are generating Mode-1 resume CONTENT for a styled DOCX template.",
    "",
    "PRIORITY when rules conflict:",
    "1) This system contract + template slot counts (mandatory).",
    "2) PROFILE WRITING PROMPT (wording, company meta, tone).",
    "3) Job description (what to emphasize for this application).",
    "",
    "OUTPUT MODE:",
    "- Return ONE JSON object only (no markdown, no preface, no postscript).",
    "- Write ONLY: title, summary, skills, fileName, experiences[].bullets (or projects fields).",
    "- Do NOT invent or change contact/header/education fields — they stay in the DOCX.",
    "",
    "TRUTH / GROUNDING:",
    "- Company name, role, and employment period MUST come from PROFILE WRITING PROMPT company meta.",
    "- Do NOT invent employers, titles, or dates outside that meta.",
    "- Tailor bullets/skills to the JD, but keep work grounded in each company's industry/projects from the meta.",
    "- If the JD stack differs from the candidate's history, map transferable work honestly — do not claim deep expertise the meta cannot support.",
    "",
    "TEMPLATE HARD CONSTRAINTS:",
    "- Skill category LINE COUNT and per-job bullet COUNT are fixed by the user-message slot list.",
    "- For every experience, bullets.length MUST equal that job's template bullet count.",
    "- Every bullet must be a non-empty string.",
    "- experiences[i].dates MUST equal the template company_period string exactly (render match key).",
    "- On render, DOCX company_period / company_info stay unchanged; only new bullet text is filled.",
    "",
    "===== PROFILE WRITING PROMPT (wording + company meta) =====",
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

  blocks.push(
    [
      "TARGET APPLICATION",
      `Job title: ${input.jobTitle}`,
      "Job description (tailor to this; ignore recruiter chat fluff if present):",
      input.jobDescription || "(none provided)",
    ].join("\n")
  );

  const skillSlots = countSkillCategorySlots(input.skillsSample);
  if (input.layout === "bullets") {
    blocks.push(
      [
        "TEMPLATE SKILL SLOTS (FIXED)",
        `Return skills as exactly ${skillSlots} newline-separated lines in the form "Category: item, item, …".`,
        "You may rename categories and rewrite items for this JD; do not change the line count.",
      ].join("\n")
    );
  }

  const namePattern = extractFileNamePatternFromPrompt(input.customPrompt);
  if (namePattern) {
    blocks.push(`FILE NAME HINT FROM PROFILE PROMPT:\n${namePattern}`);
  }

  if (input.layout === "projects") {
    const structureLines = input.jobs.map((job, idx) => {
      const names = job.projectNames.map((n) => `"${n}"`).join(", ");
      return `${idx + 1}. dates="${job.dates}" | fixed project names: ${names}`;
    });
    blocks.push(
      [
        `TEMPLATE EXPERIENCE SLOTS (${input.jobs.length}) — match by dates (company_period)`,
        structureLines.join("\n"),
        "Company/role/dates CONTENT comes from the PROFILE WRITING PROMPT.",
        "Set each experience.dates to the matching template period string (exact).",
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
        `TEMPLATE EXPERIENCE SLOTS (${input.jobs.length}) — MATCH KEY is dates (company_period)`,
        structureLines.join("\n"),
        "Company name / role: from PROFILE WRITING PROMPT meta for that period.",
        "For each slot: set experiences[i].dates to that slot's dates string EXACTLY.",
        `Return exactly ${input.jobs.length} experience entries.`,
        `HARD RULE: ${countSummary}.`,
        "Author every bullet (non-empty). Do not shorten arrays.",
        "Write ONLY new bullets; do not rewrite company_period / company_info (render leaves them alone).",
      ].join("\n")
    );
  }

  blocks.push(
    [
      "RETURN",
      "JSON only with keys: title, summary, skills, fileName (optional), experiences.",
    ].join("\n")
  );

  return blocks.filter((b) => b.trim()).join("\n\n");
}
