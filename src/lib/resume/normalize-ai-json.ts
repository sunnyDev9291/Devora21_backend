import { extractJsonObject, parseJsonLenient } from "./json-repair";

/**
 * Coerce model values into a single display string.
 * Models often return skills as string[] or { Category: "a, b" }.
 */
export function coerceTextField(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => coerceTextField(item)).filter(Boolean);
    if (parts.length === 0) return "";
    // Short skill tokens → comma list; longer blocks → newlines
    const short = parts.every((p) => p.length < 60 && !p.includes("\n"));
    return parts.join(short ? ", " : "\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "";
    return entries
      .map(([key, val]) => {
        const text = coerceTextField(val);
        if (!text) return "";
        // Skip numeric keys from weird arrays-as-objects
        if (/^\d+$/.test(key)) return text;
        return `${key}: ${text}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickCoerced(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = coerceTextField(obj[key]);
    if (text) return text;
  }
  return "";
}

/**
 * Normalize whatever Claude returned into the flat resume JSON the frontend expects:
 * { title, summary, skills, experiences?, fileName? }
 */
export function normalizeResumeAiJson(
  rawAiText: string,
  hints?: { jobTitle?: string; jobDescription?: string }
): {
  title: string;
  summary: string;
  skills: string;
  fileName?: string;
  experiences?: unknown[];
  raw: Record<string, unknown>;
} {
  const cleaned = extractJsonObject(rawAiText.trim());
  let parsed: unknown;
  try {
    parsed = parseJsonLenient(cleaned);
  } catch {
    parsed = {};
  }

  const top = asRecord(parsed) ?? {};
  const nested =
    asRecord(top.resume) ||
    asRecord(top.content) ||
    asRecord(top.data) ||
    asRecord(top.result) ||
    asRecord(top.personalInfo) ||
    asRecord(top.personal_info) ||
    null;

  const root: Record<string, unknown> = { ...top, ...(nested ?? {}) };

  // personalInfo may hold summary while title/skills stay at top level
  const personal = asRecord(top.personalInfo) || asRecord(top.personal_info);

  let title =
    pickCoerced(root, [
      "title",
      "jobTitle",
      "job_title",
      "headline",
      "targetTitle",
      "target_title",
      "role",
      "professionalTitle",
      "professional_title",
    ]) ||
    (personal
      ? pickCoerced(personal, ["title", "headline", "role", "professionalTitle"])
      : "");

  let summary =
    pickCoerced(root, [
      "summary",
      "professionalSummary",
      "professional_summary",
      "profile",
      "about",
      "overview",
    ]) ||
    (personal
      ? pickCoerced(personal, ["summary", "professionalSummary", "about", "profile"])
      : "");

  let skills = pickCoerced(root, [
    "skills",
    "skillsets",
    "skillSets",
    "skillsSummary",
    "skill_summary",
    "technologies",
    "techStack",
    "tech_stack",
  ]);

  // skills sometimes only under nested personal block
  if (!skills && personal) {
    skills = pickCoerced(personal, ["skills", "skillsets", "technologies"]);
  }

  const experiences = Array.isArray(root.experiences)
    ? root.experiences
    : Array.isArray(root.experience)
      ? root.experience
      : Array.isArray(top.experiences)
        ? top.experiences
        : Array.isArray(top.experience)
          ? top.experience
          : undefined;

  if (!title && Array.isArray(experiences) && experiences[0]) {
    const first = asRecord(experiences[0]);
    if (first) {
      title = pickCoerced(first, ["role", "title", "jobTitle", "position"]);
    }
  }

  if (!title && hints?.jobTitle?.trim()) {
    title = hints.jobTitle.trim();
  }

  // Last-resort summary from JD opening if model omitted it
  if (!summary && hints?.jobDescription?.trim()) {
    const jd = hints.jobDescription.trim().replace(/\s+/g, " ");
    summary = jd.slice(0, 600);
  }

  // Last-resort skills: pull capitalized tech-like tokens from JD / title
  if (!skills) {
    const corpus = `${title}\n${hints?.jobDescription || ""}`;
    const tokens = corpus.match(
      /\b(?:Python|JavaScript|TypeScript|Java|Go|Rust|C\+\+|C#|Ruby|PHP|Swift|Kotlin|React|Angular|Vue|Node\.?js|Next\.?js|Django|Flask|FastAPI|Spring|AWS|Azure|GCP|Docker|Kubernetes|SQL|PostgreSQL|MySQL|MongoDB|Redis|GraphQL|REST|Kafka|Spark|TensorFlow|PyTorch|LLM|OpenAI|API|CI\/CD|Agile|Scrum)\b/gi
    );
    if (tokens?.length) {
      skills = [...new Set(tokens.map((t) => t.trim()))].slice(0, 16).join(", ");
    }
  }

  const fileName =
    pickCoerced(root, ["fileName", "filename", "file_name"]) || undefined;

  return {
    title: title.trim(),
    summary: summary.trim(),
    skills: skills.trim(),
    ...(fileName ? { fileName } : {}),
    ...(experiences ? { experiences } : {}),
    raw: top,
  };
}

/** Serialize normalized resume fields for the frontend (guaranteed keys). */
export function toFrontendResumeJson(normalized: ReturnType<typeof normalizeResumeAiJson>): string {
  const out: Record<string, unknown> = {
    title: normalized.title,
    summary: normalized.summary,
    skills: normalized.skills,
  };
  if (normalized.fileName) out.fileName = normalized.fileName;
  if (normalized.experiences) out.experiences = normalized.experiences;
  // Preserve extra top-level keys the frontend might still read
  for (const [key, value] of Object.entries(normalized.raw)) {
    if (key in out) continue;
    if (["resume", "content", "data", "result", "personalInfo", "personal_info"].includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return JSON.stringify(out);
}

export function extractJobHintsFromMessages(
  messages: Array<{ role: string; content: string }>
): { jobTitle?: string; jobDescription?: string } {
  const blob = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");

  const titleMatch =
    blob.match(/job\s*title\s*[:\-]\s*(.+)/i) ||
    blob.match(/target\s*role\s*[:\-]\s*(.+)/i) ||
    blob.match(/role\s*[:\-]\s*(.+)/i);
  const jdMatch =
    blob.match(/job\s*description\s*[:\-]\s*([\s\S]+?)(?:\n\s*\n|template structure|file name|$)/i) ||
    blob.match(/\bJD\s*[:\-]\s*([\s\S]+?)(?:\n\s*\n|template structure|$)/i);

  return {
    ...(titleMatch?.[1]?.trim() ? { jobTitle: titleMatch[1].trim().split("\n")[0].trim() } : {}),
    ...(jdMatch?.[1]?.trim() ? { jobDescription: jdMatch[1].trim().slice(0, 4000) } : {}),
  };
}
