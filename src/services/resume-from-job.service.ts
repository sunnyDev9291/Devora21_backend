import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { applyContentToDocx } from "../lib/resume/apply-content-to-docx";
import { parseAndFinalizeResumeJson } from "../lib/resume/content-postprocess";
import { archiveJobTitleFromContent } from "../lib/resume/filename";
import { parseResumeTemplate } from "../lib/resume/parse-template";
import { buildResumeSystemPrompt, buildResumeUserPrompt } from "../lib/resume/prompt";
import { createChatCompletion, CLAUDE_MAX_OUTPUT_TOKENS } from "./claude.service";
import { getUserPrompt, getUserResumeTemplate } from "./onboarding.service";
import { archiveResume } from "./resume-archive.service";
import { createBackblazeDownloadUrl } from "./backblaze.service";
import { scrapeJobFromUrl } from "./zyte.service";
import type { ResumeFromJobInput } from "../validators/resume-from-job.validator";

export type ResumeFromJobStatus =
  | "queued"
  | "scraping"
  | "generating"
  | "filling"
  | "rendering"
  | "done"
  | "error";

export type ResumeFromJobResult = {
  id: string;
  jobTitle: string;
  companyName: string;
  resumeName: string;
  pdfFileName: string;
  /** Backblaze B2 DOCX download URL. */
  docxUrl?: string;
  /** Backblaze B2 PDF download URL. */
  pdfUrl: string;
  warning?: string;
};

export type ResumeFromJobAccepted = {
  jobId: string;
  status: ResumeFromJobStatus;
  message: string;
  step: number;
  totalSteps: number;
  progressPercent: number;
};

export type ResumeFromJobStepInfo = {
  key: ResumeFromJobStatus | "queued";
  label: string;
  state: "pending" | "active" | "done" | "error";
};

export type ResumeFromJobStatusResponse = {
  jobId: string;
  status: ResumeFromJobStatus;
  message: string;
  /** 1-based current step (queued=1 … done=6). */
  step: number;
  totalSteps: number;
  progressPercent: number;
  /** Checklist for UI progress. */
  steps: ResumeFromJobStepInfo[];
  url: string;
  /** Filled as soon as scrape succeeds (before PDF is ready). */
  jobTitle?: string;
  companyName?: string;
  warning?: string;
  error?: string;
  result?: ResumeFromJobResult;
  createdAt: string;
  updatedAt: string;
};

const PIPELINE_STEPS: Array<{ key: ResumeFromJobStatus; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "scraping", label: "Scrape job" },
  { key: "generating", label: "Generate resume" },
  { key: "filling", label: "Fill DOCX" },
  { key: "rendering", label: "Render PDF" },
  { key: "done", label: "Complete" },
];

const TOTAL_STEPS = PIPELINE_STEPS.length;

const STATUS_MESSAGES: Record<ResumeFromJobStatus, string> = {
  queued: "Queued — starting resume pipeline…",
  scraping: "Scraping and normalizing the job posting…",
  generating: "Generating resume content with AI…",
  filling: "Filling your DOCX template…",
  rendering: "Converting to PDF and saving archive…",
  done: "Resume PDF is ready",
  error: "Resume generation failed",
};

function stepIndexForStatus(status: ResumeFromJobStatus): number {
  if (status === "error") {
    return -1;
  }
  const idx = PIPELINE_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx + 1 : 1;
}

function progressPercentForStatus(status: ResumeFromJobStatus): number {
  if (status === "error") return 0;
  if (status === "done") return 100;
  const step = stepIndexForStatus(status);
  // Map active stage to mid-point of that step band
  return Math.min(99, Math.round(((step - 1) / (TOTAL_STEPS - 1)) * 100));
}

function buildStepsChecklist(
  status: ResumeFromJobStatus
): ResumeFromJobStepInfo[] {
  if (status === "error") {
    return PIPELINE_STEPS.map((s) => ({
      key: s.key,
      label: s.label,
      state: "error" as const,
    }));
  }

  const activeIdx = PIPELINE_STEPS.findIndex((s) => s.key === status);
  return PIPELINE_STEPS.map((s, i) => {
    let state: ResumeFromJobStepInfo["state"] = "pending";
    if (status === "done" || i < activeIdx) state = "done";
    else if (i === activeIdx) state = "active";
    return { key: s.key, label: s.label, state };
  });
}

