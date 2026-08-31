const HTML_TAG_PATTERN = /<[^>]*>/g;

export function sanitizePlainText(input: string): string {
  return input.replace(HTML_TAG_PATTERN, "").trim();
}
