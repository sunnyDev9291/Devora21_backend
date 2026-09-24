import { claudeEnabled } from "../config/env";
import {
  buildEnglishTeamUserMessage,
  ENGLISH_TEAM_SYSTEM_PROMPT,
  parseEnglishTeamAnswer,
  type EnglishTeamAnswer,
} from "../lib/job-check/english-team";
import { AppError } from "../middleware/errorHandler";
import { createChatCompletion } from "./claude.service";

const ENGLISH_TEAM_MAX_TOKENS = 16;

export type EnglishTeamCheckResult = {
  answer: EnglishTeamAnswer;
  workWithEnglishTeam: boolean;
};

/**
 * Optional informational Yes/No analysis for POST /jobs/check/english-team.
 * Not used as a hard gate on resume creation.
 */
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
