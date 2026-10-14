import type {
  GeneratedResumeContent,
  ResumeExperience,
  ResumeProject,
  ResumeTemplateLayout,
  TemplateJobSkeleton,
} from "./types";
import {
  boldSkillTermsWholeToken,
  collectSkillTermsFromSkillsBlock,
  formatSkillsToTemplateStyle,
} from "./skills-style";
import { resolveResumeFileName } from "./filename";
import { normalizeResumeAiJson } from "./normalize-ai-json";
import { stripMarkdownBoldMarkers } from "./xml-utils";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

/** Keep empty strings so bullet indices stay aligned with template slots. */
function asBulletArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x));
}

function normalizeProject(raw: unknown): ResumeProject | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = asString(o.name);
  if (!name) return null;
  return {
    name,
    businessChallenge: asString(o.businessChallenge) || asString(o.business_challenge),
    assignedResponsibility:
      asString(o.assignedResponsibility) || asString(o.assigned_responsibility),
    action: asString(o.action),
    result: asString(o.result),
  };
}

function normalizeExperience(raw: unknown, layout: ResumeTemplateLayout): ResumeExperience | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const company = asString(o.company);
  const role = asString(o.role) || asString(o.title);
  const dates = asString(o.dates) || asString(o.date);
  const bullets = asBulletArray(o.bullets);
  const projectsRaw = Array.isArray(o.projects) ? o.projects : [];
  const projects = projectsRaw
    .map(normalizeProject)
    .filter((p): p is ResumeProject => Boolean(p));

  if (layout === "projects") {
    return { company, role, dates, bullets, projects };
  }
  return { company, role, dates, bullets, projects: projects.length ? projects : undefined };
}

export function isValidResumeContent(content: GeneratedResumeContent): boolean {
  return Boolean(
    content.title?.trim() &&
      content.summary?.trim() &&
      content.skills?.trim() &&
      Array.isArray(content.experiences) &&
      content.experiences.length >= 1
  );
}

/**
 * Prefer AI bullets; if the model under/over-shoots, pad from template samples
 * and clip so length === template bulletCount. DOCX slot count always wins.
 */
export function fitBulletsToTemplateJob(
  aiBullets: string[] | undefined,
  job: TemplateJobSkeleton
): string[] {
  const need = job.bulletCount;
  const samples = job.bulletSamples ?? [];
  const fromAi = [...(aiBullets ?? [])].map((b) => String(b ?? "").trim());
  const fitted: string[] = [];
  for (let i = 0; i < need; i += 1) {
    fitted.push(fromAi[i] || samples[i] || "");
  }
  return fitted;
}

/** Normalize company_period / experience.dates for slot matching. */
export function normalizePeriodKey(dates: string): string {
  return String(dates ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "")
    .replace(/\./g, "");
}

/**
 * Match AI experience to a template job by company_period (dates).
 * Falls back to first unused AI entry if period miss (keeps render working).
 */
function findAiExperienceForJob(
  aiExps: ResumeExperience[],
  job: TemplateJobSkeleton,
  jobIndex: number,
  used: Set<number>
): ResumeExperience | undefined {
  const key = normalizePeriodKey(job.dates);
  if (key) {
    for (let i = 0; i < aiExps.length; i += 1) {
      if (used.has(i)) continue;
      if (normalizePeriodKey(aiExps[i].dates) === key) {
        used.add(i);
        return aiExps[i];
      }
    }
  }
  for (let i = 0; i < aiExps.length; i += 1) {
    if (used.has(i)) continue;
    used.add(i);
    console.warn(
      `[resume] period match miss for slot[${jobIndex}] dates="${job.dates}"; fallback AI exp[${i}] dates="${aiExps[i].dates}"`
    );
    return aiExps[i];
  }
  return undefined;
}

/**
 * Mode 1: match AI experiences to template slots by company_period (dates).
 * Only bullets (or project field text) are taken for DOCX fill.
 * company_info / company_period in the DOCX are never overwritten.
 * Company/role in the returned JSON prefer AI (profile-prompt meta).
 */
