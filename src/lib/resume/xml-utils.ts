/** WordprocessingML helpers for paragraph rewrite (pizzip path). */

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function extractParagraphs(documentXml: string): string[] {
  const matches = documentXml.match(/<w:p[\s\S]*?<\/w:p>/g);
  return matches ?? [];
}

export function paragraphPlainText(pXml: string): string {
  const parts: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml)) !== null) {
    parts.push(unescapeXml(m[1]));
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function getParagraphProps(pXml: string): string {
  const m = pXml.match(/<w:pPr[\s\S]*?<\/w:pPr>/);
  return m?.[0] ?? "";
}

/** Prefer rPr from the first text run (keeps Candara Light / colors). */
export function getFirstRunProps(pXml: string): string {
  const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(pXml)) !== null) {
    if (!/<w:t\b/i.test(m[0])) continue;
    const rPr = m[0].match(/<w:rPr[\s\S]*?<\/w:rPr>/);
    if (rPr) return rPr[0];
  }
  const any = pXml.match(/<w:rPr[\s\S]*?<\/w:rPr>/);
  return any?.[0] ?? "";
}

/**
 * Shared left tab stop for skill category lines (twips).
 * One POS for every line so tech items form a vertical column.
 * max(2200, ceil(((longestLabel + 2) * 140 + 400) / 180) * 180)
 */
export function estimateSkillsTabStopTwips(categoryLabels: string[]): number {
  const longest = categoryLabels.reduce((max, label) => {
    const len = label.replace(/:$/, "").trim().length;
    return Math.max(max, len);
  }, 0);
  const raw = (longest + 2) * 140 + 400;
  const rounded = Math.ceil(raw / 180) * 180;
  return Math.max(2200, rounded);
}

/** Inject shared left tab stop + hanging indent into paragraph properties. */
export function upsertParagraphTabsAndHanging(pPr: string, posTwips: number): string {
  const tabsXml = `<w:tabs><w:tab w:val="left" w:pos="${posTwips}"/></w:tabs>`;
  const indXml = `<w:ind w:left="${posTwips}" w:hanging="${posTwips}"/>`;

  let props = pPr;
  if (!props || props === "<w:pPr/>" || props === "<w:pPr></w:pPr>") {
    return `<w:pPr>${tabsXml}${indXml}</w:pPr>`;
  }

  props = props
    .replace(/<w:tabs\b[^/]*\/>/g, "")
    .replace(/<w:tabs\b[^>]*>[\s\S]*?<\/w:tabs>/g, "")
    .replace(/<w:ind\b[^/]*\/>/g, "")
    .replace(/<w:ind\b[^>]*>[\s\S]*?<\/w:ind>/g, "");

  if (/<\/w:pPr>/.test(props)) {
    return props.replace(/<\/w:pPr>/, `${tabsXml}${indXml}</w:pPr>`);
  }
  return props.replace(/<w:pPr([^>]*)\/>/, `<w:pPr$1>${tabsXml}${indXml}</w:pPr>`);
}

export function replaceParagraphContent(
  pXml: string,
  runsXml: string,
  pPrOverride?: string
): string {
  const open = pXml.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const pPr = pPrOverride ?? getParagraphProps(pXml);
  return `${open}${pPr}${runsXml}</w:p>`;
}

/**
 * Preserve base run formatting (font/color/size) and toggle bold only.
 * Always use Latin <w:b/> (not only <w:bCs/>) so bold shows in PDF.
 */
function cleanRPrForBold(rPr: string, bold: boolean): string {
  let props = rPr;
  if (!props || props === "<w:rPr/>" || props === "<w:rPr></w:rPr>") {
    return bold ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : "<w:rPr/>";
  }
  props = props
    .replace(/<w:b\b[^/]*\/>/g, "")
    .replace(/<w:bCs\b[^/]*\/>/g, "")
    .replace(/<w:b\b[^>]*>[\s\S]*?<\/w:b>/g, "")
    .replace(/<w:bCs\b[^>]*>[\s\S]*?<\/w:bCs>/g, "");
  if (bold) {
    if (/<\/w:rPr>/.test(props)) {
      props = props.replace(/<\/w:rPr>/, "<w:b/><w:bCs/></w:rPr>");
    } else {
      props = props.replace(/<w:rPr([^>]*)\/>/, "<w:rPr$1><w:b/><w:bCs/></w:rPr>");
    }
  }
  return props;
}