async function setJobStatus(
  jobId: string,
  status: ResumeFromJobStatus,
  extra: {
    message?: string;
    warning?: string | null;
    error?: string | null;
    archiveId?: string | null;
    jobTitle?: string | null;
    companyName?: string | null;
    resumeName?: string | null;
    pdfFileName?: string | null;
    pdfUrl?: string | null;
  } = {}
): Promise<void> {
  await prisma.resumeGenerationJob.update({
    where: { id: jobId },
    data: {
      status,
      message: extra.message ?? STATUS_MESSAGES[status],
      ...(extra.warning !== undefined ? { warning: extra.warning } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.archiveId !== undefined ? { archiveId: extra.archiveId } : {}),
      ...(extra.jobTitle !== undefined ? { jobTitle: extra.jobTitle } : {}),
      ...(extra.companyName !== undefined ? { companyName: extra.companyName } : {}),
      ...(extra.resumeName !== undefined ? { resumeName: extra.resumeName } : {}),
      ...(extra.pdfFileName !== undefined ? { pdfFileName: extra.pdfFileName } : {}),
      ...(extra.pdfUrl !== undefined ? { pdfUrl: extra.pdfUrl } : {}),
    },
  });
}

async function loadProfileName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  return user?.email?.split("@")[0] || "Candidate";
}

