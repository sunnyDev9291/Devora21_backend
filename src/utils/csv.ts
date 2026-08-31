import fs from "fs";
import path from "path";

const CSV_HEADER = ["datetime", "job_title", "company_name", "job_description", "resume_name"];

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function appendResumeLogRow(
  csvPath: string,
  row: {
    datetime: string;
    jobTitle: string;
    companyName: string;
    jobDescription: string;
    resumeName: string;
  }
): void {
  const dir = path.dirname(csvPath);
  fs.mkdirSync(dir, { recursive: true });

  const writeHeader = !fs.existsSync(csvPath);
  const line = [
    row.datetime,
    row.jobTitle,
    row.companyName,
    row.jobDescription,
    row.resumeName,
  ]
    .map(escapeCsvField)
    .join(",");

  if (writeHeader) {
    fs.writeFileSync(csvPath, `${CSV_HEADER.join(",")}\n${line}\n`, "utf-8");
  } else {
    fs.appendFileSync(csvPath, `${line}\n`, "utf-8");
  }
}
