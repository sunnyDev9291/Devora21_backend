import { execFile } from "child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

const WINDOWS_SOFFICE_PATHS = [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
];

const CONVERT_TIMEOUT_MS = 180_000;
const PDF_POLL_INTERVAL_MS = 500;
const PDF_POLL_MAX_ATTEMPTS = 120;

let conversionQueue: Promise<void> = Promise.resolve();

function withConversionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = conversionQueue.then(fn, fn);
  conversionQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getConvertWorkBase(): string {
  return path.resolve(env.STORAGE_DIR, ".convert-tmp");
}

function resolveSofficeBinary(): string {
  if (env.LIBREOFFICE_PATH && fsSync.existsSync(env.LIBREOFFICE_PATH)) {
    return env.LIBREOFFICE_PATH;
  }

  for (const candidate of WINDOWS_SOFFICE_PATHS) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new AppError(422, "PDF conversion failed. Ensure LibreOffice is installed on the server.");
}

function buildLibreOfficeEnv(sofficePath: string): NodeJS.ProcessEnv {
  const programDir = path.dirname(sofficePath);
  const fundamentalIni = path.join(programDir, "fundamental.ini");

  return {
    ...process.env,
    PATH: `${programDir}${path.delimiter}${process.env.PATH ?? ""}`,
    URE_BOOTSTRAP: `vnd.sun.star.pathname:${pathToFileURL(fundamentalIni).href}`,
  };
}

async function saveFailedDocxDebug(docxBuffer: Buffer): Promise<string> {
  const debugDir = path.resolve(env.STORAGE_DIR, ".convert-debug");
  const debugPath = path.join(debugDir, `${Date.now()}-failed.docx`);
  await fs.mkdir(debugDir, { recursive: true });
  await fs.writeFile(debugPath, docxBuffer);
  return debugPath;
}

async function waitForPdfFile(pdfPath: string): Promise<boolean> {
  for (let poll = 0; poll < PDF_POLL_MAX_ATTEMPTS; poll += 1) {
    const pdfStat = await fs.stat(pdfPath).catch(() => null);
    if (pdfStat && pdfStat.size > 100) {
      return true;
    }
    await sleep(PDF_POLL_INTERVAL_MS);
  }
  return false;
}

async function killStaleLibreOfficeProcesses(): Promise<void> {
  if (!isWindows) {
    return;
  }

  for (const image of ["soffice.bin", "soffice.exe"]) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/F", "/IM", image, "/T"], { windowsHide: true }, () => resolve());
    });
  }

  await sleep(400);
}

async function convertWithPowerShell(docxBuffer: Buffer): Promise<Buffer> {
  const soffice = resolveSofficeBinary();
  const workDir = path.join(getConvertWorkBase(), uuidv4());
  const profileDir = path.join(workDir, "profile");
  const docxPath = path.join(workDir, "resume.docx");
  const pdfPath = path.join(workDir, "resume.pdf");

  try {
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(docxPath, docxBuffer);

    const psScript = [
      `$soffice = '${soffice.replace(/'/g, "''")}'`,
      `$docx = '${docxPath.replace(/'/g, "''")}'`,
      `$outDir = '${workDir.replace(/'/g, "''")}'`,
      `$profile = '${profileDir.replace(/'/g, "''")}'`,
      `$pdf = '${pdfPath.replace(/'/g, "''")}'`,
      `$profileUrl = 'file:///' + ($profile -replace '\\\\','/')`,
      `$args = @('--headless', "-env:UserInstallation=$profileUrl", '--convert-to', 'pdf:writer_pdf_Export', '--outdir', $outDir, $docx)`,
      `$proc = Start-Process -FilePath $soffice -ArgumentList $args -Wait -PassThru -WindowStyle Hidden`,
      `$deadline = (Get-Date).AddSeconds(90)`,
      `while ((Get-Date) -lt $deadline) { if (Test-Path $pdf) { break }; Start-Sleep -Milliseconds 500 }`,
      `if (-not (Test-Path $pdf)) { exit 1 }`,
    ].join("; ");

    try {
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { windowsHide: true, timeout: CONVERT_TIMEOUT_MS }
      );
    } catch (err) {
      console.warn("PowerShell LibreOffice invocation reported an error:", err);
    }

    if (await waitForPdfFile(pdfPath)) {
      return await fs.readFile(pdfPath);
    }

    throw new Error("PDF was not created");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function convertWithExecFile(docxBuffer: Buffer): Promise<Buffer> {
  const soffice = resolveSofficeBinary();
  const programDir = path.dirname(soffice);
  const workDir = path.join(getConvertWorkBase(), uuidv4());
  const profileDir = path.join(workDir, "profile");
  const docxPath = path.join(workDir, "resume.docx");
  const pdfPath = path.join(workDir, "resume.pdf");

  try {
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(docxPath, docxBuffer);

    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--headless",
      "--norestore",
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      workDir,
      docxPath,
    ];

    try {
      await execFileAsync(soffice, args, {
        cwd: programDir,
        env: buildLibreOfficeEnv(soffice),
        windowsHide: true,
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      console.warn("LibreOffice reported an error; checking for output PDF:", err);
    }

    if (await waitForPdfFile(pdfPath)) {
      return await fs.readFile(pdfPath);
    }

    throw new Error("PDF was not created");
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runConversion(docxBuffer: Buffer): Promise<Buffer> {
  if (isWindows) {
    return convertWithPowerShell(docxBuffer);
  }
  return convertWithExecFile(docxBuffer);
}

export async function convertDocxBufferToPdf(docxBuffer: Buffer): Promise<Buffer> {
  return withConversionLock(async () => {
    if (docxBuffer.length < 1024) {
      throw new AppError(422, "resume must be a valid DOCX file");
    }

    await killStaleLibreOfficeProcesses();

    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) {
        await killStaleLibreOfficeProcesses();
        await sleep(600 * (attempt - 1));
      }

      try {
        return await runConversion(docxBuffer);
      } catch (err) {
        lastError = err;
        console.error(`LibreOffice conversion attempt ${attempt} failed:`, err);
      }
    }

    const debugPath = await saveFailedDocxDebug(docxBuffer).catch(() => null);
    if (debugPath) {
      console.error("Saved failed DOCX for debugging at:", debugPath);
    }

    console.error("LibreOffice conversion failed after retries:", lastError);
    throw new AppError(
      422,
      "PDF conversion failed. Ensure LibreOffice is installed on the server."
    );
  });
}

export async function convertDocxToPdf(docxPath: string): Promise<Buffer> {
  const buffer = await fs.readFile(docxPath);
  return convertDocxBufferToPdf(buffer);
}
