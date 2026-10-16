/**
 * Server-side reject list for sensitive application fields.
 * Extension also filters client-side; this is a second gate.
 */

const SENSITIVE_NAME_RE =
  /pass(word|wd|code)?|passwd|pwd|pin|ssn|social.?security|credit.?card|card.?number|cc[-_]?num|cvc|cvv|cid|expir(y|ation)|iban|routing|account.?number|bank|otp|one[-_]?time|2fa|mfa|totp|auth.?code|verification.?code|security.?code|secret|token|api[-_]?key/i;

const SENSITIVE_TYPES = new Set([
  "password",
  "hidden",
]);

export function normalizeQuestionKey(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

/** Stable element key for upsert / dedupe within a session. */
export function normalizeElementKey(key: string): string {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

export function isSensitiveField(input: {
  question?: string;
  fieldType?: string | null;
  fieldName?: string | null;
  autocomplete?: string | null;
  elementId?: string | null;
  className?: string | null;
  cssSelector?: string | null;
  name?: string | null;
}): boolean {
  const type = (input.fieldType ?? "").trim().toLowerCase();
  if (SENSITIVE_TYPES.has(type)) return true;

  const blob = [
    input.question,
    input.fieldName,
    input.name,
    input.elementId,
    input.className,
    input.cssSelector,
    input.autocomplete,
    type,
  ]
    .filter(Boolean)
    .join(" ");

  if (!blob.trim()) return false;
  return SENSITIVE_NAME_RE.test(blob);
}
