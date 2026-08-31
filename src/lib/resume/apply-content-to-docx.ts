import PizZip from "pizzip";
import { AppError } from "../../middleware/errorHandler";
import type { GeneratedResumeContent, ParsedResumeTemplate } from "./types";
import { parseResumeTemplate, findTitleParaIndex } from "./parse-template";
import {
  EXPERIENCE_HEADER_RE,
  SKILLS_HEADER_RE,
  SUMMARY_HEADER_RE,
  findHeaderIndex,
  getFirstRunProps,
  paragraphPlainText,
  rebuildDocumentXml,
  replaceParagraphContent,
  runsForCategorySkillLine,
  setParagraphMarkdown,
} from "./xml-utils";

function fillSkillsParagraphs(
  templateParas: string[],
  skillsHeaderIndex: number,
  experienceHeaderIndex: number,
  skillsText: string
): string[] {
  const skillBodyIndices: number[] = [];
  for (let i = skillsHeaderIndex + 1; i < experienceHeaderIndex; i += 1) {
    if (paragraphPlainText(templateParas[i])) {
      skillBodyIndices.push(i);
    }
  }

  const lines = skillsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const next = [...templateParas];

  if (skillBodyIndices.length === 0) {
    // Insert after header using a clone of the header paragraph style as fallback
    const base = templateParas[skillsHeaderIndex];
    const inserted = lines.map((line) => {
      const colon = line.match(/^([^:]{2,40}):\s*(.+)$/);
      const rPr = getFirstRunProps(base);
      if (colon) {
        return replaceParagraphContent(
          base,
          runsForCategorySkillLine(colon[1], colon[2], rPr)
        );
      }
      return setParagraphMarkdown(base, line);
    });
    next.splice(skillsHeaderIndex + 1, 0, ...inserted);
    return next;
  }

  // Reuse existing skill paragraph slots; pad/truncate line count to slots
  const slots = skillBodyIndices;
  for (let s = 0; s < slots.length; s += 1) {
    const idx = slots[s];
    const line = lines[s] ?? "";
    if (!line) {
      next[idx] = setParagraphMarkdown(templateParas[idx], "");
      continue;
    }
    const colon = line.match(/^([^:]{2,40}):\s*(.+)$/);
    const rPr = getFirstRunProps(templateParas[idx]);
    if (colon) {
      next[idx] = replaceParagraphContent(
        templateParas[idx],
        runsForCategorySkillLine(colon[1], colon[2], rPr)
      );
    } else {
      next[idx] = setParagraphMarkdown(templateParas[idx], line);
    }
  }

  // Extra AI skill lines: clone last skill paragraph
  if (lines.length > slots.length) {
    const lastIdx = slots[slots.length - 1];
    const extras = lines.slice(slots.length).map((line) => {
      const colon = line.match(/^([^:]{2,40}):\s*(.+)$/);
      const rPr = getFirstRunProps(templateParas[lastIdx]);
      if (colon) {
        return replaceParagraphContent(
          templateParas[lastIdx],
          runsForCategorySkillLine(colon[1], colon[2], rPr)
        );
      }
      return setParagraphMarkdown(templateParas[lastIdx], line);
    });
    next.splice(lastIdx + 1, 0, ...extras);
  }

  return next;
}

function fillSummary(
  paras: string[],
  summaryHeaderIndex: number,
  skillsHeaderIndex: number,
  summary: string
): string[] {
  const next = [...paras];
  const bodyIndices: number[] = [];
  for (let i = summaryHeaderIndex + 1; i < skillsHeaderIndex; i += 1) {
    if (paragraphPlainText(paras[i]) || bodyIndices.length === 0) {
      // include first empty after header as writable slot if needed
      bodyIndices.push(i);
    }
  }

  const lines = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const text = lines.join("\n") || summary;

  if (bodyIndices.length === 0) {
    const base = paras[summaryHeaderIndex];
    next.splice(summaryHeaderIndex + 1, 0, setParagraphMarkdown(base, text));
    return next;
  }

  // Put full summary into first body para; clear extras
  next[bodyIndices[0]] = setParagraphMarkdown(paras[bodyIndices[0]], text);
  for (let i = 1; i < bodyIndices.length; i += 1) {
    next[bodyIndices[i]] = setParagraphMarkdown(paras[bodyIndices[i]], "");
  }
  return next;
}

function fillTitleBeforeSummary(
  paras: string[],
  summaryHeaderIndex: number,
  title: string
): string[] {
  const next = [...paras];
  const titleIdx = findTitleParaIndex(paras, summaryHeaderIndex);
  if (titleIdx >= 0) {
    next[titleIdx] = setParagraphMarkdown(paras[titleIdx], title);
  }
  return next;
}

function fillBulletsExperience(
  paras: string[],
  parsed: ParsedResumeTemplate,
  content: GeneratedResumeContent
): string[] {
  const next = [...paras];
  for (let ji = 0; ji < parsed.jobs.length; ji += 1) {
    const job = parsed.jobs[ji];
    const exp = content.experiences[ji];
    if (!exp) continue;

    // Keep company & dates locked (template values already in XML). Update role.
    if (job.roleParaIndex !== job.companyParaIndex) {
      next[job.roleParaIndex] = setParagraphMarkdown(paras[job.roleParaIndex], exp.role || job.role);
    }

    const bullets = exp.bullets ?? [];
    for (let bi = 0; bi < job.bulletParaIndices.length; bi += 1) {
      const pIdx = job.bulletParaIndices[bi];
      const bullet = bullets[bi] ?? "";
      next[pIdx] = setParagraphMarkdown(paras[pIdx], bullet);
    }
  }
  return next;
}

