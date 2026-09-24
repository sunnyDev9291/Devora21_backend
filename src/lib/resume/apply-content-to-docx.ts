import PizZip from "pizzip";
import { AppError } from "../../middleware/errorHandler";
import type { GeneratedResumeContent, ParsedResumeTemplate } from "./types";
import { parseResumeTemplate, findTitleParaIndex, parseCombinedJobHeader } from "./parse-template";
import { collectCategoryLabels } from "./skills-style";
import { syncRolePreservingSeniority } from "./title-sync";
import {
  EXPERIENCE_HEADER_RE,
  SKILLS_HEADER_RE,
  SUMMARY_HEADER_RE,
  detectColonSuffix,
  estimateSkillsTabStopTwips,
  findHeaderIndex,
  paragraphPlainText,
  rebuildDocumentXml,
  setCategorySkillParagraph,
  setParagraphMarkdown,
} from "./xml-utils";

const CATEGORY_LINE_RE = /^([^:]{2,40}):\s*(.*)$/;

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

  const categoryLabels = collectCategoryLabels(skillsText);
  const tabStop = estimateSkillsTabStopTwips(
    categoryLabels.length > 0
      ? categoryLabels
      : lines.map((l) => l.match(CATEGORY_LINE_RE)?.[1] ?? "").filter(Boolean)
  );
  const colonSuffix = detectColonSuffix(
    skillBodyIndices.length > 0
      ? paragraphPlainText(templateParas[skillBodyIndices[0]])
      : lines[0] ?? ""
  );

  const writeSkillLine = (baseXml: string, line: string): string => {
    const colon = line.match(CATEGORY_LINE_RE);
    if (colon) {
      // Always TAB + shared stop — never a normal space after the colon.
      return setCategorySkillParagraph(
        baseXml,
        colon[1],
        colon[2],
        tabStop > 0 ? tabStop : estimateSkillsTabStopTwips([colon[1]]),
        colonSuffix,
        "tab-hanging"
      );
    }
    return setParagraphMarkdown(baseXml, line);
  };

  const next = [...templateParas];

  if (skillBodyIndices.length === 0) {
    const base = templateParas[skillsHeaderIndex];
    const inserted = lines.map((line) => writeSkillLine(base, line));
    next.splice(skillsHeaderIndex + 1, 0, ...inserted);
    return next;
  }

  const slots = skillBodyIndices;
  for (let s = 0; s < slots.length; s += 1) {
    const idx = slots[s];
    const line = lines[s] ?? "";
    if (!line) {
      next[idx] = setParagraphMarkdown(templateParas[idx], "");
      continue;
    }
    next[idx] = writeSkillLine(templateParas[idx], line);
  }

  if (lines.length > slots.length) {
    const lastIdx = slots[slots.length - 1];
    const extras = lines.slice(slots.length).map((line) =>
      writeSkillLine(templateParas[lastIdx], line)
    );
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

function rewriteCombinedJobHeader(
  existingText: string,
  newRole: string
): string {
  const parsed = parseCombinedJobHeader(existingText);
  const role = syncRolePreservingSeniority(parsed.role || existingText, newRole);
  if (parsed.company && parsed.dates) {
    return `${role}, ${parsed.company}, ${parsed.dates}`;
  }
  if (parsed.company) {
    return `${role}, ${parsed.company}`;
  }
  if (parsed.dates) {
    return `${role}, ${parsed.dates}`;
  }
  return role;
}

function fillBulletsExperience(
  paras: string[],
  parsed: ParsedResumeTemplate,
  content: GeneratedResumeContent
): string[] {
  let next = [...paras];

  // Process jobs from last → first so inserts don't shift earlier job indices.
  for (let ji = parsed.jobs.length - 1; ji >= 0; ji -= 1) {
    const job = parsed.jobs[ji];
    const exp = content.experiences[ji];
    if (!exp) continue;

    const desiredRole = exp.role || content.title || job.role;

    if (job.roleParaIndex === job.companyParaIndex) {
      // Franco combined header: "Role, Company, dates" — rewrite role core only.
      const existing = paragraphPlainText(next[job.roleParaIndex] ?? paras[job.roleParaIndex]);
      const rewritten = rewriteCombinedJobHeader(existing, desiredRole);
      next[job.roleParaIndex] = setParagraphMarkdown(
        next[job.roleParaIndex] ?? paras[job.roleParaIndex],
        rewritten
      );
    } else {
      const roleText = syncRolePreservingSeniority(job.role, desiredRole);
      next[job.roleParaIndex] = setParagraphMarkdown(
        next[job.roleParaIndex] ?? paras[job.roleParaIndex],
        roleText
      );
    }

    // Location line stays as-is (template Heading3 / titleofexperience style).

    const bullets = (exp.bullets ?? []).filter((b) => b.trim());
    const slots = [...job.bulletParaIndices];

    // Clear leftover template bullets when writing instructions return fewer;
    // clone last bullet para when AI returns more than template slots.
    for (let bi = 0; bi < slots.length; bi += 1) {
      const pIdx = slots[bi];
      const bullet = bullets[bi] ?? "";
      next[pIdx] = setParagraphMarkdown(next[pIdx] ?? paras[pIdx], bullet);
    }

    if (bullets.length > slots.length && slots.length > 0) {
      const lastIdx = slots[slots.length - 1];
      const extras = bullets.slice(slots.length).map((bullet) =>
        setParagraphMarkdown(paras[lastIdx], bullet)
      );
      next.splice(lastIdx + 1, 0, ...extras);
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

    if (job.roleParaIndex === job.companyParaIndex) {
      const existing = paragraphPlainText(paras[job.roleParaIndex]);
      const rewritten = rewriteCombinedJobHeader(
        existing,
        exp.role || content.title || job.role
      );
      next[job.roleParaIndex] = setParagraphMarkdown(paras[job.roleParaIndex], rewritten);
    } else if (job.roleParaIndex !== job.companyParaIndex) {
      const roleText = syncRolePreservingSeniority(
        job.role,
        exp.role || content.title || job.role
      );
      next[job.roleParaIndex] = setParagraphMarkdown(paras[job.roleParaIndex], roleText);
    }

    const projects = exp.projects ?? [];
    for (let pi = 0; pi < job.projectBlocks.length; pi += 1) {
      const block = job.projectBlocks[pi];
      const project = projects[pi];
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

function shiftJobIndices(
  parsed: ParsedResumeTemplate,
  delta: number
): ParsedResumeTemplate {
  if (delta === 0) return parsed;
  return {
    ...parsed,
    jobs: parsed.jobs.map((j) => ({
      ...j,
      startParaIndex: j.startParaIndex + delta,
      endParaIndex: j.endParaIndex + delta,
      companyParaIndex: j.companyParaIndex + delta,
      roleParaIndex: j.roleParaIndex + delta,
      datesParaIndex: j.datesParaIndex + delta,
      locationParaIndex:
        j.locationParaIndex !== undefined
          ? j.locationParaIndex + delta
          : undefined,
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
}

/**
 * Apply GeneratedResumeContent onto the user's DOCX template via pizzip paragraph rewrite.
 * Matches frontend applyContentToDocx: skill TAB + hanging indent, location freeze, etc.
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

  const experienceIdx = findHeaderIndex(
    paras,
    EXPERIENCE_HEADER_RE,
    findHeaderIndex(paras, SKILLS_HEADER_RE, findHeaderIndex(paras, SUMMARY_HEADER_RE) + 1) + 1
  );

  const delta = experienceIdx - parsed.experienceHeaderIndex;
  const shifted = shiftJobIndices(parsed, delta);

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
