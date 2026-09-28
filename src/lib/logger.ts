import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { env } from "../config/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
};

const MAX_BUFFER = 2000;
const bus = new EventEmitter();
bus.setMaxListeners(50);

const buffer: LogEntry[] = [];
let fileStream: fs.WriteStream | null = null;
let currentFileDate = "";

function logsDir(): string {
  return path.resolve(env.STORAGE_DIR || "storage", "logs");
}

function ensureFileStream(): fs.WriteStream {
  const day = new Date().toISOString().slice(0, 10);
  if (fileStream && currentFileDate === day) {
    return fileStream;
  }
  if (fileStream) {
    fileStream.end();
    fileStream = null;
  }
  const dir = logsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `app-${day}.log`);
  fileStream = fs.createWriteStream(filePath, { flags: "a" });
  currentFileDate = day;
  return fileStream;
}

function formatLine(entry: LogEntry): string {
  const meta =
    entry.meta && Object.keys(entry.meta).length > 0
      ? ` ${JSON.stringify(entry.meta)}`
      : "";
  return `${entry.ts} [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${meta}`;
}

function write(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }

  const line = formatLine(entry);
  const printer =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  printer(line);

  try {
    ensureFileStream().write(`${line}\n`);
  } catch {
    // ignore file write failures
  }

  bus.emit("log", entry);
}

export const logger = {
  debug(scope: string, message: string, meta?: Record<string, unknown>) {
    write("debug", scope, message, meta);
  },
  info(scope: string, message: string, meta?: Record<string, unknown>) {
    write("info", scope, message, meta);
  },
  warn(scope: string, message: string, meta?: Record<string, unknown>) {
    write("warn", scope, message, meta);
  },
  error(scope: string, message: string, meta?: Record<string, unknown>) {
    write("error", scope, message, meta);
  },
};

export function getRecentLogs(limit = 200, scope?: string): LogEntry[] {
  const take = Math.min(Math.max(limit, 1), MAX_BUFFER);
  const source = scope
    ? buffer.filter((e) => e.scope === scope || e.scope.startsWith(`${scope}.`))
    : buffer;
  return source.slice(-take);
}

export function subscribeLogs(
  onLog: (entry: LogEntry) => void
): () => void {
  bus.on("log", onLog);
  return () => {
    bus.off("log", onLog);
  };
}

export function logsFilePathToday(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(logsDir(), `app-${day}.log`);
}
