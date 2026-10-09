import { execFile } from "child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
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

/** Soft ceiling per soffice invoke — keep /resume/render under FE ~90s budget. */
const CONVERT_TIMEOUT_MS = 45_000;
const PDF_POLL_INTERVAL_MS = 400;
const PDF_POLL_MAX_ATTEMPTS = 25; // ~10s after soffice exits
const CONVERT_ATTEMPTS = 2;
/** Hard ceiling for the whole convertDocxBufferToPdf call (incl. queue wait + retries). */
const CONVERT_OVERALL_MS = 55_000;

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

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError(504, message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
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

  throw new AppError(
    422,
    "PDF conversion failed. Ensure LibreOffice is installed on the server."
  );
}

function buildLibreOfficeEnv(sofficePath: string): NodeJS.ProcessEnv {
  const programDir = path.dirname(sofficePath);
  // Do not set URE_BOOTSTRAP — it crashes soffice.exe on this Windows host
  // (MSVC exception 0xE06D7363 / exit 3765269347). Plain PATH is enough.
  return {
    ...process.env,
    PATH: `${programDir}${path.delimiter}${process.env.PATH ?? ""}`,
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
      execFile("taskkill", ["/F", "/IM", image, "/T"], { windowsHide: true }, () =>
        resolve()
      );
    });
  }

  await sleep(300);
}

async function convertWithPowerShell(docxBuffer: Buffer): Promise<Buffer> {
  const soffice = resolveSofficeBinary();
  const workDir = path.join(getConvertWorkBase(), uuidv4());
  const docxPath = path.join(workDir, "resume.docx");
  const pdfPath = path.join(workDir, "resume.pdf");

  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(docxPath, docxBuffer);

    const timeoutSec = Math.ceil(CONVERT_TIMEOUT_MS / 1000);
    const psScript = [
      `$soffice = '${soffice.replace(/'/g, "''")}'`,
      `$docx = '${docxPath.replace(/'/g, "''")}'`,
      `$outDir = '${workDir.replace(/'/g, "''")}'`,
      `$pdf = '${pdfPath.replace(/'/g, "''")}'`,
      // No UserInstallation — custom profiles crash/hang soffice on this host.
      `$args = @('--headless','--norestore','--convert-to','pdf:writer_pdf_Export','--outdir',$outDir,$docx)`,
      `$proc = Start-Process -FilePath $soffice -ArgumentList $args -PassThru -WindowStyle Hidden`,
      `if (-not $proc.WaitForExit(${CONVERT_TIMEOUT_MS})) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}; Get-Process soffice*,soffice.bin -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 1 }`,
      `$deadline = (Get-Date).AddSeconds(${timeoutSec})`,
      `while ((Get-Date) -lt $deadline) { if (Test-Path $pdf) { if ((Get-Item $pdf).Length -gt 100) { break } }; Start-Sleep -Milliseconds 400 }`,
      `if (-not (Test-Path $pdf)) { exit 1 }`,
      `if ((Get-Item $pdf).Length -le 100) { exit 1 }`,
    ].join("; ");

    try {
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        { windowsHide: true, timeout: CONVERT_TIMEOUT_MS + 15_000 }
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
  const docxPath = path.join(workDir, "resume.docx");
  const pdfPath = path.join(workDir, "resume.pdf");

  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(docxPath, docxBuffer);

    // Match the fast manual Windows invoke (no UserInstallation) — custom
    // profiles have been crashing/hanging soffice on this host.
    const args = [
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
  // Prefer direct soffice (fast on this Windows host ~2s without UserInstallation).
  try {
    return await convertWithExecFile(docxBuffer);
  } catch (err) {
    if (!isWindows) throw err;
    console.warn("[pdf-convert] execFile path failed; trying PowerShell fallback:", err);
    await killStaleLibreOfficeProcesses();
    return convertWithPowerShell(docxBuffer);
  }
}

export async function convertDocxBufferToPdf(docxBuffer: Buffer): Promise<Buffer> {
  const started = Date.now();
  return raceWithTimeout(
    withConversionLock(async () => {
      if (docxBuffer.length < 1024) {
        throw new AppError(422, "resume must be a valid DOCX file");
      }

      console.log(
        `[pdf-convert] start bytes=${docxBuffer.length} queueWaitMs≈${Date.now() - started}`
      );

      let lastError: unknown;

      for (let attempt = 1; attempt <= CONVERT_ATTEMPTS; attempt += 1) {
        if (attempt > 1) {
          await killStaleLibreOfficeProcesses();
          await sleep(400 * (attempt - 1));
        }

        const attemptStarted = Date.now();
        try {
          const pdf = await runConversion(docxBuffer);
          console.log(
            `[pdf-convert] ok attempt=${attempt} ms=${Date.now() - attemptStarted} totalMs=${Date.now() - started}`
          );
          return pdf;
        } catch (err) {
          lastError = err;
          console.error(
            `[pdf-convert] fail attempt=${attempt} ms=${Date.now() - attemptStarted}:`,
            err
          );
        }
      }

      const debugPath = await saveFailedDocxDebug(docxBuffer).catch(() => null);
      if (debugPath) {
        console.error("Saved failed DOCX for debugging at:", debugPath);
      }

      console.error("LibreOffice conversion failed after retries:", lastError);
      throw new AppError(
        504,
        "PDF conversion timed out or failed. Try Apply again in a moment."
      );
    }),
    CONVERT_OVERALL_MS,
    `PDF conversion exceeded ${CONVERT_OVERALL_MS}ms`
  );
}

export async function convertDocxToPdf(docxPath: string): Promise<Buffer> {
  const buffer = await fs.readFile(docxPath);
  return convertDocxBufferToPdf(buffer);
}
