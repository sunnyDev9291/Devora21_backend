import { AppError } from "../middleware/errorHandler";
import { writeLastResumeAiPayloadLog } from "../lib/resume/debug-payload-log";
import { parseResumeTemplate } from "../lib/resume/parse-template";
import { buildResumeUserPrompt } from "../lib/resume/prompt";
import { resolveWritingPrompt } from "../lib/resume/resolve-writing-prompt";
import type { ParsedResumeTemplate } from "../lib/resume/types";
import {
  loadResumeTemplateForUser,
  type StoredResumeTemplate,
} from "./resume-template.service";

export type ResumeGeneratePromptBundle = {
  /** Canonical Claude messages — same for web stream and one-click. */
  messages: Array<{ role: "system" | "user"; content: string }>;
  writingPrompt: string;
  writingPromptSource: string;
  storedTemplate: StoredResumeTemplate;
  parsedTemplate: ParsedResumeTemplate;
  profileName: string;
  jobTitle: string;
  jobDescription: string;
};

/**
 * Shared Mode-1 generate setup for:
 * - Web UI: POST /ai/chat/completions (jsonObject:true)
 * - One-click: POST /resume/from-job (after scrape)
 *
 * Single user message: Job title → JD → template slot counts → profile prompt → JSON shape.
 * FE messages are not used for resume generation.
 */
export async function buildResumeGeneratePrompt(input: {
  userId: string;
  jobTitle: string;
  jobDescription: string;
  templateId?: string | null;
  customPrompt?: string | null;
  profilePrompt?: string | null;
  promptContent?: string | null;
  context: string;
}): Promise<ResumeGeneratePromptBundle> {
  const jobTitle = input.jobTitle.trim();
  const jobDescription = input.jobDescription.trim();
  if (!jobTitle && !jobDescription) {
    throw new AppError(
      400,
      "jobTitle or jobDescription is required for resume generation"
    );
  }

  let storedTemplate: StoredResumeTemplate;
  try {
    storedTemplate = await loadResumeTemplateForUser({
      userId: input.userId,
      templateId: input.templateId,
      requireActive: true,
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(
        422,
        "Resume template not found. Upload a styled DOCX template in your profile."
      );
    }
    throw err;
  }

  const parsedTemplate = parseResumeTemplate(storedTemplate.buffer);
  if (parsedTemplate.mode !== "styled" || !parsedTemplate.jobs.length) {
    throw new AppError(
      422,
      "Resume template must be styled Mode-1 with company experience slots (company_period / company_info + exp_section)."
    );
  }

  const resolved = await resolveWritingPrompt({
    userId: input.userId,
    customPrompt: input.customPrompt,
    profilePrompt: input.profilePrompt,
    promptContent: input.promptContent,
    context: input.context,
  });

  const user = buildResumeUserPrompt({
    jobTitle: jobTitle || "Target role",
    jobDescription,
    customPrompt: resolved.content,
    layout: parsedTemplate.layout,
    jobs: parsedTemplate.jobs,
    skillsSample: parsedTemplate.skillsSample,
  });

  const profileName = parsedTemplate.profileName?.trim() || "Candidate";
  const messages: ResumeGeneratePromptBundle["messages"] = [
    { role: "user", content: user },
  ];

  console.log(
    `[resume/generate] context=${input.context} templateId=${storedTemplate.templateId} jobs=${parsedTemplate.jobs.length} bullets=${parsedTemplate.jobs.map((j) => j.bulletCount).join(",")} skillLines=${parsedTemplate.skillsSample.split(/\r?\n/).filter(Boolean).length} promptMode=single-user`
  );

  writeLastResumeAiPayloadLog({
    at: new Date().toISOString(),
    context: input.context,
    userId: input.userId,
    jobTitle: jobTitle || "Target role",
    jobDescriptionChars: jobDescription.length,
    templateId: storedTemplate.templateId,
    writingPromptSource: resolved.source,
    messages,
  });

  return {
    messages,
    writingPrompt: resolved.content,
    writingPromptSource: resolved.source,
    storedTemplate,
    parsedTemplate,
    profileName,
    jobTitle: jobTitle || "Target role",
    jobDescription,
  };
}
