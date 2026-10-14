import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { applyContentToDocx } from "../lib/resume/apply-content-to-docx";
import { resolveResumeFileName } from "../lib/resume/filename";
import type {
  GeneratedResumeContent,
  ResumeFillProfile,
} from "../lib/resume/types";
import { archiveResume, type ArchiveResumeResult } from "./resume-archive.service";
import {
  loadResumeTemplateForUser,
  persistTemplateBase64ForUser,
  type StoredResumeTemplate,
} from "./resume-template.service";
import type { ResumeRenderInput } from "../validators/resume-render.validator";

export type RenderResumeResult = {
  resumeId: string;
  archiveId: string;
  templateId: string;
  fileName: string;
  pdfFileName: string;
  status: "done";
  pdfBase64?: string;
  docxUrl?: string;
  pdfUrl?: string;
};

function sanitizeBaseName(name: string): string {
  return name
    .replace(/\.docx$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function loadProfileName(userId: string): Promise<string> {
  const profile = await loadFillProfile(userId);
  return profile.name || "Candidate";
}

async function loadFillProfile(userId: string): Promise<ResumeFillProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return {
    name: name || user?.email?.split("@")[0] || "Candidate",
    email: user?.email || undefined,
  };
}

function normalizeContent(content: GeneratedResumeContent): GeneratedResumeContent {
  return {
    title: content.title.trim(),
    summary: content.summary.trim(),
    skills: content.skills.trim(),
    layout: content.layout,
    fileName: content.fileName?.trim() || undefined,
    experiences: content.experiences.map((exp) => ({
      company: exp.company.trim(),
      role: exp.role.trim(),
      dates: exp.dates.trim(),
      ...(exp.location?.trim() ? { location: exp.location.trim() } : {}),
      // Keep empty strings — length must stay aligned with template bullet slots.
      bullets: (exp.bullets || []).map((b) => String(b ?? "").trim()),
      projects: (exp.projects || []).map((p) => ({
        name: String(p.name ?? "").trim(),
        businessChallenge: String(p.businessChallenge ?? "").trim(),
        assignedResponsibility: String(p.assignedResponsibility ?? "").trim(),
        action: String(p.action ?? "").trim(),
        result: String(p.result ?? "").trim(),
      })),
    })),
  };
}

function buildResumeFileName(input: {
  content: GeneratedResumeContent;
  resumeFileBaseName?: string;
  profileName: string;
  companyName: string;
  jobTitle: string;
  customPrompt?: string;
}): string {
  if (input.content.fileName?.trim()) {
    return `${sanitizeBaseName(input.content.fileName)}.docx`;
  }
  if (input.resumeFileBaseName?.trim()) {
    return `${sanitizeBaseName(input.resumeFileBaseName)}.docx`;
  }

  const patterned = [
    input.profileName,
    input.companyName,
    input.jobTitle.split("|")[0]?.trim() || input.jobTitle,
  ]
    .map((p) => sanitizeBaseName(p))
    .filter(Boolean)
    .join("-");

  if (patterned) {
    return `${patterned}.docx`;
  }

  return resolveResumeFileName(input.content, {
    customPrompt: input.customPrompt || "",
    profileName: input.profileName,
  });
}

async function resolveTemplate(
  userId: string,
  input: Pick<ResumeRenderInput, "templateId" | "templateBase64" | "templateFileName">
): Promise<StoredResumeTemplate> {
  if (input.templateId?.trim()) {
    return loadResumeTemplateForUser({
      userId,
      templateId: input.templateId.trim(),
    });
  }

  if (input.templateBase64?.trim()) {
    return persistTemplateBase64ForUser({
      userId,
      templateBase64: input.templateBase64.trim(),
      templateFileName: input.templateFileName,
    });
  }

  // Fall back to the user's active stored template.
  return loadResumeTemplateForUser({ userId });
}

/** Whole Apply pipeline must finish before FE's ~90s client timeout. */
const RENDER_OVERALL_MS = 60_000;

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError(504, message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Authoritative fill → DOCX → PDF → archive pipeline.
 * Used by POST /resume/render and /resume/from-job.
 * Must return JSON success or AppError within ~60s (no silent hang).
 */
export async function renderResume(
  userId: string,
  input: {
    templateId?: string | null;
    templateBase64?: string | null;
    templateFileName?: string | null;
    templateBuffer?: Buffer | null;
    content: GeneratedResumeContent;
    jobTitle: string;
    companyName: string;
    jobDescription?: string;
    customPrompt?: string;
    resumeFileBaseName?: string;
    profileName?: string;
    /** Re-render into an existing archive id. */
    resumeId?: string | null;
    includePdfBase64?: boolean;
    /** Defaults to web_ui; from-job passes one_click_api. */
    generationMethod?: "web_ui" | "one_click_api";
  }
): Promise<RenderResumeResult> {
  const started = Date.now();
  return raceWithTimeout(
    (async () => {
      const content = normalizeContent(input.content);

      let template: StoredResumeTemplate;
      if (input.templateBuffer && input.templateId) {
        template = {
          templateId: input.templateId,
          fileName: input.templateFileName || "resume-template.docx",
          storageKey: "",
          buffer: input.templateBuffer,
        };
      } else {
        template = await resolveTemplate(userId, {
          templateId: input.templateId || undefined,
          templateBase64: input.templateBase64 || undefined,
          templateFileName: input.templateFileName || undefined,
        });
      }
      console.log(`[resume/render] templateMs=${Date.now() - started}`);

      const fillProfile = await loadFillProfile(userId);
      if (input.profileName?.trim()) {
        fillProfile.name = input.profileName.trim();
      }
      // DOCX identity/company/education stay in the template. AI only supplies
      // title/summary/skills/bullets; fileName is used for archive naming below.
      fillProfile.title = content.title;
      const profileName = fillProfile.name || "Candidate";

      let docxBuffer: Buffer;
      const fillStarted = Date.now();
      try {
        docxBuffer = applyContentToDocx(template.buffer, content);
      } catch (err) {
        // applyContentToDocx throws AppError 422 when styles/slots are missing.
        if (err instanceof AppError) throw err;
        const message =
          err instanceof Error ? err.message : "Failed to fill resume DOCX";
        throw new AppError(500, message);
      }
      console.log(
        `[resume/render] fillMs=${Date.now() - fillStarted} docxBytes=${docxBuffer.length}`
      );

      const resumeFileName = buildResumeFileName({
        content,
        resumeFileBaseName: input.resumeFileBaseName,
        profileName,
        companyName: input.companyName,
        jobTitle: input.jobTitle,
        customPrompt: input.customPrompt,
      });

      let archived: ArchiveResumeResult;
      const archiveStarted = Date.now();
      try {
        archived = await archiveResume({
          userId,
          jobTitle: input.jobTitle,
          companyName: input.companyName,
          jobDescription: input.jobDescription || "",
          datetime: new Date().toISOString(),
          resumeFileName,
          fileBuffer: docxBuffer,
          archiveId: input.resumeId?.trim() || undefined,
          templateId: template.templateId,
          generationMethod: input.generationMethod ?? "web_ui",
        });
      } catch (err) {
        if (err instanceof AppError) throw err;
        const message =
          err instanceof Error ? err.message : "Failed to render resume";
        throw new AppError(500, message);
      }
      console.log(
        `[resume/render] archiveMs=${Date.now() - archiveStarted} totalMs=${Date.now() - started} archiveId=${archived.id}`
      );

      return {
        resumeId: archived.id,
        archiveId: archived.id,
        templateId: template.templateId,
        fileName: archived.resumeName,
        pdfFileName: archived.pdfFileName,
        status: "done" as const,
        ...(input.includePdfBase64 !== false && archived.pdfBase64
          ? { pdfBase64: archived.pdfBase64 }
          : {}),
        ...(archived.docxUrl ? { docxUrl: archived.docxUrl } : {}),
        ...(archived.pdfUrl ? { pdfUrl: archived.pdfUrl } : {}),
      };
    })(),
    RENDER_OVERALL_MS,
    `Resume render exceeded ${RENDER_OVERALL_MS}ms (PDF/storage). Try Apply again.`
  );
}

/** HTTP entry for POST /resume/render. */
export async function renderResumeFromRequest(
  userId: string,
  body: ResumeRenderInput
): Promise<RenderResumeResult> {
  return renderResume(userId, {
    templateId: body.templateId,
    templateBase64: body.templateBase64,
    templateFileName: body.templateFileName,
    content: body.content,
    jobTitle: body.jobTitle,
    companyName: body.companyName,
    jobDescription: body.jobDescription,
    customPrompt: body.customPrompt,
    resumeFileBaseName: body.resumeFileBaseName,
    profileName: body.profileName,
    resumeId: body.resumeId,
    includePdfBase64: true,
  });
}
