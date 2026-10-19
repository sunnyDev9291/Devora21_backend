/**
 * Minimal JSON shape only. All content/style rules live in the profile writing prompt.
 * Key order = create order: title → summary → experiences → skills → fileName.
 */
export function resumeJsonOutputContract(layout: "bullets" | "projects" = "bullets"): string {
  const experienceShape =
    layout === "projects"
      ? `{
      "company": "string — from profile prompt meta",
      "role": "string — from profile prompt meta",
      "dates": "string — from profile prompt meta",
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
      "dates": "string — from profile prompt meta",
      "bullets": ["string"]
    }`;

  return [
    "Create fields in this exact order: title → summary → experiences → skills → fileName.",
    "{",
    '  "title": "<non-empty string>",',
    '  "summary": "<non-empty string>",',
    `  "experiences": [ ${experienceShape} ],`,
    '  "skills": {',
    '    "<CategoryName>": ["item", "item", "..."],',
    '    "<CategoryName2>": ["item", "item", "..."]',
    "  },",
    '  "fileName": "<non-empty string>"',
    "}",
    '"skills" MUST be one object (NOT a string, NOT an array). Keys = category names. Values = string arrays of tech items.',
    "Category key count MUST equal Skill Category count from the template section above.",
  ].join("\n");
}
