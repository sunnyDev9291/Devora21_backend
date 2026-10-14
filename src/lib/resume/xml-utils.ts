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

/** Match a single w:p, including empty self-closing `<w:p .../>`. Fresh /g each call — avoids lastIndex bugs. */
function paragraphRe(): RegExp {
  return /<w:p\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:p>)/g;
}

export function extractParagraphs(documentXml: string): string[] {
  const matches = documentXml.match(paragraphRe());
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

/**
 * Keep icon / image runs when rewriting paragraph text.
 * Contact rows and section headers often put a drawing in the same <w:p> as text;
 * dropping them makes the filled DOCX look nothing like the template.
 */
export function extractDrawingRuns(pXml: string): string {
  const out: string[] = [];
  const runRe = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(pXml)) !== null) {
    if (!/w:drawing|w:pict|v:imagedata|w:object/i.test(m[0])) continue;
    // Strip old text from drawing runs so placeholder words are not duplicated.
    out.push(
      m[0]
        .replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, "")
        .replace(/<w:t\b[^>]*\/>/g, "")
    );
  }
  return out.join("");
}

export function replaceParagraphContent(
  pXml: string,
  runsXml: string,
  pPrOverride?: string
): string {
  // Empty spacer cells often use self-closing <w:p .../>; expand when writing text.
  const selfClosing = pXml.match(/^<w:p\b([^>]*?)\s*\/>\s*$/);
  if (selfClosing) {
    const pPr = pPrOverride ?? "";
    return `<w:p${selfClosing[1]}>${pPr}${runsXml}</w:p>`;
  }

  const open = pXml.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const pPr = pPrOverride ?? getParagraphProps(pXml);
  const drawings = extractDrawingRuns(pXml);
  return `${open}${pPr}${drawings}${runsXml}</w:p>`;
}

/** True when the paragraph has no visible text (drawings-only spacers are OK). */
export function paragraphHasVisibleText(pXml: string): boolean {
  return Boolean(paragraphPlainText(pXml));
}

export type RunBoldMode = boolean | "off" | "inherit";

/**
 * Preserve base run formatting (font/color/size) and toggle bold only.
 * Always use Latin <w:b/> (not only <w:bCs/>) so bold shows in PDF.
 * Use bold:"off" to write explicit w:val="0" — needed so skill_item text does
 * not pick up bold from adjacent skill_cat style (table cell / PDF bleed).
 * Use bold:"inherit" to leave template rPr alone (style bold can still apply).
 */
function cleanRPrForBold(rPr: string, bold: RunBoldMode): string {
  let props = rPr;
  const empty = !props || props === "<w:rPr/>" || props === "<w:rPr></w:rPr>";

  if (bold === "inherit") {
    return empty ? "" : props;
  }

  if (empty) {
    if (bold === true) return "<w:rPr><w:b/><w:bCs/></w:rPr>";
    if (bold === "off" || bold === false) {
      // Explicit off beats paragraph-style / neighbour-cell bold in Word + LO PDF.
      return '<w:rPr><w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>';
    }
    return "<w:rPr/>";
  }

  props = props
    .replace(/<w:b\b[^/]*\/>/g, "")
    .replace(/<w:bCs\b[^/]*\/>/g, "")
    .replace(/<w:b\b[^>]*>[\s\S]*?<\/w:b>/g, "")
    .replace(/<w:bCs\b[^>]*>[\s\S]*?<\/w:bCs>/g, "");

  const inject =
    bold === true
      ? "<w:b/><w:bCs/>"
      : bold === "off" || bold === false
        ? '<w:b w:val="0"/><w:bCs w:val="0"/>'
        : "";

  if (inject) {
    if (/<\/w:rPr>/.test(props)) {
      props = props.replace(/<\/w:rPr>/, `${inject}</w:rPr>`);
    } else {
      props = props.replace(/<w:rPr([^>]*)\/>/, `<w:rPr$1>${inject}</w:rPr>`);
    }
  }
  return props;
}

function makeRun(text: string, rPr: string, bold: RunBoldMode): string {
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

export function stripMarkdownBoldMarkers(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*\*/g, "");
}