function makeRun(text: string, rPr: string, bold: boolean): string {
  const props = cleanRPrForBold(rPr, bold);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${props}<w:t${space}>${escapeXml(text)}</w:t></w:r>`;
}

function makeTabRun(rPr: string): string {
  const props = cleanRPrForBold(rPr, false);
  return `<w:r>${props}<w:tab/></w:r>`;
}

/**
 * Convert markdown **bold** segments into Word runs.
 * Keeps surrounding punctuation; does not strip asterisks incorrectly.
 */
export function runsFromMarkdown(text: string, baseRPr = ""): string {
  const parts: string[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(makeRun(text.slice(last, m.index), baseRPr, false));
    }
    parts.push(makeRun(m[1], baseRPr, true));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(makeRun(text.slice(last), baseRPr, false));
  }
  if (parts.length === 0) {
    parts.push(makeRun("", baseRPr, false));
  }
  return parts.join("");
}

/**
 * Skills category line runs: bold label + plain colon + TAB + plain values.
 * Do NOT put a normal space after the colon — the tab creates the column gap.
 * Preserves template run props (Franco blue color, size, fonts).
 */
export function runsForCategorySkillLine(
  label: string,
  value: string,
  baseRPr = "",
  _colonSuffix = ":"
): string {
  const bare = label.replace(/:$/, "").trim();
  void _colonSuffix;
  return (
    makeRun(bare, baseRPr, true) +
    makeRun(":", baseRPr, false) +
    makeTabRun(baseRPr) +
    makeRun(value.trim(), baseRPr, false)
  );
}

/** Franco / category templates use bare ":" then TAB. */
export function detectColonSuffix(_sampleLine: string): string {
  void _sampleLine;
  return ":";
}

export function setParagraphMarkdown(pXml: string, text: string): string {
  const rPr = getFirstRunProps(pXml);
  return replaceParagraphContent(pXml, runsFromMarkdown(text, rPr));
}

export type SkillCategoryFillMode = "tab-hanging";

/**
 * Always use an explicit shared left tab stop + hanging indent.
 * Bare <w:tab/> with only defaultTabStop (Franco XML) looks uneven in
 * Word and often collapses to a normal space in LibreOffice PDF.
 */
export function detectSkillCategoryFillMode(
  _skillParagraphXmls: string[]
): SkillCategoryFillMode {
  void _skillParagraphXmls;
  return "tab-hanging";
}

export function setCategorySkillParagraph(
  pXml: string,
  label: string,
  value: string,
  tabStopTwips: number,
  colonSuffix = ":",
  _mode: SkillCategoryFillMode = "tab-hanging"
): string {
  void _mode;
  const rPr = getFirstRunProps(pXml);
  // Preserve template spacing/color in pPr; inject one shared tab stop + hanging.
  const pPr = upsertParagraphTabsAndHanging(
    getParagraphProps(pXml),
    tabStopTwips
  );
  return replaceParagraphContent(
    pXml,
    runsForCategorySkillLine(label, value, rPr, colonSuffix),
    pPr
  );
}

export function rebuildDocumentXml(originalXml: string, paragraphs: string[]): string {
  const bodyMatch = originalXml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) {
    throw new Error("Invalid DOCX: missing w:body");
  }

  const bodyInner = bodyMatch[1];
  const sectPrMatch = bodyInner.match(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/);
  const sectPr = sectPrMatch?.[0] ?? "";
  const newBody = `${paragraphs.join("")}${sectPr}`;
  return originalXml.replace(bodyMatch[0], `<w:body>${newBody}</w:body>`);
}

export const SUMMARY_HEADER_RE =
  /^(professional\s+summary|summary)\s*:?\s*$/i;
export const SKILLS_HEADER_RE =
  /^(technical\s+skills|skillsets|skills)\s*:?\s*$/i;
export const EXPERIENCE_HEADER_RE =
  /^(work\s+experience|experience|professional\s+experience)\s*:?\s*$/i;
export const EDUCATION_HEADER_RE =
  /^(education|certifications|certificates|awards|languages)\s*:?\s*$/i;

export function findHeaderIndex(
  paragraphs: string[],
  re: RegExp,
  from = 0
): number {
  for (let i = from; i < paragraphs.length; i += 1) {
    if (re.test(paragraphPlainText(paragraphs[i]))) {
      return i;
    }
  }
  return -1;
}