async function runResumeFromJobPipeline(
  jobId: string,
  userId: string,
  url: string
): Promise<void> {
  try {
    await setJobStatus(jobId, "scraping", {
      message: "Fetching job page via Zyte…",
    });

    const scraped = await scrapeJobFromUrl({ url });

    await setJobStatus(jobId, "scraping", {
      message: "Normalizing job fields with DeepSeek…",
    });

    const jobTitle = scraped.jobTitle.trim();
    const companyName = scraped.companyName.trim();
    const jobDescription = scraped.jobDescription.trim();

    if (!jobTitle || !companyName) {
      throw new AppError(
        422,
        scraped.warning ||
          "Could not extract required job title and company name from the job link"
      );
    }

    await setJobStatus(jobId, "scraping", {
      warning: scraped.warning ?? null,
      jobTitle,
      companyName,
      message: scraped.warning
        ? `Scraped ${companyName} — ${jobTitle} (with warnings); loading profile…`
        : `Scraped ${companyName} — ${jobTitle}; loading profile template…`,
    });

    let templateBase64: string;
    try {
      const template = await getUserResumeTemplate(userId);
      templateBase64 = template.templateBase64;
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        throw new AppError(422, "Resume template not found. Upload a template in your profile.");
      }
      throw err;
    }

    // Only the saved profile prompt is used — request/body prompts are ignored.
    let customPrompt = "";
    try {
      const prompt = await getUserPrompt(userId);
      customPrompt = prompt.content?.trim() || "";
    } catch {
      customPrompt = "";
    }
    if (!customPrompt) {
      throw new AppError(
        422,
        "Profile prompt not found. Upload a prompt in your Devora21 profile before generating a resume."
      );
    }

    const templateBuffer = Buffer.from(templateBase64, "base64");
    const parsedTemplate = parseResumeTemplate(templateBuffer);
    const profileName =
      parsedTemplate.profileName?.trim() || (await loadProfileName(userId));

    await setJobStatus(jobId, "generating", {
      jobTitle,
      companyName,
      message: `Calling Claude (${parsedTemplate.layout} layout, ${parsedTemplate.jobs.length} job block(s))…`,
    });

    // Only the profile prompt instructs the model. Job + template are data only.
    const system = buildResumeSystemPrompt(parsedTemplate.layout, customPrompt);
    const user = buildResumeUserPrompt({
      jobTitle,
      jobDescription,
      customPrompt,
      layout: parsedTemplate.layout,
      jobs: parsedTemplate.jobs,
      skillsSample: parsedTemplate.skillsSample,
    });

    const ai = await createChatCompletion({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: CLAUDE_MAX_OUTPUT_TOKENS,
      jsonObject: true,
    });

    await setJobStatus(jobId, "generating", {
      message: "Parsing and post-processing AI resume JSON…",
    });

    let content;
    try {
      content = parseAndFinalizeResumeJson(ai.content, {
        layout: parsedTemplate.layout,
        jobs: parsedTemplate.jobs,
        skillsSample: parsedTemplate.skillsSample,
        customPrompt,
        profileName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse AI resume JSON";
      throw new AppError(502, message);
    }

    await setJobStatus(jobId, "filling", {
      message: "Applying content to your DOCX template…",
    });

    let docxBuffer: Buffer;
    try {
      docxBuffer = applyContentToDocx(templateBuffer, content);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : "Failed to fill resume DOCX";
      throw new AppError(422, message);
    }

    const resumeFileName = `${(content.fileName || "resume").replace(/\.docx$/i, "")}.docx`;
    const archiveTitle = archiveJobTitleFromContent(content.title);

    await setJobStatus(jobId, "rendering", {
      jobTitle: archiveTitle,
      companyName,
      resumeName: resumeFileName,
      message: "Converting DOCX → PDF and uploading DOCX+PDF to Backblaze…",
    });

    const archived = await archiveResume({
      userId,
      jobTitle: archiveTitle,
      companyName,
      jobDescription,
      datetime: new Date().toISOString(),
      resumeFileName,
      fileBuffer: docxBuffer,
    });

    await setJobStatus(jobId, "done", {
      archiveId: archived.id,
      jobTitle: archiveTitle,
      companyName,
      resumeName: archived.resumeName,
      pdfFileName: archived.pdfFileName,
      pdfUrl: archived.pdfUrl,
      warning: scraped.warning ?? null,
      error: null,
      message: `Ready: ${archived.pdfFileName}`,
    });
  } catch (err) {
    const message =
      err instanceof AppError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Resume generation failed";
    console.error(`Resume from-job ${jobId} failed:`, err);
    await setJobStatus(jobId, "error", {
      error: message,
      message: `Failed: ${message}`,
    }).catch((updateErr) => {
      console.error(`Failed to mark job ${jobId} as error:`, updateErr);
    });
  }
}

/**
 * Enqueue async resume generation. Returns immediately with jobId for polling.
 */
export async function enqueueResumeFromJob(
  userId: string,
  input: ResumeFromJobInput
): Promise<ResumeFromJobAccepted> {
  const job = await prisma.resumeGenerationJob.create({
    data: {
      userId,
      url: input.url.trim(),
      status: "queued",
      message: STATUS_MESSAGES.queued,
    },
  });

  void runResumeFromJobPipeline(job.id, userId, job.url);

  return {
    jobId: job.id,
    status: "queued",
    message: STATUS_MESSAGES.queued,
    step: 1,
    totalSteps: TOTAL_STEPS,
    progressPercent: 0,
  };
}

/**
 * Poll detailed job status. When done, includes pdfUrl (Backblaze), not pdfBase64.
 */
export async function getResumeFromJobStatus(
  userId: string,
  jobId: string
): Promise<ResumeFromJobStatusResponse> {
  const job = await prisma.resumeGenerationJob.findFirst({
    where: { id: jobId, userId },
  });

  if (!job) {
    throw new AppError(404, "Resume generation job not found");
  }

  const status = job.status as ResumeFromJobStatus;
  const step = status === "error" ? stepIndexForStatus("queued") : stepIndexForStatus(status);

  const base: ResumeFromJobStatusResponse = {
    jobId: job.id,
    status,
    message: job.message || STATUS_MESSAGES[status] || job.status,
    step: status === "done" ? TOTAL_STEPS : Math.max(1, step),
    totalSteps: TOTAL_STEPS,
    progressPercent: progressPercentForStatus(status),
    steps: buildStepsChecklist(status),
    url: job.url,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.jobTitle ? { jobTitle: job.jobTitle } : {}),
    ...(job.companyName ? { companyName: job.companyName } : {}),
    ...(job.warning ? { warning: job.warning } : {}),
    ...(job.error ? { error: job.error } : {}),
  };

  if (status === "error") {
    return {
      ...base,
      step: Math.max(1, stepIndexForStatus("scraping")),
      progressPercent: 0,
    };
  }

  if (status !== "done" || !job.archiveId || !job.pdfUrl) {
    return base;
  }

  const archive = await prisma.resumeArchive.findFirst({
    where: { id: job.archiveId, userId },
    select: { docxUrl: true, pdfUrl: true },
  });

  const storedPdf = archive?.pdfUrl || job.pdfUrl;
  const storedDocx = archive?.docxUrl || null;

  let pdfUrl = storedPdf;
  let docxUrl: string | undefined;
  try {
    pdfUrl = await createBackblazeDownloadUrl(storedPdf);
    if (storedDocx) {
      docxUrl = await createBackblazeDownloadUrl(storedDocx);
    }
  } catch {
    // Keep stored URLs if signing fails
    if (storedDocx) docxUrl = storedDocx;
  }

  return {
    ...base,
    step: TOTAL_STEPS,
    progressPercent: 100,
    result: {
      id: job.archiveId,
      jobTitle: job.jobTitle || "",
      companyName: job.companyName || "",
      resumeName: job.resumeName || "",
      pdfFileName: job.pdfFileName || "",
      pdfUrl,
      ...(docxUrl ? { docxUrl } : {}),
      ...(job.warning ? { warning: job.warning } : {}),
    },
  };
}
