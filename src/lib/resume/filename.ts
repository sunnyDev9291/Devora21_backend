import type { GeneratedResumeContent } from "./types";

function sanitizeBaseName(name: string): string {
  return name
    .replace(/\.docx$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Extract filename pattern hints from custom prompt Instructions. */
export function extractFileNamePatternFromPrompt(customPrompt: string): string | null {
  const text = customPrompt || "";
  const patterns = [
    /file\s*name\s*(?:pattern|format|should(?:\s+be)?)\s*[:\-–]\s*([^\n]+)/i,
    /resume\s*file\s*name\s*[:\-–]\s*([^\n]+)/i,
    /naming\s*(?:pattern|convention)\s*[:\-–]\s*([^\n]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]?.trim()) {
      return m[1].trim();
    }
  }
  return null;
}

function topSkillsFromContent(content: GeneratedResumeContent, n = 3): string {
  const raw = content.skills.replace(/\*\*/g, "");
  const parts = raw
    .split(/[,;\n|/]+/)
    .map((p) => p.replace(/^[^:]+:\s*/, "").trim())
    .filter(Boolean);
  return parts.slice(0, n).join(",");
}

function titleHeadline(title: string): string {
  const beforePipe = title.split("|")[0]?.trim() || title.trim();
  return beforePipe;
}

export function resolveResumeFileName(
  content: GeneratedResumeContent,
  opts: {
    customPrompt: string;
    profileName: string;
  }
): string {
  if (content.fileName?.trim()) {
    return `${sanitizeBaseName(content.fileName)}.docx`;
  }

  const pattern = extractFileNamePatternFromPrompt(opts.customPrompt);
  if (pattern) {
    // Light substitution for common tokens
    const filled = pattern
      .replace(/\{?profileName\}?/gi, opts.profileName || "Candidate")
      .replace(/\{?name\}?/gi, opts.profileName || "Candidate")
      .replace(/\{?role\}?/gi, titleHeadline(content.title))
      .replace(/\{?title\}?/gi, titleHeadline(content.title))
      .replace(/\{?skills?\}?/gi, topSkillsFromContent(content));
    return `${sanitizeBaseName(filled)}.docx`;
  }

  const base = [
    opts.profileName || "Candidate",
    titleHeadline(content.title),
    topSkillsFromContent(content),
  ]
    .filter(Boolean)
    .join("_");

  return `${sanitizeBaseName(base)}.docx`;
}

/** Archive jobTitle = text before first "|" in content.title */
export function archiveJobTitleFromContent(title: string): string {
  return titleHeadline(title) || title.trim() || "Resume";
}
