/**
 * Minimal JSON shape only. All content/style rules live in the profile writing prompt.
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
    "JSON OUTPUT SHAPE (structural only — content follows the profile writing prompt):",
    "Return ONLY one valid JSON object (no markdown fences, no commentary).",
    "Use EXACTLY these top-level keys:",
    "{",
    '  "title": "<non-empty string>",',
    '  "summary": "<non-empty string>",',
    '  "skills": "<non-empty string — NOT an array, NOT an object>",',
    '  "fileName": "<optional string>",',
    `  "experiences": [ ${experienceShape} ]`,
    "}",
    "You write: title, summary, skills, fileName, and experience bullets (or project field text).",
    "For each experience, copy company/role/dates from the frozen template jobs list;",
    "only the bullets (or project narrative fields) are new writing.",
    layout === "bullets"
      ? "HARD RULE: each experiences[i].bullets array length MUST equal that job's template bullet count (see frozen jobs list). Every bullet string non-empty."
      : "HARD RULE: each experience's projects array must match the frozen project names/count.",
    '"skills" must be one string (newlines for category lines).',
    "Do not nest title/summary/skills under personalInfo or content.",
  ].join("\n");
}
