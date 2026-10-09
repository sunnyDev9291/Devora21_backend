import PizZip from "pizzip";
import { AppError } from "../../middleware/errorHandler";
import type {
  GeneratedResumeContent,
  ParsedResumeTemplate,
  ResumeFillProfile,
  TemplateJobSkeleton,
} from "./types";
import {
  fitBulletsToTemplateJob,
  mergeWithTemplateSkeleton,
} from "./content-postprocess";
import { getParagraphStyle, parseResumeTemplate } from "./parse-template";
import { styleMatches } from "./style-map";
import { rebuildDocumentXml, setParagraphMarkdown } from "./xml-utils";

const CATEGORY_LINE_RE = /^([^:]{2,40}):\s*(.*)$/;

function setSlot(
  paras: string[],
  index: number | undefined,
  value: string | undefined
): void {
  if (index === undefined) return;
  paras[index] = setParagraphMarkdown(paras[index], (value ?? "").trim());
}

/**
 * AI fills skill_cat / skill_item only. Slot count = template.
 */
function fillStyledSkillsFixed(
  paras: string[],
  skillsText: string
): string[] {
  const catIndices: number[] = [];
  const itemIndices: number[] = [];
  paras.forEach((p, i) => {
    const style = getParagraphStyle(p);
    if (styleMatches(style, "skillCat")) catIndices.push(i);
    if (styleMatches(style, "skillItem")) itemIndices.push(i);
  });

  if (catIndices.length === 0 && itemIndices.length === 0) {
    throw new AppError(
      422,
      "Styled template missing skill_cat / skill_item slots"
    );
  }

  const lines = skillsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const pairCount = Math.max(catIndices.length, itemIndices.length);
  const next = [...paras];

  for (let i = 0; i < pairCount; i += 1) {
    const line = lines[i] ?? "";
    const colon = line.match(CATEGORY_LINE_RE);
    const label = colon?.[1] ?? (line || "");
    const items = colon?.[2] ?? (colon ? "" : line);

    if (catIndices[i] !== undefined) {
      setSlot(next, catIndices[i], label);
    }
    if (itemIndices[i] !== undefined) {
      setSlot(next, itemIndices[i], items);
    }
  }

  return next;
}

/**
 * AI fills resume title + summary only.
 * Name, contact, education stay exactly as in the template.
 */
function fillStyledAiMetaOnly(
  paras: string[],
  parsed: ParsedResumeTemplate,
  content: GeneratedResumeContent
): string[] {
  const slots = parsed.styleSlots;
  if (!slots) {
    throw new AppError(422, "Styled resume template is missing style slots");
  }
  const next = [...paras];

  const title = content.title?.trim() || parsed.headerTitle || "";
  setSlot(next, slots.title, title);

  const summaryText = content.summary.trim();
  if (slots.summaryBodyIndices.length > 0) {
    next[slots.summaryBodyIndices[0]] = setParagraphMarkdown(
      next[slots.summaryBodyIndices[0]],
      summaryText
    );
    for (let i = 1; i < slots.summaryBodyIndices.length; i += 1) {
      next[slots.summaryBodyIndices[i]] = setParagraphMarkdown(
        next[slots.summaryBodyIndices[i]],
        ""
      );
    }
  }

  return next;
}

/**
 * AI fills exp_section bullets only.
 * company_period / location / name / role stay as in the template.
 */
function fillStyledBulletsOnly(
  paras: string[],
  parsed: ParsedResumeTemplate,
  content: GeneratedResumeContent
): string[] {
  const jobs = parsed.jobs;
  if (!jobs.length) {
    throw new AppError(422, "Styled template missing company experience slots");
  }

  const next = [...paras];
  const experiences = content.experiences ?? [];

  for (let ji = 0; ji < jobs.length; ji += 1) {
    const job = jobs[ji];
    const bulletSlots = job.bulletParaIndices;
    // AI first; pad/clip to template slot count if the model missed.
    const bullets = fitBulletsToTemplateJob(experiences[ji]?.bullets, job);
    for (let bi = 0; bi < bulletSlots.length; bi += 1) {
      setSlot(next, bulletSlots[bi], bullets[bi] || "");
    }
  }

  return next;
}

/**
 * Mode 1 — AI replaces only:
 *   body resume title (resumetitle), summary, skill_cat/skill_item, exp_section bullets.
 * Template keeps: header_name, header_title, name/contact, education,
 * company period/name/role/location. Header parts are never rewritten.
 * fileName is handled outside DOCX (archive naming).
 */
export function applyContentToDocx(
  templateBuffer: Buffer,
  content: GeneratedResumeContent,
  _profile?: ResumeFillProfile
): Buffer {
  void _profile;

  if (!content.title?.trim() || !content.summary?.trim() || !content.skills?.trim()) {
    throw new AppError(422, "Resume content missing required title/summary/skills");
  }
  if (!Array.isArray(content.experiences) || content.experiences.length < 1) {
    throw new AppError(422, "Resume content must include at least one experience");
  }

  const parsed = parseResumeTemplate(templateBuffer);
  if (parsed.mode !== "styled" || !parsed.styleSlots) {
    throw new AppError(
      422,
      "Resume template must use styled mode. Legacy text-header templates are not supported."
    );
  }

  // Freeze company/role/dates; AI bullets preferred, template pad/clip if needed.
  const fitted = mergeWithTemplateSkeleton(
    content,
    parsed.jobs,
    parsed.layout ?? "bullets"
  );

  const zip = new PizZip(templateBuffer);
  let paras = [...parsed.paragraphs];

  paras = fillStyledAiMetaOnly(paras, parsed, fitted);
  paras = fillStyledSkillsFixed(paras, fitted.skills);
  paras = fillStyledBulletsOnly(paras, parsed, fitted);
  // header_name / header_title stay exactly as in the template (fixed content).

  zip.file("word/document.xml", rebuildDocumentXml(parsed.documentXml, paras));
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

export type { ParsedResumeTemplate, TemplateJobSkeleton };
