import {
  extractSkillItemCountRange,
  buildResumeUserPrompt,
} from "../src/lib/resume/prompt";

const p = `4. SKILLS
SKILLS COUNT (MANDATORY)
- Across all 8 lines, total concrete tech items MUST be 50–54.
`;

console.log("range", extractSkillItemCountRange(p));

const u = buildResumeUserPrompt({
  jobTitle: "x",
  jobDescription: "y",
  customPrompt: p,
  layout: "bullets",
  jobs: [{ dates: "a", bulletCount: 2, projectNames: [] }],
  skillsSample: "a\nb\nc\nd\ne\nf\ng\nh",
});

console.log("hasSkillItemLine", u.includes("Skill item count :"));
console.log("hasProfileLabel", u.includes("Profile prompt:"));
console.log(u.includes("Job title :"));
// Output JSON shape lives in the profile prompt — backend must not append it.
console.log("backendAppendsOutputStructure", u.includes("Output structure:"));
