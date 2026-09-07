/** System prompt: English-team Yes/No only (not part of resume generation). */
export const ENGLISH_TEAM_SYSTEM_PROMPT = [
  "At first, Analyze the Job Title and Job Description internally.",
  "Answer only:",
  "Yes — if the job mainly requires working in English with a US or global/international team.",
  "No — if the job requires Spanish, Portuguese, or another non-English language for work.",
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