/** True when Word run properties request bold (honors w:val="0" / false). */
export function runPropertiesBold(rPr: string): boolean {
  if (!rPr) return false;
  const tagRe = /<w:(b|bCs)\b([^/>]*)(?:\/>|>[\s\S]*?<\/w:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(rPr)) !== null) {
    const attrs = m[2] ?? "";
    if (/w:val=["'](?:0|false|off)["']/i.test(attrs)) continue;
    return true;
  }
  return false;
}

/** Overwrite paragraph text without interpreting ** as markdown bold. */
export function setParagraphPlain(
  pXml: string,
  text: string,
  opts?: {
    /** @deprecated use boldMode:"inherit" — keep template/style bold (skill_cat). */
    preserveTemplateBold?: boolean;
    /**
     * off — force non-bold (skill_item, title, summary).
     * inherit — do not toggle bold; template style may still bold (skill_cat).
     * true/false — force on/off with explicit w:b.
     */
    boldMode?: RunBoldMode;
  }
): string {
  const plain = stripMarkdownBoldMarkers(text);
  const rPr = getFirstRunProps(pXml);
  let bold: RunBoldMode = opts?.boldMode ?? "off";
  if (opts?.preserveTemplateBold === true && opts?.boldMode === undefined) {
    bold = "inherit";
  }
  return replaceParagraphContent(pXml, makeRun(plain, rPr, bold));
}

export function setParagraphMarkdown(pXml: string, text: string): string {
  const rPr = getFirstRunProps(pXml);
  return replaceParagraphContent(pXml, runsFromMarkdown(text, rPr));
}

/** Leading glyph used as a visual bullet in the text run (not Word numbering). */
const TEXT_BULLET_PREFIX_RE = /^([•·▪▫‣∙○●◦◼□■–—\-*=]+)\s*/;

/** Strip AI/FE accidental bullet prefixes so Word list + text glyph do not double. */
export function stripLeadingBulletMarker(text: string): string {
  return text.replace(TEXT_BULLET_PREFIX_RE, "").trim();
}

/**
 * If the template paragraph stored a literal bullet in <w:t> (common when there
 * is no w:numPr), return that prefix including a trailing space (e.g. "• ").
 */
export function extractTextBulletPrefix(pXml: string): string {
  const plain = paragraphPlainText(pXml);
  const m = plain.match(TEXT_BULLET_PREFIX_RE);
  if (!m) return "";
  // Normalize to "• " (or original marker + space) for consistent fill.
  const marker = m[1].replace(/\s+/g, "");
  return marker ? `${marker} ` : "";
}

/**
 * Fill an experience / list paragraph while preserving Word list numbering
 * (w:numPr inside pPr via replaceParagraphContent) and any literal text bullet.
 */
export function setExpSectionBulletText(pXml: string, text: string): string {
  const cleaned = stripLeadingBulletMarker(text);
  const prefix = extractTextBulletPrefix(pXml);
  // numPr lives in pPr and is kept by setParagraphMarkdown / replaceParagraphContent.
  return setParagraphMarkdown(pXml, prefix ? `${prefix}${cleaned}` : cleaned);
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

/**
 * Replace <w:p> nodes in document order without flattening the body.
 * Templates often wrap paragraphs in <w:tbl>/<w:sdt>/etc — joining only
 * <w:p> strips those wrappers and LibreOffice refuses to open the DOCX.
 */
function replaceParagraphsInXml(
  originalXml: string,
  paragraphs: string[],
  label: string
): string {
  let i = 0;
  const rebuilt = originalXml.replace(paragraphRe(), (match) => {
    if (i >= paragraphs.length) {
      return match;
    }
    const next = paragraphs[i];
    i += 1;
    return next;
  });

  if (i !== paragraphs.length) {
    throw new Error(
      `Invalid DOCX ${label}: paragraph count mismatch (xml=${i}, provided=${paragraphs.length})`
    );
  }

  return rebuilt;
}

export function rebuildDocumentXml(originalXml: string, paragraphs: string[]): string {
  if (!/<w:body[\s>]/.test(originalXml)) {
    throw new Error("Invalid DOCX: missing w:body");
  }
  return replaceParagraphsInXml(originalXml, paragraphs, "document");
}

/** Rebuild word/headerN.xml or footerN.xml paragraph list (container is w:hdr / w:ftr). */
export function rebuildHeaderFooterXml(
  originalXml: string,
  paragraphs: string[]
): string {
  if (!/<w:hdr[\s>]/.test(originalXml) && !/<w:ftr[\s>]/.test(originalXml)) {
    throw new Error("Invalid DOCX header/footer: missing w:hdr/w:ftr");
  }
  return replaceParagraphsInXml(originalXml, paragraphs, "header/footer");
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