function fillProjectsExperience(
  paras: string[],
  parsed: ParsedResumeTemplate,
  content: GeneratedResumeContent
): string[] {
  const next = [...paras];
  for (let ji = 0; ji < parsed.jobs.length; ji += 1) {
    const job = parsed.jobs[ji];
    const exp = content.experiences[ji];
    if (!exp) continue;

    if (job.roleParaIndex !== job.companyParaIndex) {
      next[job.roleParaIndex] = setParagraphMarkdown(paras[job.roleParaIndex], exp.role || job.role);
    }

    const projects = exp.projects ?? [];
    for (let pi = 0; pi < job.projectBlocks.length; pi += 1) {
      const block = job.projectBlocks[pi];
      const project = projects[pi];
      // Freeze project name — do not overwrite name paragraph
      const fields = block.fieldParaIndices;
      const writeField = (idx: number | undefined, label: string, value: string) => {
        if (idx === undefined) return;
        const existing = paragraphPlainText(paras[idx]);
        const hasLabel = /^[^:]+:\s*/.test(existing);
        const text = hasLabel
          ? `${existing.match(/^([^:]+:\s*)/)?.[1] ?? `${label}: `}${value}`
          : value;
        next[idx] = setParagraphMarkdown(paras[idx], text);
      };
      writeField(fields.businessChallenge, "Business Challenge", project?.businessChallenge ?? "");
      writeField(
        fields.assignedResponsibility,
        "Assigned Responsibility",
        project?.assignedResponsibility ?? ""
      );
      writeField(fields.action, "Action", project?.action ?? "");
      writeField(fields.result, "Result", project?.result ?? "");
    }
  }
  return next;
}

/**
 * Apply GeneratedResumeContent onto the user's DOCX template via pizzip paragraph rewrite.
 * Mirrors frontend applyContentToDocx — no docxtemplater / merge fields.
 */
export function applyContentToDocx(
  templateBuffer: Buffer,
  content: GeneratedResumeContent
): Buffer {
  if (!content.title?.trim() || !content.summary?.trim() || !content.skills?.trim()) {
    throw new AppError(422, "Resume content missing required title/summary/skills");
  }
  if (!Array.isArray(content.experiences) || content.experiences.length < 1) {
    throw new AppError(422, "Resume content must include at least one experience");
  }

  const parsed = parseResumeTemplate(templateBuffer);
  const layout = content.layout ?? parsed.layout;

  let paras = [...parsed.paragraphs];
  paras = fillTitleBeforeSummary(paras, parsed.summaryHeaderIndex, content.title);
  paras = fillSummary(
    paras,
    parsed.summaryHeaderIndex,
    parsed.skillsHeaderIndex,
    content.summary
  );
  paras = fillSkillsParagraphs(
    paras,
    parsed.skillsHeaderIndex,
    parsed.experienceHeaderIndex,
    content.skills
  );

  // If skills insert shifted indices, shift job indices by delta.
  const experienceIdx = findHeaderIndex(
    paras,
    EXPERIENCE_HEADER_RE,
    findHeaderIndex(paras, SKILLS_HEADER_RE, findHeaderIndex(paras, SUMMARY_HEADER_RE) + 1) + 1
  );

  // Prefer original parsed job indices when paragraph count unchanged in experience region.
  // If skills insert shifted indices, shift job indices by delta.
  const delta = experienceIdx - parsed.experienceHeaderIndex;
  const shifted = {
    ...parsed,
    jobs: parsed.jobs.map((j) => ({
      ...j,
      startParaIndex: j.startParaIndex + delta,
      endParaIndex: j.endParaIndex + delta,
      companyParaIndex: j.companyParaIndex + delta,
      roleParaIndex: j.roleParaIndex + delta,
      datesParaIndex: j.datesParaIndex + delta,
      bulletParaIndices: j.bulletParaIndices.map((i) => i + delta),
      projectBlocks: j.projectBlocks.map((b) => ({
        ...b,
        nameParaIndex: b.nameParaIndex + delta,
        fieldParaIndices: {
          businessChallenge:
            b.fieldParaIndices.businessChallenge !== undefined
              ? b.fieldParaIndices.businessChallenge + delta
              : undefined,
          assignedResponsibility:
            b.fieldParaIndices.assignedResponsibility !== undefined
              ? b.fieldParaIndices.assignedResponsibility + delta
              : undefined,
          action:
            b.fieldParaIndices.action !== undefined
              ? b.fieldParaIndices.action + delta
              : undefined,
          result:
            b.fieldParaIndices.result !== undefined
              ? b.fieldParaIndices.result + delta
              : undefined,
        },
      })),
    })),
  };

  if (layout === "projects") {
    paras = fillProjectsExperience(paras, shifted, content);
  } else {
    paras = fillBulletsExperience(paras, shifted, content);
  }

  const newXml = rebuildDocumentXml(parsed.documentXml, paras);
  const zip = new PizZip(templateBuffer);
  zip.file("word/document.xml", newXml);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

export type { ParsedResumeTemplate };
