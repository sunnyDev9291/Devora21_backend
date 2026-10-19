/**
 * Minimal JSON shape only. All content/style rules live in the profile writing prompt.
 */
export function resumeJsonOutputContract(layout: "bullets" | "projects" = "bullets"): string {
  const experienceShape =
    layout === "projects"
      ? `{
      "company": "string — from profile prompt meta",
      "role": "string — from profile prompt meta",
      "dates": "string — MUST equal a template company_period slot",
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
      "company": "string — from profile prompt meta",
      "role": "string — from profile prompt meta",
      "dates": "string — MUST equal a template company_period slot",
      "bullets": ["string"]
    }`;

  return [
    "JSON OUTPUT CONTRACT (mandatory structure):",
    "Return ONLY one valid JSON object (no markdown fences, no commentary).",
    "Exact top-level keys:",
    "{",
    '  "title": "<non-empty string>",',
    '  "summary": "<non-empty string>",',
    '  "skills": "<non-empty string — NOT an array, NOT an object>",',
    '  "fileName": "<optional string>",',
    `  "experiences": [ ${experienceShape} ]`,
    "}",
    "You write: title, summary, skills, fileName, and experience bullets (or project field text).",
    "Company/role come from PROFILE WRITING PROMPT. dates must match template company_period strings.",
    "Only bullets (or project narrative fields) are new DOCX writing; headers stay in the template.",
    layout === "bullets"
      ? "HARD RULE: each experiences[i].bullets.length MUST equal that job's template bullet count. Every bullet non-empty."
      : "HARD RULE: each experience's projects array must match the frozen project names/count.",
    '"skills" must be one string (newlines for category lines).',
    "Do not nest title/summary/skills under personalInfo or content.",
  ].join("\n");
}
