/**
 * Shared resume JSON contract appended after the profile prompt.
 * Writing style/content rules stay in the profile prompt only;
 * this block only forces a parseable, complete JSON shape.
 */
export function resumeJsonOutputContract(layout: "bullets" | "projects" = "bullets"): string {
  const experienceShape =
    layout === "projects"
      ? `{
      "company": "string",
      "role": "string",
      "dates": "string",
      "projects": [
        {
          "name": "string",
          "businessChallenge": "string",
          "assignedResponsibility": "string",
          "action": "string",
          "result": "string"
        }
      ]
    }`
      : `{
      "company": "string",
      "role": "string",
      "dates": "string",
      "bullets": ["string"]
    }`;

  return [
    "OUTPUT CONTRACT (required — do not skip; follow the profile prompt for all wording):",
    "Return ONLY one valid JSON object (no markdown fences, no commentary).",
    "Use EXACTLY these top-level keys:",
    '{',
    '  "title": "<non-empty string>",',
    '  "summary": "<non-empty string>",',
    '  "skills": "<non-empty string — NOT an array, NOT an object>",',
    '  "fileName": "<optional string>",',
    `  "experiences": [ ${experienceShape} ]`,
    "}",
    "CRITICAL:",
    '- "title", "summary", and "skills" MUST be non-empty strings.',
    '- "skills" MUST be a single string (use newlines or commas inside the string). Never return skills as a JSON array.',
    "- Do not nest title/summary/skills under personalInfo or content.",
    "- Do not leave these fields blank.",
  ].join("\n");
}
