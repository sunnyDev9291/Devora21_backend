/** System prompt: English-team Yes/No only (not part of resume generation). */
export const ENGLISH_TEAM_SYSTEM_PROMPT = [
  "Analyze the Job Title and Job Description.",
  "Absolute Answer only:",
  "No — only if the Job Title or Job Description mentioned Spanish or Portuguese is required for the role.",
  "Yes — in all other cases.",
  "Output only Yes or No.",
].join("\n");

export function buildEnglishTeamUserMessage(
  jobTitle: string,
  jobDescription: string
): string {
  return [
    `Job title:\n${jobTitle.trim() || "(not provided)"}`,
    "",
    `Job description:\n${jobDescription.trim() || "(empty)"}`,
  ].join("\n");
}

export type EnglishTeamAnswer = "Yes" | "No";

/** Parse model output to Yes/No; returns null if unclear. */
export function parseEnglishTeamAnswer(raw: string): EnglishTeamAnswer | null {
  const text = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text) {
    return null;
  }

  const firstToken = text.split(/\s+/)[0]?.replace(/[^A-Za-z]/g, "") ?? "";
  const normalized = firstToken.toLowerCase();
  if (normalized === "yes") return "Yes";
  if (normalized === "no") return "No";

  // Fallback: whole reply is just Yes/No with punctuation
  const whole = text.replace(/[^A-Za-z]/g, "").toLowerCase();
  if (whole === "yes") return "Yes";
  if (whole === "no") return "No";

  return null;
}
