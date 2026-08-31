/** Extract priority ATS keywords from a job description (max 18). */

const STOP = new Set(
  [
    "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "as", "by",
    "is", "are", "be", "this", "that", "from", "at", "we", "you", "your", "our",
    "will", "can", "able", "work", "job", "role", "team", "experience", "years",
    "including", "using", "use", "used", "etc", "etc.", "such", "into", "about",
    "have", "has", "been", "was", "were", "their", "they", "them", "who", "what",
    "when", "where", "which", "while", "over", "under", "per", "via", "all", "any",
    "more", "most", "other", "some", "than", "then", "also", "not", "but", "if",
  ].map((s) => s.toLowerCase())
);

const TECH_HINT =
  /\b(?:python|javascript|typescript|java|golang|go|rust|c\+\+|c#|react|node\.?js|aws|gcp|azure|docker|kubernetes|k8s|sql|postgres(?:ql)?|mysql|mongodb|redis|graphql|rest|api|selenium|playwright|ci\/cd|terraform|kafka|spark|hadoop|linux|git|github|gitlab|jenkins|ansible|nginx|fastapi|django|flask|spring|express|next\.?js|vue|angular|svelte|openai|llm|ml|ai|etl|devops|sre|observability|opentelemetry|grafana|sentry|cloudflare|shopify|drizz?le|planetscale)\b/gi;

export function extractAtsKeywords(jobDescription: string, max = 18): string[] {
  const jd = jobDescription.trim();
  if (!jd) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  const push = (term: string) => {
    const key = term.toLowerCase();
    if (seen.has(key) || key.length < 2) return;
    seen.add(key);
    found.push(term);
  };

  for (const m of jd.matchAll(TECH_HINT)) {
    push(m[0]);
    if (found.length >= max) return found.slice(0, max);
  }

  // Must-have style lines
  const mustBlock = jd.match(
    /(?:must[- ]have|required\s+skills?|requirements?|qualifications?)[:\s]*([\s\S]{0,800})/i
  );
  const block = mustBlock?.[1] ?? jd;
  const tokens = block
    .split(/[\n,;/|•·\-–—]+/)
    .map((t) => t.replace(/[^\w.+#/ -]/g, " ").trim())
    .filter(Boolean);

  for (const token of tokens) {
    const words = token.split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      const w = words[0];
      if (!STOP.has(w.toLowerCase()) && /[A-Za-z]/.test(w) && w.length >= 2) {
        push(w);
      }
    } else if (words.length <= 4 && words.every((w) => w.length < 20)) {
      const phrase = words.join(" ");
      if (!STOP.has(phrase.toLowerCase())) {
        push(phrase);
      }
    }
    if (found.length >= max) break;
  }

  return found.slice(0, max);
}
