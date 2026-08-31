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

export function replaceParagraphContent(pXml: string, runsXml: string): string {
  const open = pXml.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const pPr = getParagraphProps(pXml);
  return `${open}${pPr}${runsXml}</w:p>`;
}

/**
 * Preserve base run formatting (font/color/size) and toggle bold only.
 * Also strip nested bold-on/off pairs Word sometimes emits as <w:b w:val="0"/>.
 */
function cleanRPrForBold(rPr: string, bold: boolean): string {
  let props = rPr;
  if (!props || props === "<w:rPr/>" || props === "<w:rPr></w:rPr>") {
    return bold ? "<w:rPr><w:b/><w:bCs/></w:rPr>" : "<w:rPr/>";
  }
  // Remove existing bold markers (including w:val="0|false")
  props = props
    .replace(/<w:b\b[^(/]*\/>/g, "")
    .replace(/<w:bCs\b[^(/]*\/>/g, "")
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

/** Skills category line: bold "Label:" + plain value */
export function runsForCategorySkillLine(label: string, value: string, baseRPr = ""): string {
  const labelText = label.endsWith(":") ? label : `${label}:`;
  return (
    makeRun(`${labelText} `, baseRPr, true) + makeRun(value.trim(), baseRPr, false)
  );
}

export function setParagraphMarkdown(pXml: string, text: string): string {
  const rPr = getFirstRunProps(pXml);
  return replaceParagraphContent(pXml, runsFromMarkdown(text, rPr));
}

export function rebuildDocumentXml(originalXml: string, paragraphs: string[]): string {
  const bodyMatch = originalXml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) {
    throw new Error("Invalid DOCX: missing w:body");
  }

  const bodyInner = bodyMatch[1];
  // Preserve sectPr at end of body
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
