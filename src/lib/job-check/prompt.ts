/** Fallback when JOB_CHECK_SYSTEM_PROMPT is unset. */
export const DEFAULT_JOB_CHECK_SYSTEM_PROMPT =
  "After analyzing the company, job description, and the client company if mentioned from the JD with also web search,  let me know main work language as possible as you can guess(output), and then explain the company, the client company(if mentioned)(output).";

export function buildJobCheckUserMessage(
  jobTitle: string,
  companyName: string,
  jobDescription: string
): string {
  return [
    `Job title: ${jobTitle || "(not provided)"}`,
    "",
    `Employer company name: ${companyName}`,
    "",
    "Job description:",
    jobDescription.trim() || "(empty)",
  ].join("\n");
}
