/**
 * Repair truncated JSON from streamed/max-token-cut model output.
 * Closes open strings, arrays, and objects conservatively.
 */
export function repairTruncatedJson(raw: string): string {
  let text = raw.trim();
  if (!text) return text;

  // Remove trailing incomplete escape
  if (text.endsWith("\\")) {
    text = text.slice(0, -1);
  }

  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const open = stack[stack.length - 1];
      if ((ch === "}" && open === "{") || (ch === "]" && open === "[")) {
        stack.pop();
      }
    }
  }

  if (inString) {
    text += '"';
  }

  while (stack.length > 0) {
    const open = stack.pop();
    text += open === "{" ? "}" : "]";
  }

  return text;
}

export function extractJsonObject(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  } else if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json|JSON)?\s*\r?\n?/, "")
      .replace(/\r?\n?```\s*$/, "")
      .trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

export function parseJsonLenient(raw: string): unknown {
  const extracted = extractJsonObject(raw);
  try {
    return JSON.parse(extracted);
  } catch {
    const repaired = repairTruncatedJson(extracted);
    return JSON.parse(repaired);
  }
}
