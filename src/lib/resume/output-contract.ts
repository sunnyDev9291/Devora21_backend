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
    'Put company/dates from the frozen template jobs. Put role/bullets/projects text per the profile writing prompt.',
    '"skills" must be one string (use newlines inside it if the profile prompt uses category lines).',
    "Do not nest title/summary/skills under personalInfo or content.",
  ].join("\n");
}
