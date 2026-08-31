const UNSAFE_CHARS = /[^a-zA-Z0-9._-]/g;
const MAX_ARCHIVE_FILENAME = 120;

export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "resume.docx";
  const sanitized = base.replace(UNSAFE_CHARS, "_").replace(/_+/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "resume.docx";
  }
  return sanitized.toLowerCase().endsWith(".docx") ? sanitized : `${sanitized}.docx`;
}

/** Display/download filename stored in DB (truncated for Windows path safety). */
export function sanitizeArchiveFileName(name: string): string {
  const sanitized = sanitizeFilename(name);
  if (sanitized.length <= MAX_ARCHIVE_FILENAME) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_ARCHIVE_FILENAME - 5)}.docx`;
}

export function toPdfDisplayName(docxFileName: string): string {
  return docxFileName.replace(/\.docx$/i, ".pdf");
}

export const ARCHIVE_DISK_DOCX = "resume.docx";
export const ARCHIVE_DISK_PDF = "resume.pdf";

export function sanitizeSegment(value: string): string {  const trimmed = value.trim().slice(0, 80);
  const sanitized = trimmed.replace(UNSAFE_CHARS, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return sanitized || "unknown";
}

export function buildResumeFilename(
  companyName: string,
  jobTitle: string,
  originalFilename: string
): string {
  const safeOriginal = sanitizeFilename(originalFilename);
  if (safeOriginal !== "resume.docx" && safeOriginal.length > 5) {
    return safeOriginal;
  }
  const timestamp = Date.now();
  return `${sanitizeSegment(companyName)}_${sanitizeSegment(jobTitle)}_${timestamp}.docx`;
}
