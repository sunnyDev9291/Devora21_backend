import PizZip from "pizzip";
import { AppError } from "../../middleware/errorHandler";
import type { ParsedResumeTemplate, TemplateJobSkeleton, ResumeTemplateLayout } from "./types";
import {
  EDUCATION_HEADER_RE,
  EXPERIENCE_HEADER_RE,
  SKILLS_HEADER_RE,
  SUMMARY_HEADER_RE,
  extractParagraphs,
  findHeaderIndex,
  paragraphPlainText,
} from "./xml-utils";

const PROJECT_FIELD_RE =
  /^(business\s*challenge|assigned\s*responsibility|action|result)\s*:?\s*/i;

export function getParagraphStyle(pXml: string): string {
  return (pXml.match(/w:pStyle\s+w:val="([^"]+)"/) || [])[1] || "";
}

export function looksLikeBullet(pXml: string, text: string): boolean {
  if (/<w:numPr[\s\S]*?<\/w:numPr>/.test(pXml)) return true;
  if (/^[•·\-–—*]/.test(text)) return true;
  return false;
}

export function isDatesLine(t: string): boolean {
  return (
    /\b(19|20)\d{2}\b/.test(t) ||
    /present/i.test(t) ||
    /\d{1,2}\/\d{4}/.test(t)
  );
}

/** Combined header: "Role, Company, 08/2023 – 05/2026" */
export function isCombinedJobHeader(text: string): boolean {
  if (!text || text.length < 8) return false;
  if (!isDatesLine(text)) return false;
  // Role, Company, dates — at least two commas or "Role at Company"
  if ((text.match(/,/g) || []).length >= 2 && /\d{4}/.test(text)) return true;
  if (/,\s*.+\s+[–\-—-]\s*/.test(text) && /\d{4}/.test(text)) return true;
  return false;
}

export function isJobHeaderParagraph(pXml: string, text: string): boolean {
  if (!text) return false;
  if (looksLikeBullet(pXml, text)) return false;
  if (PROJECT_FIELD_RE.test(text)) return false;
  const style = getParagraphStyle(pXml).toLowerCase();
  if (/^heading/.test(style)) return true;
  if (isCombinedJobHeader(text)) return true;
  return false;
}

export function parseCombinedJobHeader(text: string): {
  role: string;
  company: string;
  dates: string;
} {
  const dateMatch = text.match(
    /,\s*((?:0?\d|1[0-2])\/\d{4}\s*[–\-—-]\s*(?:(?:0?\d|1[0-2])\/\d{4}|[Pp]resent)|(?:19|20)\d{2}\s*[–\-—-]\s*(?:(?:19|20)\d{2}|[Pp]resent))\s*$/
  );
  let dates = "";
  let rest = text.trim();
  if (dateMatch && dateMatch.index !== undefined) {
    dates = dateMatch[1].trim();
    rest = text.slice(0, dateMatch.index).trim();
  }
  const lastComma = rest.lastIndexOf(",");
  if (lastComma > 0) {
    return {
      role: rest.slice(0, lastComma).trim(),
      company: rest.slice(lastComma + 1).trim(),
      dates,
    };
  }
  return { role: rest, company: rest, dates };
}

