import PizZip from "pizzip";
import { AppError } from "../../middleware/errorHandler";
import type {
  HeaderStyleSlots,
  ParsedResumeTemplate,
  StyleSlotIndex,
  TemplateJobSkeleton,
  ResumeTemplateLayout,
} from "./types";
import {
  EDUCATION_HEADER_RE,
  EXPERIENCE_HEADER_RE,
  SKILLS_HEADER_RE,
  SUMMARY_HEADER_RE,
  extractParagraphs,
  findHeaderIndex,
  paragraphPlainText,
} from "./xml-utils";
import {
  looksLikeStyledTemplate,
  styleMatches,
} from "./style-map";

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

/**
 * Joao/Franco workplace line under the job header
 * (e.g. "Indianapolis, Indiana, USA | Remote | Contract").
 * Must stay frozen — never treated as a job header or bullet.
 */
export function looksLikeLocationLine(text: string): boolean {
  if (!text || text.length > 120) return false;
  if (isDatesLine(text)) return false;
  if (PROJECT_FIELD_RE.test(text)) return false;
  // Franco: "City, State, Country | Remote | Contract"
  if (/\|\s*(remote|hybrid|on[- ]?site|onsite|wfh)\b/i.test(text)) return true;
  if (/\|.+\|\s*(contract|full\s*time|part\s*time|permanent|freelance)\b/i.test(text)) {
    return true;
  }
  if (/^(remote|hybrid|on[- ]?site|onsite)(\b|[|,·])/i.test(text) && text.split(/\s+/).length <= 8) {
    return true;
  }
  if (/^[A-Za-zÀ-ÿ .'-]{2,40}\s*\|\s*[A-Za-zÀ-ÿ .'-]{2,30}$/.test(text)) {
    return true;
  }
  return false;
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
  // Franco/Joao location lines often reuse Heading3 — never treat as a new job.
  if (looksLikeLocationLine(text)) return false;
  const style = getParagraphStyle(pXml).toLowerCase();
  if (isCombinedJobHeader(text)) return true;
  if (/titleofexperience/i.test(style)) return true;
  if (/^heading/.test(style)) return true;
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
      if (looksLikeLocationLine(t)) break;
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

    // Location line sits after header (role/company/dates), before bullets — keep frozen.
    let locationParaIndex: number | undefined;
    const afterHeader =
      Math.max(datesParaIndex, roleParaIndex, companyParaIndex, blockStart) + 1;
    for (let p = afterHeader; p < blockEnd; p += 1) {
      const t = paragraphPlainText(paragraphs[p]);
      if (!t) continue;
      if (looksLikeBullet(paragraphs[p], t) || isProjectField(t)) break;
      if (looksLikeLocationLine(t)) {
        locationParaIndex = p;
        headerIdxSet.add(p);
      }
      break;
    }

    if (layout === "bullets") {
      for (let p = blockStart; p < blockEnd; p += 1) {
        if (headerIdxSet.has(p)) continue;
        const t = paragraphPlainText(paragraphs[p]);
        if (looksLikeLocationLine(t)) continue;
        // Count list slots even when empty (numPr with no text still occupies a slot).
        if (looksLikeBullet(paragraphs[p], t)) {
          bulletParaIndices.push(p);
        }
      }
    } else {
      let p = Math.max(datesParaIndex, roleParaIndex, companyParaIndex) + 1;
      if (locationParaIndex !== undefined) {
        p = Math.max(p, locationParaIndex + 1);
      }
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
        if (looksLikeLocationLine(t)) {
          p += 1;
          continue;
        }

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

    const bulletSamples = bulletParaIndices.map((i) =>
      paragraphPlainText(paragraphs[i])
    );

    return {
      company,
      role,
      dates,
      // Exact template slot count — never invent a phantom bullet.
      bulletCount: layout === "bullets" ? bulletParaIndices.length : 0,
      projectNames: projectBlocks.map((b) => b.name),
      startParaIndex: blockStart,
      endParaIndex: blockEnd,
      companyParaIndex,
      roleParaIndex,
      datesParaIndex,
      locationParaIndex,
      bulletParaIndices,
      bulletSamples,
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

function collectHeaderParts(zip: PizZip): HeaderStyleSlots[] {
  const parts: HeaderStyleSlots[] = [];
  for (const key of Object.keys(zip.files)) {
    if (!/^word\/header\d*\.xml$/i.test(key)) continue;
    const file = zip.file(key);
    if (!file) continue;
    const xml = file.asText();
    const paragraphs = extractParagraphs(xml);
    let nameIndex: number | undefined;
    let titleIndex: number | undefined;
    paragraphs.forEach((pXml, i) => {
      const style = getParagraphStyle(pXml);
      if (styleMatches(style, "headerName") || styleMatches(style, "name")) {
        if (nameIndex === undefined) nameIndex = i;
      }
      if (styleMatches(style, "headerTitle") || styleMatches(style, "title")) {
        if (titleIndex === undefined) titleIndex = i;
      }
    });
    if (nameIndex !== undefined || titleIndex !== undefined) {
      parts.push({ partPath: key, xml, paragraphs, nameIndex, titleIndex });
    }
  }
  return parts;
}

function findSectionHeader(
  paragraphs: string[],
  re: RegExp,
  from = 0
): number {
  for (let i = from; i < paragraphs.length; i += 1) {
    const style = getParagraphStyle(paragraphs[i]);
    // Avoid false positives like skillcat "Languages" matching EDUCATION regex.
    if (styleMatches(style, "skillCat") || styleMatches(style, "skillItem")) {
      continue;
    }
    if (styleMatches(style, "expSection")) continue;
    if (re.test(paragraphPlainText(paragraphs[i]))) return i;
  }
  return -1;
}

/** "Liberty Mutual Insurance | Senior Software Engineer" → company + role. */
function parseCompanyPipeRole(text: string): { company: string; role: string } {
  const parts = text
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return { company: parts[0], role: parts.slice(1).join(" | ") };
  }
  return { company: text.trim(), role: text.trim() };
}

function collectJobStartsByStyle(
  paragraphs: string[],
  expStart: number,
  expEnd: number,
  field: "companyPeriod" | "companyName" | "companyRole"
): number[] {
  const starts: number[] = [];
  for (let i = expStart; i < expEnd; i += 1) {
    if (styleMatches(getParagraphStyle(paragraphs[i]), field)) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * Templates that style only exp_section (date + "Company | Role" left Normal).
 * Group contiguous exp_section runs; pull date/company lines from above each run.
 */
function parseStyledJobsFromExpSections(
  paragraphs: string[],
  expStart: number,
  expEnd: number
): TemplateJobSkeleton[] {
  const jobs: TemplateJobSkeleton[] = [];
  let i = expStart;
  while (i < expEnd) {
    if (!styleMatches(getParagraphStyle(paragraphs[i]), "expSection")) {
      i += 1;
      continue;
    }

    const bulletStart = i;
    while (
      i < expEnd &&
      styleMatches(getParagraphStyle(paragraphs[i]), "expSection")
    ) {
      i += 1;
    }
    const bulletParaIndices: number[] = [];
    for (let p = bulletStart; p < i; p += 1) {
      bulletParaIndices.push(p);
    }
    if (bulletParaIndices.length === 0) continue;

    // Walk upward for unstyled header lines (skip empties).
    const above: Array<{ idx: number; text: string }> = [];
    for (let p = bulletStart - 1; p >= expStart && above.length < 4; p -= 1) {
      const style = getParagraphStyle(paragraphs[p]);
      if (styleMatches(style, "expSection")) break;
      if (
        styleMatches(style, "skillCat") ||
        styleMatches(style, "skillItem") ||
        styleMatches(style, "summary")
      ) {
        break;
      }
      const text = paragraphPlainText(paragraphs[p]);
      if (!text) continue;
      // Stop at section titles like "Experience" / "Education".
      if (EXPERIENCE_HEADER_RE.test(text) || EDUCATION_HEADER_RE.test(text)) {
        break;
      }
      above.push({ idx: p, text });
    }

    let dates = "";
    let datesParaIndex = bulletParaIndices[0];
    let company = "";
    let role = "";
    let companyParaIndex = bulletParaIndices[0];
    let roleParaIndex = bulletParaIndices[0];
    let locationParaIndex: number | undefined;
    let blockStart = bulletParaIndices[0];

    // Typical order above bullets: [dates, company|role] (closest = company line).
    const nearest = above[0];
    const second = above[1];
    if (nearest && !isDatesLine(nearest.text)) {
      const parsed = parseCompanyPipeRole(nearest.text);
      company = parsed.company;
      role = parsed.role;
      companyParaIndex = nearest.idx;
      roleParaIndex = nearest.idx;
      blockStart = Math.min(blockStart, nearest.idx);
      if (looksLikeLocationLine(nearest.text)) {
        locationParaIndex = nearest.idx;
      }
    } else if (nearest && isDatesLine(nearest.text)) {
      dates = nearest.text;
      datesParaIndex = nearest.idx;
      blockStart = Math.min(blockStart, nearest.idx);
    }

    if (second) {
      if (isDatesLine(second.text) && !dates) {
        dates = second.text;
        datesParaIndex = second.idx;
        blockStart = Math.min(blockStart, second.idx);
      } else if (!company && !isDatesLine(second.text)) {
        const parsed = parseCompanyPipeRole(second.text);
        company = parsed.company;
        role = parsed.role;
        companyParaIndex = second.idx;
        roleParaIndex = second.idx;
        blockStart = Math.min(blockStart, second.idx);
      }
    }

    // If nearest was dates and second was company (unusual order), swap handled above.
    if (!dates && nearest && isDatesLine(nearest.text)) {
      dates = nearest.text;
      datesParaIndex = nearest.idx;
    }

    const bulletSamples = bulletParaIndices.map((idx) =>
      paragraphPlainText(paragraphs[idx])
    );

    jobs.push({
      company: company || role || "Company",
      role: role || company || "Role",
      dates: dates || "",
      bulletCount: bulletParaIndices.length,
      projectNames: [],
      startParaIndex: blockStart,
      endParaIndex: i,
      companyParaIndex,
      roleParaIndex,
      datesParaIndex,
      locationParaIndex,
      bulletParaIndices,
      bulletSamples,
      projectBlocks: [],
    });
  }
  return jobs;
}

function parseStyledJobs(
  paragraphs: string[],
  expStart: number,
  expEnd: number
): TemplateJobSkeleton[] {
  let jobStarts = collectJobStartsByStyle(
    paragraphs,
    expStart,
    expEnd,
    "companyPeriod"
  );
  if (jobStarts.length === 0) {
    jobStarts = collectJobStartsByStyle(
      paragraphs,
      expStart,
      expEnd,
      "companyName"
    );
  }
  if (jobStarts.length === 0) {
    jobStarts = collectJobStartsByStyle(
      paragraphs,
      expStart,
      expEnd,
      "companyRole"
    );
  }

  // Bullets styled, company headers left as Normal — still a valid Mode-1 template.
  if (jobStarts.length === 0) {
    return parseStyledJobsFromExpSections(paragraphs, expStart, expEnd);
  }

  const jobs: TemplateJobSkeleton[] = [];
  for (let h = 0; h < jobStarts.length; h += 1) {
    const start = jobStarts[h];
    const end = h + 1 < jobStarts.length ? jobStarts[h + 1] : expEnd;

    let companyParaIndex = start;
    let roleParaIndex = start;
    let datesParaIndex = start;
    let locationParaIndex: number | undefined;
    let company = "";
    let role = "";
    let dates = "";
    const bulletParaIndices: number[] = [];

    for (let p = start; p < end; p += 1) {
      const style = getParagraphStyle(paragraphs[p]);
      const text = paragraphPlainText(paragraphs[p]);
      if (styleMatches(style, "companyPeriod")) {
        datesParaIndex = p;
        dates = text;
      } else if (styleMatches(style, "companyLocation")) {
        locationParaIndex = p;
      } else if (styleMatches(style, "companyName")) {
        companyParaIndex = p;
        company = text;
      } else if (styleMatches(style, "companyRole")) {
        roleParaIndex = p;
        role = text;
      } else if (styleMatches(style, "expSection")) {
        bulletParaIndices.push(p);
      } else if (looksLikeBullet(paragraphs[p], text)) {
        bulletParaIndices.push(p);
      }
    }

    // Unstyled "Company | Role" / dates inside a styled job block.
    if (!company || !role || !dates) {
      for (let p = start; p < end; p += 1) {
        const style = getParagraphStyle(paragraphs[p]);
        if (
          styleMatches(style, "companyPeriod") ||
          styleMatches(style, "companyName") ||
          styleMatches(style, "companyRole") ||
          styleMatches(style, "companyLocation") ||
          styleMatches(style, "expSection")
        ) {
          continue;
        }
        const text = paragraphPlainText(paragraphs[p]);
        if (!text) continue;
        if (!dates && isDatesLine(text)) {
          dates = text;
          datesParaIndex = p;
        } else if (!company && text.includes("|")) {
          const parsed = parseCompanyPipeRole(text);
          company = parsed.company;
          role = parsed.role || role;
          companyParaIndex = p;
          roleParaIndex = p;
        }
      }
    }

    const bulletSamples = bulletParaIndices.map((idx) =>
      paragraphPlainText(paragraphs[idx])
    );

    jobs.push({
      company: company || role || "Company",
      role: role || company || "Role",
      dates: dates || "",
      bulletCount: bulletParaIndices.length,
      projectNames: [],
      startParaIndex: start,
      endParaIndex: end,
      companyParaIndex,
      roleParaIndex,
      datesParaIndex,
      locationParaIndex,
      bulletParaIndices,
      bulletSamples,
      projectBlocks: [],
    });
  }
  return jobs;
}

function parseStyledTemplate(
  zip: PizZip,
  documentXml: string,
  paragraphs: string[]
): ParsedResumeTemplate {
  const headerParts = collectHeaderParts(zip);

  const styleSlots: StyleSlotIndex = {
    summaryBodyIndices: [],
    skillCatIndices: [],
    skillItemIndices: [],
  };

  paragraphs.forEach((pXml, i) => {
    const style = getParagraphStyle(pXml);
    if (styleMatches(style, "name") && styleSlots.name === undefined) styleSlots.name = i;
    if (styleMatches(style, "title") && !styleMatches(style, "headerTitle") && styleSlots.title === undefined) {
      styleSlots.title = i;
    }
    if (styleMatches(style, "country") && styleSlots.country === undefined) styleSlots.country = i;
    if (styleMatches(style, "phone") && styleSlots.phone === undefined) styleSlots.phone = i;
    if (styleMatches(style, "email") && styleSlots.email === undefined) styleSlots.email = i;
    if (styleMatches(style, "linkedin") && styleSlots.linkedin === undefined) styleSlots.linkedin = i;
    if (styleMatches(style, "summary")) styleSlots.summaryBodyIndices.push(i);
    if (styleMatches(style, "skillCat")) styleSlots.skillCatIndices.push(i);
    if (styleMatches(style, "skillItem")) styleSlots.skillItemIndices.push(i);
    if (styleMatches(style, "degree") && styleSlots.degree === undefined) styleSlots.degree = i;
    if (styleMatches(style, "universityName") && styleSlots.universityName === undefined) {
      styleSlots.universityName = i;
    }
    if (styleMatches(style, "universityPeriod") && styleSlots.universityPeriod === undefined) {
      styleSlots.universityPeriod = i;
    }
  });

  // Prefer body Name over header for profileName sample; title from resumetitle.
  let profileName =
    styleSlots.name !== undefined
      ? paragraphPlainText(paragraphs[styleSlots.name])
      : "";
  if (!profileName && headerParts[0]?.nameIndex !== undefined) {
    profileName = paragraphPlainText(headerParts[0].paragraphs[headerParts[0].nameIndex]);
  }

  let headerTitle =
    styleSlots.title !== undefined
      ? paragraphPlainText(paragraphs[styleSlots.title])
      : "";
  if (!headerTitle && headerParts[0]?.titleIndex !== undefined) {
    headerTitle = paragraphPlainText(
      headerParts[0].paragraphs[headerParts[0].titleIndex!]
    );
  }

  const summaryHeaderIndex = findSectionHeader(paragraphs, SUMMARY_HEADER_RE);
  let skillsHeaderIndex = findSectionHeader(
    paragraphs,
    SKILLS_HEADER_RE,
    summaryHeaderIndex >= 0 ? summaryHeaderIndex + 1 : 0
  );
  // Fallback: first skillcat marks skills section
  if (skillsHeaderIndex < 0 && styleSlots.skillCatIndices[0] !== undefined) {
    skillsHeaderIndex = Math.max(0, styleSlots.skillCatIndices[0] - 1);
  }

  let experienceHeaderIndex = findSectionHeader(
    paragraphs,
    EXPERIENCE_HEADER_RE,
    skillsHeaderIndex >= 0 ? skillsHeaderIndex + 1 : 0
  );
  // Accept "Work History" for styled templates
  if (experienceHeaderIndex < 0) {
    experienceHeaderIndex = findSectionHeader(
      paragraphs,
      /^(work\s+history|employment|career)\s*:?\s*$/i,
      skillsHeaderIndex >= 0 ? skillsHeaderIndex + 1 : 0
    );
  }
  // Fallback: first company period / company name / exp_section
  if (experienceHeaderIndex < 0) {
    for (let i = 0; i < paragraphs.length; i += 1) {
      const style = getParagraphStyle(paragraphs[i]);
      if (
        styleMatches(style, "companyPeriod") ||
        styleMatches(style, "companyName") ||
        styleMatches(style, "companyRole") ||
        styleMatches(style, "expSection")
      ) {
        experienceHeaderIndex = Math.max(0, i - 1);
        break;
      }
    }
  }

  let educationHeaderIndex = findSectionHeader(
    paragraphs,
    /^(education|certifications|certificates|awards)\s*:?\s*$/i,
    experienceHeaderIndex >= 0 ? experienceHeaderIndex + 1 : 0
  );
  if (educationHeaderIndex < 0 && styleSlots.degree !== undefined) {
    educationHeaderIndex = Math.max(0, styleSlots.degree - 1);
  }

  const hasSummary =
    summaryHeaderIndex >= 0 || styleSlots.summaryBodyIndices.length > 0;
  const hasSkills =
    skillsHeaderIndex >= 0 ||
    styleSlots.skillCatIndices.length > 0 ||
    styleSlots.skillItemIndices.length > 0;
  const hasExperience = experienceHeaderIndex >= 0;

  if (!hasSummary || !hasSkills || !hasExperience) {
    throw new AppError(
      422,
      "Styled resume template missing required summary / skills / experience structure"
    );
  }

  // Synthetic header indices for fill helpers when text headers are missing
  const summaryIdx =
    summaryHeaderIndex >= 0
      ? summaryHeaderIndex
      : Math.max(0, (styleSlots.summaryBodyIndices[0] ?? 1) - 1);
  const skillsIdx =
    skillsHeaderIndex >= 0
      ? skillsHeaderIndex
      : Math.max(summaryIdx + 1, (styleSlots.skillCatIndices[0] ?? summaryIdx + 2) - 1);
  const experienceIdx =
    experienceHeaderIndex >= 0 ? experienceHeaderIndex : skillsIdx + 1;

  const expEnd =
    educationHeaderIndex > experienceIdx ? educationHeaderIndex : paragraphs.length;
  const jobs = parseStyledJobs(paragraphs, experienceIdx, expEnd);
  if (jobs.length === 0) {
    throw new AppError(422, "Resume template has no experience entries to fill");
  }

  const skillsSample = [
    ...styleSlots.skillCatIndices.map((i, n) => {
      const cat = paragraphPlainText(paragraphs[i]);
      const itemIdx = styleSlots.skillItemIndices[n];
      const item =
        itemIdx !== undefined ? paragraphPlainText(paragraphs[itemIdx]) : "";
      return item ? `${cat}: ${item}` : cat;
    }),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    mode: "styled",
    layout: "bullets",
    profileName,
    headerTitle,
    skillsSample,
    jobs,
    summaryHeaderIndex: summaryIdx,
    skillsHeaderIndex: skillsIdx,
    experienceHeaderIndex: experienceIdx,
    educationHeaderIndex: educationHeaderIndex >= 0 ? educationHeaderIndex : null,
    paragraphs,
    documentXml,
    styleSlots,
    headerParts,
  };
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
  const styleIds = paragraphs.map(getParagraphStyle);
  for (const key of Object.keys(zip.files)) {
    if (!/^word\/header\d*\.xml$/i.test(key)) continue;
    const hdr = zip.file(key)?.asText();
    if (!hdr) continue;
    extractParagraphs(hdr).forEach((p) => styleIds.push(getParagraphStyle(p)));
  }

  if (!looksLikeStyledTemplate(styleIds)) {
    throw new AppError(
      422,
      "Resume template must use styled mode (Name, summary, skill_cat/skill_item, company_*, exp_section, etc.). Legacy text-header templates are not supported."
    );
  }

  return parseStyledTemplate(zip, documentXml, paragraphs);
}

export function openTemplateZip(templateBuffer: Buffer): PizZip {
  return new PizZip(templateBuffer);
}
