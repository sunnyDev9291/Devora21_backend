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
import {
  rebuildDocumentXml,
  setExpSectionBulletText,
  setParagraphPlain,
} from "./xml-utils";

const CATEGORY_LINE_RE = /^([^:]{2,40}):\s*(.*)$/;

function setSlot(
  paras: string[],
  index: number | undefined,
  value: string | undefined,
  opts?: { boldMode?: "off" | "inherit" | boolean }
): void {
  if (index === undefined) return;
  paras[index] = setParagraphPlain(paras[index], (value ?? "").trim(), {
    boldMode: opts?.boldMode ?? "off",
  });
}

type SkillGroup = { catIndex: number; itemIndices: number[] };

/**
 * Group each skill_cat with the skill_item paragraphs that follow it
 * (until the next skill_cat or experience section). Supports 1:1 and 1:N.
 */
function collectSkillGroups(paras: string[]): SkillGroup[] {
  const groups: SkillGroup[] = [];
  let current: SkillGroup | null = null;

  for (let i = 0; i < paras.length; i += 1) {
    const style = getParagraphStyle(paras[i]);
    if (styleMatches(style, "skillCat")) {
      current = { catIndex: i, itemIndices: [] };
      groups.push(current);
      continue;
    }
    if (styleMatches(style, "skillItem")) {
      if (current) {
        current.itemIndices.push(i);
      }
      continue;
    }
    // Skills block ended — stop once we've started grouping and hit experience.
    if (
      groups.length > 0 &&
      (styleMatches(style, "companyPeriod") ||
        styleMatches(style, "companyInfo") ||
        styleMatches(style, "companyRole") ||
        styleMatches(style, "expSection"))
    ) {
      break;
    }
  }

  return groups;
}

/** Split one AI "items" string across k template skill_item rows. */
function splitItemsAcrossSlots(itemsText: string, slotCount: number): string[] {
  if (slotCount <= 0) return [];
  const text = itemsText.trim();
  if (slotCount === 1) return [text];
  if (!text) return Array.from({ length: slotCount }, () => "");

  let parts = text
    .split(/\s*[•·▪▸]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    parts = text
      .split(/\s*;\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (parts.length <= 1) {
    parts = text
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (parts.length === 0) {
    return Array.from({ length: slotCount }, () => "");
  }

  const out = Array.from({ length: slotCount }, () => "");
  if (parts.length <= slotCount) {
    for (let i = 0; i < parts.length; i += 1) {
      out[i] = parts[i];
    }
    return out;
  }

  const perSlot = Math.ceil(parts.length / slotCount);
  for (let i = 0; i < slotCount; i += 1) {
    out[i] = parts.slice(i * perSlot, (i + 1) * perSlot).join(" · ");
  }
  return out;
}

/**
 * AI fills skill_cat / skill_item. One AI "Label: items" line per skill_cat;
 * items are distributed across that category's skill_item row(s).
 */
function fillStyledSkillsFixed(
  paras: string[],
  skillsText: string
): string[] {
  const groups = collectSkillGroups(paras);

  if (groups.length === 0) {
    throw new AppError(
      422,
      "Styled template missing skill_cat / skill_item slots"
    );
  }

  const lines = skillsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Pad/clip to category count (same idea as experience bullets).
  while (lines.length < groups.length) lines.push("");
  if (lines.length > groups.length) {
    console.warn(
      `[resume] skills: AI wrote ${lines.length} category line(s); template has ${groups.length} skill_cat — clipping`
    );
  }

  const next = [...paras];

  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi];
    const line = lines[gi] ?? "";
    const colon = line.match(CATEGORY_LINE_RE);
    const label = (colon?.[1] ?? (line || "")).trim();
    const itemsText = (colon?.[2] ?? (colon ? "" : line)).trim();

    // skill_cat: inherit template/style bold (Joao style has <w:b/> on skillcat).
    // skill_item: force bold off so first tokens do not pick up cat-cell bold in PDF.
    setSlot(next, group.catIndex, label, { boldMode: "inherit" });

    const slotValues = splitItemsAcrossSlots(
      itemsText,
      group.itemIndices.length
    );
    for (let si = 0; si < group.itemIndices.length; si += 1) {
      setSlot(next, group.itemIndices[si], slotValues[si] ?? "", {
        boldMode: "off",
      });
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
    next[slots.summaryBodyIndices[0]] = setParagraphPlain(
      next[slots.summaryBodyIndices[0]],
      summaryText
    );
    for (let i = 1; i < slots.summaryBodyIndices.length; i += 1) {
      next[slots.summaryBodyIndices[i]] = setParagraphPlain(
        next[slots.summaryBodyIndices[i]],
        ""
      );
    }
  }

  return next;
}

/**
 * AI fills exp_section bullets only.
 * Match slots by company_period (via merge). company_info / company_period /
 * location / role text stay exactly as in the template.
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
    // experiences already ordered/matched by period in mergeWithTemplateSkeleton.
    const bullets = fitBulletsToTemplateJob(experiences[ji]?.bullets, job);
    for (let bi = 0; bi < bulletSlots.length; bi += 1) {
      const idx = bulletSlots[bi];
      // Preserve w:numPr (in pPr) and/or literal "• " from the template paragraph.
      next[idx] = setExpSectionBulletText(next[idx], bullets[bi] || "");
    }
  }

  return next;
}

/**
 * Mode 1 — AI replaces only:
 *   body resume title (resumetitle), summary, skill_cat/skill_item, exp_section bullets.
 * Template keeps: header_name, header_title, name/contact, education,
 * company_period, company_info, role/location. Header parts are never rewritten.
 * Experiences are matched to slots by company_period (dates).
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

  // Match AI experiences → template slots by company_period; bullets only for DOCX.
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