export function mergeWithTemplateSkeleton(
  ai: GeneratedResumeContent,
  jobs: TemplateJobSkeleton[],
  layout: ResumeTemplateLayout
): GeneratedResumeContent {
  const used = new Set<number>();
  const experiences: ResumeExperience[] = jobs.map((job, i) => {
    const src = findAiExperienceForJob(ai.experiences ?? [], job, i, used);
    if (layout === "projects") {
      const aiProjects = src?.projects ?? [];
      const projects: ResumeProject[] = job.projectNames.map((name, pi) => {
        const fromAi = aiProjects[pi];
        return {
          name, // frozen from template
          businessChallenge: fromAi?.businessChallenge ?? "",
          assignedResponsibility: fromAi?.assignedResponsibility ?? "",
          action: fromAi?.action ?? "",
          result: fromAi?.result ?? "",
        };
      });
      return {
        company: src?.company?.trim() || job.company,
        role: src?.role?.trim() || job.role,
        dates: job.dates,
        bullets: [],
        projects,
      };
    }

    const fromAi = [...(src?.bullets ?? [])].map((b) => b.trim());
    if (fromAi.length !== job.bulletCount) {
      console.warn(
        `[resume] exp[${i}] period="${job.dates}": AI wrote ${fromAi.length} bullet(s); template needs ${job.bulletCount} — pad/clip from template`
      );
    }

    return {
      company: src?.company?.trim() || job.company,
      role: src?.role?.trim() || job.role,
      // Canonical template period so re-render matching stays stable.
      dates: job.dates,
      bullets: fitBulletsToTemplateJob(src?.bullets, job),
    };
  });

  return { ...ai, layout, experiences };
}

/** Pad/clip skills lines to template sample category count (Mode 1). */
export function fitSkillsToTemplateSlotCount(
  skills: string,
  skillsSample: string
): string {
  const sampleLines = skillsSample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const slotCount = Math.max(sampleLines.length, 1);
  const lines = skills
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  while (lines.length < slotCount) lines.push("");
  return lines.slice(0, slotCount).join("\n");
}

export function applyContentPostProcess(
  content: GeneratedResumeContent,
  opts: {
    layout: ResumeTemplateLayout;
    skillsSample: string;
    customPrompt: string;
    profileName: string;
  }
): GeneratedResumeContent {
  let next: GeneratedResumeContent = {
    ...content,
    layout: opts.layout,
    title: content.title?.trim() ?? "",
    summary: content.summary?.trim() ?? "",
    skills: content.skills?.trim() ?? "",
    experiences: content.experiences ?? [],
  };

  next.skills = formatSkillsToTemplateStyle(next.skills, opts.skillsSample, opts.layout);
  next.skills = fitSkillsToTemplateSlotCount(next.skills, opts.skillsSample);

  const skillTerms = collectSkillTermsFromSkillsBlock(next.skills);
  // Keyword bold (**term**) only in experience bullet sentences at render time.
  next.summary = stripMarkdownBoldMarkers(next.summary);
  next.title = stripMarkdownBoldMarkers(next.title);
  next.skills = stripMarkdownBoldMarkers(next.skills);
  next.experiences = next.experiences.map((exp) => ({
    ...exp,
    role: stripMarkdownBoldMarkers(exp.role),
    bullets: exp.bullets.map((b) => boldSkillTermsWholeToken(b, skillTerms)),
    projects: exp.projects?.map((p) => ({
      ...p,
      businessChallenge: stripMarkdownBoldMarkers(p.businessChallenge),
      assignedResponsibility: stripMarkdownBoldMarkers(p.assignedResponsibility),
      action: stripMarkdownBoldMarkers(p.action),
      result: stripMarkdownBoldMarkers(p.result),
    })),
  }));

  next.fileName = resolveResumeFileName(next, {
    customPrompt: opts.customPrompt,
    profileName: opts.profileName,
  }).replace(/\.docx$/i, "");

  return next;
}

export function parseAndFinalizeResumeJson(
  rawAiText: string,
  opts: {
    layout: ResumeTemplateLayout;
    jobs: TemplateJobSkeleton[];
    skillsSample: string;
    customPrompt: string;
    profileName: string;
  }
): GeneratedResumeContent {
  const normalized = normalizeResumeAiJson(rawAiText);
  const layout = opts.layout;

  const experiencesRaw = Array.isArray(normalized.experiences)
    ? normalized.experiences
    : [];

  let content: GeneratedResumeContent = {
    title: normalized.title,
    summary: normalized.summary,
    skills: normalized.skills,
    fileName: normalized.fileName,
    layout,
    experiences: experiencesRaw
      .map((e) => normalizeExperience(e, layout))
      .filter((e): e is ResumeExperience => Boolean(e)),
  };

  // If title still blank, fall back to first experience role
  if (!content.title.trim() && content.experiences[0]?.role) {
    content.title = content.experiences[0].role;
  }

  content = mergeWithTemplateSkeleton(content, opts.jobs, layout);
  content = applyContentPostProcess(content, opts);

  if (!isValidResumeContent(content)) {
    const missing: string[] = [];
    if (!content.title?.trim()) missing.push("title");
    if (!content.summary?.trim()) missing.push("summary");
    if (!content.skills?.trim()) missing.push("skills");
    if (!content.experiences?.length) missing.push("experiences");
    throw new Error(
      `Incomplete AI resume JSON after repair (missing: ${missing.join(", ") || "unknown"})`
    );
  }

  // Frontend build route runs post-process again before applyContentToDocx
  content = applyContentPostProcess(content, opts);
  return content;
}
