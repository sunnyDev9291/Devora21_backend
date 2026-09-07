import { claudeEnabled } from "../config/env";
import {
  buildEnglishTeamUserMessage,
  ENGLISH_TEAM_SYSTEM_PROMPT,
  parseEnglishTeamAnswer,
  type EnglishTeamAnswer,
} from "../lib/job-check/english-team";
import { AppError } from "../middleware/errorHandler";
import { createChatCompletion } from "./claude.service";

export const ENGLISH_TEAM_REQUIRED_CODE = "ENGLISH_TEAM_REQUIRED";

export const ENGLISH_TEAM_BLOCKED_MESSAGE =
  "This job does not appear to require working with an English / US / global team. Resume generation was blocked.";

const ENGLISH_TEAM_MAX_TOKENS = 16;

export type EnglishTeamCheckResult = {
  answer: EnglishTeamAnswer;
  workWithEnglishTeam: boolean;
};

/** Run Claude Yes/No English-team analysis for a job posting. */
export async function evaluateEnglishTeam(
  jobTitle: string,
  jobDescription: string
): Promise<EnglishTeamCheckResult> {
  if (!claudeEnabled) {
    throw new AppError(503, "Claude API is not configured");
  }

  const title = jobTitle.trim();
  const description = jobDescription.trim();
  if (!title && !description) {
    throw new AppError(400, "jobTitle or jobDescription is required");
  }

  const { content } = await createChatCompletion({
    maxTokens: ENGLISH_TEAM_MAX_TOKENS,
    jsonObject: false,
    messages: [
      { role: "system", content: ENGLISH_TEAM_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildEnglishTeamUserMessage(title, description),
      },
    ],
  });

  const answer = parseEnglishTeamAnswer(content);
  if (!answer) {
    throw new AppError(502, "English-team check returned an invalid answer.");
  }

  return {
    answer,
    workWithEnglishTeam: answer === "Yes",
  };
}

/**
 * Gate resume generation: Yes continues; No throws ENGLISH_TEAM_REQUIRED (422).
 * When skip is true (user confirmed Continue creating), bypass without calling Claude.
 */
export async function assertWorksWithEnglishTeam(
  jobTitle: string,
  jobDescription: string,
  options?: {
    skip?: boolean;
    userId?: string;
    context?: string;
  }
): Promise<EnglishTeamCheckResult | null> {
  if (options?.skip) {
    console.log(
      `[english-team] skip gate user=${options.userId ?? "unknown"} context=${options.context ?? "resume"} title=${JSON.stringify(jobTitle.trim().slice(0, 120))} at=${new Date().toISOString()}`
    );
    return null;
  }

  const result = await evaluateEnglishTeam(jobTitle, jobDescription);
  if (!result.workWithEnglishTeam) {
    throw new AppError(422, ENGLISH_TEAM_BLOCKED_MESSAGE, undefined, ENGLISH_TEAM_REQUIRED_CODE, {
      answer: "No",
      workWithEnglishTeam: false,
      message: ENGLISH_TEAM_BLOCKED_MESSAGE,
    });
  }
  return result;
}

export function isEnglishTeamBlockedError(message: string | null | undefined): boolean {
  return message === ENGLISH_TEAM_BLOCKED_MESSAGE;
}
