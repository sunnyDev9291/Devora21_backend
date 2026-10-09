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

/**
 * Mode 1: company/role/dates frozen from template. AI supplies bullets only
 * (and project field text for projects layout).
 * Bullet counts: AI preferred; template pad/clip if the model errs.
 */
export function mergeWithTemplateSkeleton(
  ai: GeneratedResumeContent,
  jobs: TemplateJobSkeleton[],
  layout: ResumeTemplateLayout
): GeneratedResumeContent {
  const experiences: ResumeExperience[] = jobs.map((job, i) => {
    const src = ai.experiences[i];
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
        company: job.company,
        role: job.role,
        dates: job.dates,
        bullets: [],
        projects,
      };
    }

    const fromAi = [...(src?.bullets ?? [])].map((b) => b.trim());
    if (fromAi.length !== job.bulletCount) {
      console.warn(
        `[resume] exp[${i}] "${job.company}": AI wrote ${fromAi.length} bullet(s); template needs ${job.bulletCount} — pad/clip from template`
      );
    }

    return {
      company: job.company,
      role: job.role,
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
  next.summary = boldSkillTermsWholeToken(next.summary, skillTerms);
  next.title = boldSkillTermsWholeToken(next.title, skillTerms);
  // Do NOT markdown-bold the skills block — Franco values are regular weight;
  // only the category label is bolded in DOCX XML.
  next.skills = next.skills.replace(/\*\*/g, "");
  next.experiences = next.experiences.map((exp) => ({
    ...exp,
    role: boldSkillTermsWholeToken(exp.role, skillTerms),
    bullets: exp.bullets.map((b) => boldSkillTermsWholeToken(b, skillTerms)),
    projects: exp.projects?.map((p) => ({
      ...p,
      businessChallenge: boldSkillTermsWholeToken(p.businessChallenge, skillTerms),
      assignedResponsibility: boldSkillTermsWholeToken(p.assignedResponsibility, skillTerms),
      action: boldSkillTermsWholeToken(p.action, skillTerms),
      result: boldSkillTermsWholeToken(p.result, skillTerms),
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