/** Contact / URL lines that must not be overwritten by AI title. */
export function looksLikeContactLine(text: string): boolean {
  if (!text) return false;
  if (/https?:\/\//i.test(text)) return true;
  if (/linkedin\.com/i.test(text)) return true;
  if (/@/.test(text) && /\./.test(text)) return true;
  if (/\+\d/.test(text)) return true;
  if (/\|\s*.+\|\s*/.test(text) && /(gmail|mail|phone|@|\+\d)/i.test(text)) return true;
  return false;
}

/**
 * Professional title line before SUMMARY (Heading2 preferred).
 * Never picks name (first) or contact lines.
 */
export function findTitleParaIndex(
  paragraphs: string[],
  summaryHeaderIndex: number
): number {
  let heading2 = -1;
  const candidates: number[] = [];
  for (let i = 0; i < summaryHeaderIndex; i += 1) {
    const t = paragraphPlainText(paragraphs[i]);
    if (!t) continue;
    if (looksLikeContactLine(t)) continue;
    const style = getParagraphStyle(paragraphs[i]).toLowerCase();
    if (/heading2/.test(style)) {
      heading2 = i;
    }
    candidates.push(i);
  }
  if (heading2 >= 0) return heading2;
  // Skip profile name (first non-empty candidate), prefer next
  if (candidates.length >= 2) return candidates[1];
  if (candidates.length === 1) return candidates[0];
  return -1;
}

function detectLayout(paragraphs: string[], expStart: number, expEnd: number): ResumeTemplateLayout {
  for (let i = expStart; i < expEnd; i += 1) {
    const t = paragraphPlainText(paragraphs[i]);
    if (PROJECT_FIELD_RE.test(t) || /business\s*challenge/i.test(t)) {
      return "projects";
    }
  }
  return "bullets";
}

function splitExperienceJobs(
  paragraphs: string[],
  expStart: number,
  expEnd: number,
  layout: ResumeTemplateLayout
): TemplateJobSkeleton[] {
  const isProjectField = (t: string) => PROJECT_FIELD_RE.test(t);

  // Prefer explicit job headers (Heading* / combined Role, Company, dates)
  const headerIndices: number[] = [];
  for (let i = expStart + 1; i < expEnd; i += 1) {
    const text = paragraphPlainText(paragraphs[i]);
    if (isJobHeaderParagraph(paragraphs[i], text)) {
      headerIndices.push(i);
    }
  }

  const jobs: TemplateJobSkeleton[] = [];

  const buildJob = (blockStart: number, blockEnd: number): TemplateJobSkeleton => {
    const headerText = paragraphPlainText(paragraphs[blockStart]);
    let companyParaIndex = blockStart;
    let roleParaIndex = blockStart;
    let datesParaIndex = blockStart;
    let company = headerText;
    let role = "";
    let dates = "";

    // Multi-line header: Role / Company / Dates on separate following lines
    const headerLines: Array<{ index: number; text: string }> = [
      { index: blockStart, text: headerText },
    ];
    let j = blockStart + 1;
    while (j < blockEnd && headerLines.length < 4) {
      const t = paragraphPlainText(paragraphs[j]);
      if (!t) {
        j += 1;
        continue;
      }
      if (looksLikeBullet(paragraphs[j], t) || isProjectField(t)) break;
      if (isJobHeaderParagraph(paragraphs[j], t) && j !== blockStart) break;
      headerLines.push({ index: j, text: t });
      j += 1;
    }

    if (headerLines.length === 1 && isCombinedJobHeader(headerText)) {
      const parsed = parseCombinedJobHeader(headerText);
      role = parsed.role;
      company = parsed.company;
      dates = parsed.dates;
      // All locked to the same Heading3 paragraph — do not rewrite it during fill.
      companyParaIndex = roleParaIndex = datesParaIndex = blockStart;
    } else if (headerLines.length >= 3 && isDatesLine(headerLines[2].text)) {
      role = headerLines[0].text;
      roleParaIndex = headerLines[0].index;
      company = headerLines[1].text;
      companyParaIndex = headerLines[1].index;
      dates = headerLines[2].text;
      datesParaIndex = headerLines[2].index;
    } else if (headerLines.length >= 2 && isDatesLine(headerLines[1].text)) {
      company = headerLines[0].text;
      companyParaIndex = headerLines[0].index;
      dates = headerLines[1].text;
      datesParaIndex = headerLines[1].index;
      role = company;
      roleParaIndex = companyParaIndex;
    } else if (headerLines.length >= 2) {
      company = headerLines[0].text;
      companyParaIndex = headerLines[0].index;
      role = headerLines[1].text;
      roleParaIndex = headerLines[1].index;
    }

    const bulletParaIndices: number[] = [];
    const projectBlocks: TemplateJobSkeleton["projectBlocks"] = [];
    const headerIdxSet = new Set([companyParaIndex, roleParaIndex, datesParaIndex]);

    if (layout === "bullets") {
      for (let p = blockStart; p < blockEnd; p += 1) {
        if (headerIdxSet.has(p)) continue;
        const t = paragraphPlainText(paragraphs[p]);
        if (!t) continue;
        // Only real list/bullet paragraphs — never Heading* job titles.
        if (looksLikeBullet(paragraphs[p], t)) {
          bulletParaIndices.push(p);
        }
      }
    } else {
      let p = Math.max(datesParaIndex, roleParaIndex, companyParaIndex) + 1;
      while (p < blockEnd) {
        const t = paragraphPlainText(paragraphs[p]);
        if (!t) {
          p += 1;
          continue;
        }
        if (isProjectField(t) || looksLikeBullet(paragraphs[p], t)) {
          p += 1;
          continue;
        }
        if (isJobHeaderParagraph(paragraphs[p], t)) break;

        const nameParaIndex = p;
        const name = t;
        const fieldParaIndices: TemplateJobSkeleton["projectBlocks"][0]["fieldParaIndices"] =
          {};
        p += 1;
        while (p < blockEnd) {
          const ft = paragraphPlainText(paragraphs[p]);
          if (!ft) {
            p += 1;
            continue;
          }
          const fm = ft.match(PROJECT_FIELD_RE);
          if (fm) {
            const key = fm[1].toLowerCase().replace(/\s+/g, "");
            if (key.startsWith("business")) fieldParaIndices.businessChallenge = p;
            else if (key.startsWith("assigned")) fieldParaIndices.assignedResponsibility = p;
            else if (key.startsWith("action")) fieldParaIndices.action = p;
            else if (key.startsWith("result")) fieldParaIndices.result = p;
            p += 1;
            continue;
          }
          break;
        }
        projectBlocks.push({ name, nameParaIndex, fieldParaIndices });
      }
    }

    return {
      company,
      role,
      dates,
      bulletCount: layout === "bullets" ? Math.max(bulletParaIndices.length, 1) : 0,
      projectNames: projectBlocks.map((b) => b.name),
      startParaIndex: blockStart,
      endParaIndex: blockEnd,
      companyParaIndex,
      roleParaIndex,
      datesParaIndex,
      bulletParaIndices,
      projectBlocks,
    };
  };

  if (headerIndices.length > 0) {
    for (let h = 0; h < headerIndices.length; h += 1) {
      const start = headerIndices[h];
      const end = h + 1 < headerIndices.length ? headerIndices[h + 1] : expEnd;
      jobs.push(buildJob(start, end));
    }
    return jobs;
  }

  // Fallback: older multi-line company/role/dates templates without Heading styles
  let i = expStart + 1;
  while (i < expEnd) {
    const text = paragraphPlainText(paragraphs[i]);
    if (!text || looksLikeBullet(paragraphs[i], text) || isProjectField(text)) {
      i += 1;
      continue;
    }
    let blockEnd = expEnd;
    for (let k = i + 1; k < expEnd; k += 1) {
      const t = paragraphPlainText(paragraphs[k]);
      if (
        t &&
        !looksLikeBullet(paragraphs[k], t) &&
        !isProjectField(t) &&
        isDatesLine(paragraphPlainText(paragraphs[k + 1] ?? ""))
      ) {
        blockEnd = k;
        break;
      }
    }
    jobs.push(buildJob(i, blockEnd));
    i = blockEnd;
  }

  return jobs;
}

export function parseResumeTemplate(templateBuffer: Buffer): ParsedResumeTemplate {
  let zip: PizZip;
  try {
    zip = new PizZip(templateBuffer);
  } catch {
    throw new AppError(422, "Invalid resume template DOCX");
  }

  const file = zip.file("word/document.xml");
  if (!file) {
    throw new AppError(422, "Invalid resume template: missing word/document.xml");
  }

  const documentXml = file.asText();
  const paragraphs = extractParagraphs(documentXml);

  const summaryHeaderIndex = findHeaderIndex(paragraphs, SUMMARY_HEADER_RE);
  const skillsHeaderIndex = findHeaderIndex(
    paragraphs,
    SKILLS_HEADER_RE,
    summaryHeaderIndex >= 0 ? summaryHeaderIndex + 1 : 0
  );
  const experienceHeaderIndex = findHeaderIndex(
    paragraphs,
    EXPERIENCE_HEADER_RE,
    skillsHeaderIndex >= 0 ? skillsHeaderIndex + 1 : 0
  );
  let educationHeaderIndex = findHeaderIndex(
    paragraphs,
    EDUCATION_HEADER_RE,
    experienceHeaderIndex >= 0 ? experienceHeaderIndex + 1 : 0
  );
  if (educationHeaderIndex < 0) {
    educationHeaderIndex = -1;
  }

  if (summaryHeaderIndex < 0 || skillsHeaderIndex < 0 || experienceHeaderIndex < 0) {
    throw new AppError(
      422,
      "Resume template missing required SUMMARY / SKILLS / EXPERIENCE section headers"
    );
  }
  if (!(summaryHeaderIndex < skillsHeaderIndex && skillsHeaderIndex < experienceHeaderIndex)) {
    throw new AppError(422, "Resume template section headers are out of order");
  }

  const expEnd = educationHeaderIndex > 0 ? educationHeaderIndex : paragraphs.length;
  const layout = detectLayout(paragraphs, experienceHeaderIndex, expEnd);
  const jobs = splitExperienceJobs(paragraphs, experienceHeaderIndex, expEnd, layout);
  if (jobs.length === 0) {
    throw new AppError(422, "Resume template has no experience entries to fill");
  }

  const skillsSample = paragraphs
    .slice(skillsHeaderIndex + 1, experienceHeaderIndex)
    .map(paragraphPlainText)
    .filter(Boolean)
    .join("\n");

  const titleIdx = findTitleParaIndex(paragraphs, summaryHeaderIndex);
  const headerTitle =
    titleIdx >= 0 ? paragraphPlainText(paragraphs[titleIdx]) : "";

  let profileName = "";
  for (let i = 0; i < summaryHeaderIndex; i += 1) {
    const t = paragraphPlainText(paragraphs[i]);
    if (!t || looksLikeContactLine(t)) continue;
    profileName = t.split("|")[0].trim();
    break;
  }

  return {
    layout,
    profileName,
    headerTitle,
    skillsSample,
    jobs,
    summaryHeaderIndex,
    skillsHeaderIndex,
    experienceHeaderIndex,
    educationHeaderIndex: educationHeaderIndex >= 0 ? educationHeaderIndex : null,
    paragraphs,
    documentXml,
  };
}

export function openTemplateZip(templateBuffer: Buffer): PizZip {
  return new PizZip(templateBuffer);
}
