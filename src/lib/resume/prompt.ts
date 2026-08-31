import type { ResumeTemplateLayout, TemplateJobSkeleton } from "./types";
import { extractFileNamePatternFromPrompt } from "./filename";
import { resumeJsonOutputContract } from "./output-contract";

/**
 * System message = profile prompt (writing rules) + JSON output contract.
 * No competing writing prompts — only profile instructions for prose.
 */
export function buildResumeSystemPrompt(
  layout: ResumeTemplateLayout,
  profilePrompt: string
): string {
  return [
    profilePrompt.trim(),
    "",
    resumeJsonOutputContract(layout),
  ].join("\n");
}

/**
 * User message = job + template structure data only.
 */
export function buildResumeUserPrompt(input: {
  jobTitle: string;
  jobDescription: string;
  customPrompt: string;
  layout: ResumeTemplateLayout;
  jobs: TemplateJobSkeleton[];
  skillsSample: string;
}): string {
  const blocks: string[] = [];

  blocks.push(`Job title:\n${input.jobTitle}`);
  blocks.push(`Job description:\n${input.jobDescription || ""}`);

  if (input.skillsSample.trim()) {
    blocks.push(`Template skillsets line (preserve this format):\n${input.skillsSample.trim()}`);
  }

  const namePattern = extractFileNamePatternFromPrompt(input.customPrompt);
  if (namePattern) {
    blocks.push(`File name pattern from profile prompt:\n${namePattern}`);
  }

  const structureLines = input.jobs.map((job, idx) => {
    if (input.layout === "projects") {
      const names = job.projectNames.map((n) => `"${n}"`).join(", ");
      return `${idx + 1}. company="${job.company}" | dates="${job.dates}" | ${job.projectNames.length} project(s), fixed names: ${names}`;
    }
    return `${idx + 1}. company="${job.company}" | dates="${job.dates}" | ${job.bulletCount} bullet(s)`;
  });

  blocks.push(
    `Template structure (${input.jobs.length} job(s) — keep company, dates, project names, and counts):\n${structureLines.join("\n")}\n\nReturn exactly ${input.jobs.length} experience entries. title, summary, and skills must be non-empty.`
  );

  return blocks.filter((b) => b.trim()).join("\n\n");
}
