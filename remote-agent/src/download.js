const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
const { Readable } = require("stream");

function sanitizeFileName(name, fallback) {
  const raw = String(name || fallback || "resume")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return raw.slice(0, 180) || fallback || "resume";
}

function uniquePath(filePath, overwrite) {
  if (overwrite || !fs.existsSync(filePath)) {
    return filePath;
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let i = 1;
  while (true) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i += 1;
  }
}

async function downloadToFile(url, destPath) {
  const response = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "Devora21RemoteAgent/1.0" },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Download failed HTTP ${response.status} for ${url}`);
  }
  if (!response.body) {
    throw new Error("Download response had no body");
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const nodeStream = Readable.fromWeb(response.body);
  await pipeline(nodeStream, createWriteStream(destPath));
}

async function downloadWithRetry(url, destPath, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await downloadToFile(url, destPath);
      return destPath;
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
  }
  throw lastError;
}

/**
 * Save pdf/docx for one queue item. Returns list of saved absolute paths.
 */
async function saveQueueItemFiles(item, saveDir, overwrite) {
  await fs.promises.mkdir(saveDir, { recursive: true });
  const saved = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const company = sanitizeFileName(item.companyName, "company");
  const title = sanitizeFileName(item.jobTitle, "role");
  const prefix = `${stamp}_${company}_${title}`;

  if (item.includePdf !== false && item.pdfUrl) {
    const pdfName = sanitizeFileName(
      item.pdfFileName || `${prefix}.pdf`,
      `${prefix}.pdf`
    );
    const finalName = pdfName.toLowerCase().endsWith(".pdf")
      ? pdfName
      : `${pdfName}.pdf`;
    const dest = uniquePath(path.join(saveDir, finalName), overwrite);
    await downloadWithRetry(item.pdfUrl, dest);
    saved.push(dest);
  }

  if (item.includeDocx !== false && item.docxUrl) {
    const docxName = sanitizeFileName(
      item.resumeFileName || `${prefix}.docx`,
      `${prefix}.docx`
    );
    const finalName = docxName.toLowerCase().endsWith(".docx")
      ? docxName
      : `${docxName}.docx`;
    const dest = uniquePath(path.join(saveDir, finalName), overwrite);
    await downloadWithRetry(item.docxUrl, dest);
    saved.push(dest);
  }

  if (saved.length === 0) {
    throw new Error("Queue item had no downloadable pdfUrl/docxUrl");
  }

  return saved;
}

module.exports = { saveQueueItemFiles, sanitizeFileName };
