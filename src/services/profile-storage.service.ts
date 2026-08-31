import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

export function buildUserFileKey(userId: string, filename: string): string {
  return `users/${userId}/${filename}`;
}

export function resolveStoragePath(key: string): string {
  return path.resolve(env.STORAGE_DIR, key);
}

export async function saveUserFile(
  userId: string,
  filename: string,
  buffer: Buffer
): Promise<string> {
  const key = buildUserFileKey(userId, filename);
  const fullPath = resolveStoragePath(key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
  return key;
}

export async function readUserFile(key: string): Promise<Buffer> {
  return fs.readFile(resolveStoragePath(key));
}

export async function deleteUserFile(key: string | null | undefined): Promise<void> {
  if (!key) {
    return;
  }

  try {
    await fs.unlink(resolveStoragePath(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export async function replaceUserFile(
  userId: string,
  filename: string,
  buffer: Buffer,
  previousKey: string | null | undefined
): Promise<string> {
  const newKey = buildUserFileKey(userId, filename);
  const savedKey = await saveUserFile(userId, filename, buffer);

  if (previousKey && previousKey !== newKey) {
    await deleteUserFile(previousKey);
  }

  return savedKey;
}
