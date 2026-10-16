/** Client-side sensitive field filter (backend also filters). */

const SENSITIVE_NAME_RE =
  /pass(word|wd|code)?|passwd|pwd|pin|ssn|social.?security|credit.?card|card.?number|cc[-_]?num|cvc|cvv|cid|expir(y|ation)|iban|routing|account.?number|bank|otp|one[-_]?time|2fa|mfa|totp|auth.?code|verification.?code|security.?code|secret|token|api[-_]?key/i;

export function isSensitiveField({
  question = "",
  fieldType = "",
  fieldName = "",
  autocomplete = "",
  name = "",
  elementId = "",
  className = "",
  cssSelector = "",
} = {}) {
  const type = String(fieldType || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const blob = [
    question,
    fieldName,
    name,
    elementId,
    className,
    cssSelector,
    autocomplete,
    type,
  ]
    .filter(Boolean)
    .join(" ");
  return blob ? SENSITIVE_NAME_RE.test(blob) : false;
}
