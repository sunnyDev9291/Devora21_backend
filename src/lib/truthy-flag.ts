import { z } from "zod";

/** true only for true / "true" / 1; anything else (incl. omit) => false. */
export const truthyFlagSchema = z.preprocess((value) => {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
  }
  return false;
}, z.boolean());
