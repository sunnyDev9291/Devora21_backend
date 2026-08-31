import type { ChatCompletionsInput } from "../validators/ai.validator";

export const MOCK_AI_MODEL = "mock-resume-v1";

const MOCK_RESUME_JSON = {
  personalInfo: {
    fullName: "Alex Morgan",
    email: "alex.morgan@example.com",
    phone: "+1 (555) 010-2030",
    location: "San Francisco, CA",
    linkedin: "linkedin.com/in/alexmorgan",
    summary:
      "Results-driven software engineer with 6+ years building scalable web platforms. Experienced in TypeScript, React, and Node.js with a strong focus on product delivery and clean architecture.",
  },
  experience: [
    {
      company: "Northstar Labs",
      title: "Senior Software Engineer",
      location: "Remote",
      startDate: "2022-03",
      endDate: "Present",
      bullets: [
        "Led redesign of resume generation pipeline, cutting average document build time by 40%.",
        "Built TypeScript/Node services handling 2M+ monthly API requests with 99.9% uptime.",
        "Partnered with product and design to ship AI-assisted editing features used by 15k users.",
      ],
    },
    {
      company: "BrightForge",
      title: "Software Engineer",
      location: "Austin, TX",
      startDate: "2019-06",
      endDate: "2022-02",
      bullets: [
        "Developed React dashboards and REST APIs for customer onboarding workflows.",
        "Improved CI reliability and reduced failed deploys by introducing automated integration tests.",
      ],
    },
  ],
  education: [
    {
      school: "University of Texas",
      degree: "B.S. Computer Science",
      endDate: "2019",
    },
  ],
  skills: [
    "TypeScript",
    "JavaScript",
    "React",
    "Node.js",
    "PostgreSQL",
    "Express",
    "REST APIs",
    "Git",
  ],
  mock: true,
  note: "This is a mocked AI resume response for local/dev testing.",
};

function lastUserMessage(input: ChatCompletionsInput): string {
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    if (input.messages[i].role === "user") {
      return input.messages[i].content;
    }
  }
  return "";
}

export function buildMockResumeContent(input: ChatCompletionsInput): string {
  const userText = lastUserMessage(input).slice(0, 500);

  if (input.jsonObject) {
    return JSON.stringify(
      {
        ...MOCK_RESUME_JSON,
        requestEcho: userText || undefined,
      },
      null,
      2
    );
  }

  return [
    "MOCK RESUME (AI disabled)",
    "",
    "Alex Morgan — Senior Software Engineer",
    "San Francisco, CA | alex.morgan@example.com",
    "",
    "SUMMARY",
    MOCK_RESUME_JSON.personalInfo.summary,
    "",
    "EXPERIENCE",
    "Senior Software Engineer @ Northstar Labs (2022–Present)",
    "- Led resume generation pipeline improvements (-40% build time).",
    "- Built TypeScript/Node services for high-volume APIs.",
    "",
    "Software Engineer @ BrightForge (2019–2022)",
    "- Shipped React dashboards and onboarding APIs.",
    "",
    "SKILLS",
    MOCK_RESUME_JSON.skills.join(", "),
    "",
    userText ? `Request echo: ${userText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function createMockChatCompletion(
  input: ChatCompletionsInput
): Promise<{ content: string; model: string }> {
  // Small delay so the frontend can still exercise loading UI.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return {
    content: buildMockResumeContent(input),
    model: MOCK_AI_MODEL,
  };
}

export async function streamMockChatCompletion(
  input: ChatCompletionsInput,
  onText: (text: string) => void
): Promise<void> {
  const content = buildMockResumeContent(input);
  const chunkSize = 48;

  for (let i = 0; i < content.length; i += chunkSize) {
    onText(content.slice(i, i + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
