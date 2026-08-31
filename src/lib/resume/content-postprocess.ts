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
  const bullets = asStringArray(o.bullets);
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
 * Lock company, dates, project names, and bullet/project COUNTS from template skeleton.
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
        company: job.company || src?.company || "",
        role: src?.role || job.role || "",
        dates: job.dates || src?.dates || "",
        bullets: [],
        projects,
      };
    }

    const bullets = [...(src?.bullets ?? [])];
    while (bullets.length < job.bulletCount) {
      bullets.push("");
    }
    if (bullets.length > job.bulletCount) {
      bullets.length = job.bulletCount;
    }

    return {
      company: job.company || src?.company || "",
      role: src?.role || job.role || "",
      dates: job.dates || src?.dates || "",
      bullets,
    };
  });

  return {
    ...ai,
    layout,
    experiences,
  };
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

  const skillTerms = collectSkillTermsFromSkillsBlock(next.skills);
  next.summary = boldSkillTermsWholeToken(next.summary, skillTerms);
  next.title = boldSkillTermsWholeToken(next.title, skillTerms);
  next.skills = boldSkillTermsWholeToken(next.skills, skillTerms);
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
