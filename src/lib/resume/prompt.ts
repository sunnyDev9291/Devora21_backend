import type { ResumeTemplateLayout, TemplateJobSkeleton } from "./types";
import { extractFileNamePatternFromPrompt } from "./filename";
import { resumeJsonOutputContract } from "./output-contract";

/**
 * System = profile / writing prompt ONLY for all content & style decisions
 * (skills, summary, bullets, counts, categories, wording).
 * Plus a minimal JSON shape contract — no competing writing rules.
 */
export function buildResumeSystemPrompt(
  layout: ResumeTemplateLayout,
  profilePrompt: string
): string {
  return [
    "Follow the PROFILE WRITING PROMPT below absolutely for ALL resume sections",
    "(title, summary, skills categories/items, experience bullets, wording, counts, order).",
    "Do not invent extra style rules. Job description and template data in the user message",
    "are inputs only — they must not override the profile writing prompt.",
    "",
    "===== PROFILE WRITING PROMPT (absolute) =====",
    profilePrompt.trim(),
    "===== END PROFILE WRITING PROMPT =====",
    "",
    resumeJsonOutputContract(layout),
  ].join("\n");
}

/**
 * User message = factual job + frozen template structure only.
 * No writing-style instructions here (those live only in the profile prompt).
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

  // Layout hint only — never paste template category names or counts.
  void input.skillsSample;
  if (input.layout === "bullets") {
    blocks.push(
      "Template layout hint: skills are category-style lines in the DOCX (Label: items). Follow the profile writing prompt for which categories and how many."
    );
  }

  const namePattern = extractFileNamePatternFromPrompt(input.customPrompt);
  if (namePattern) {
    blocks.push(`File name pattern from profile prompt:\n${namePattern}`);
  }

  const structureLines = input.jobs.map((job, idx) => {
    if (input.layout === "projects") {
      const names = job.projectNames.map((n) => `"${n}"`).join(", ");
      return `${idx + 1}. company="${job.company}" | dates="${job.dates}" | fixed project names: ${names}`;
    }
    const loc =
      job.locationParaIndex !== undefined ? " | location line frozen from template" : "";
    return `${idx + 1}. company="${job.company}" | dates="${job.dates}"${loc}`;
  });

  blocks.push(
    [
      `Frozen template jobs (${input.jobs.length}) — keep company, dates, location, and project names unchanged:`,
      structureLines.join("\n"),
      `Return exactly ${input.jobs.length} experience entries.`,
      "All wording, skill categories, bullet counts, and lengths: follow the profile writing prompt only.",
    ].join("\n")
  );

  return blocks.filter((b) => b.trim()).join("\n\n");
}
