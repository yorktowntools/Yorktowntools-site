/** Pull model numbers out of customer text without gluing words like "Models" onto a SKU. */

const SKIP_PREFIXES = new Set([
  "model", "models", "sku", "skus", "item", "items", "need", "needs", "needed",
  "part", "parts", "type", "types", "size", "code", "codes", "qty", "order",
  "sweet", "just", "with", "from", "this", "that", "have", "want", "like",
  "only", "also", "plus", "and", "the", "for", "our", "your", "any", "all",
]);

const HYPHENATED = /\b\d{3,5}-\d{1,3}[a-z]?\b/gi;
const LETTER_CODE = /\b[a-z]{2,6}\d{3,}[a-z0-9]*\b/gi;
const TRAILING_LETTER = /\b\d{3,6}[a-z]{1,4}\b/gi;
const SPLIT_PREFIX = /\b([a-z]{2,6})[\s-]+(\d{3,}[a-z0-9]*)\b/gi;

export function normalizeModelCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function prefixOf(display) {
  const match = String(display || "").toUpperCase().match(/^([A-Z]+)/);
  return match ? match[1].toLowerCase() : "";
}

function isSkippedPrefix(prefix) {
  if (!prefix) return false;
  if (SKIP_PREFIXES.has(prefix)) return true;
  if (prefix.endsWith("s") && SKIP_PREFIXES.has(prefix.slice(0, -1))) return true;
  return false;
}

/**
 * Return canonical model codes in the order they appear, e.g. "2880-20", "DCD996B".
 * "Models 2880-20 2131-20" becomes ["2880-20", "2131-20"], never "MODELS2880".
 */
export function extractModelCodes(text) {
  const raw = String(text || "");
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const display = String(value || "").toUpperCase();
    const norm = normalizeModelCode(display);
    if (norm.length < 5 || !/\d{3,}/.test(norm) || seen.has(norm)) return;
    if (isSkippedPrefix(prefixOf(display))) return;
    seen.add(norm);
    found.push(display);
  };

  for (const match of raw.matchAll(HYPHENATED)) add(match[0]);
  for (const match of raw.matchAll(LETTER_CODE)) add(match[0]);
  for (const match of raw.matchAll(TRAILING_LETTER)) add(match[0]);
  for (const match of raw.matchAll(SPLIT_PREFIX)) {
    const prefix = match[1].toLowerCase();
    const rest = match[2];
    const digits = rest.replace(/\D/g, "");
    // Only join short SKU prefixes like "DCD 996B", never "Models 2880" or "Zach 7579405171".
    if (isSkippedPrefix(prefix) || prefix.length > 4) continue;
    if (digits.length >= 7 && !/[a-z]/i.test(rest)) continue;
    add(`${match[1]}${rest}`);
  }
  return found;
}

export function maskModelCodes(text) {
  let out = String(text || "");
  for (const code of extractModelCodes(out)) {
    out = out.replace(new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  return out;
}

export function isGluedModelLabel(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  const norm = normalizeModelCode(text);
  const prefix = prefixOf(text.replace(/\s+/g, ""));
  return isSkippedPrefix(prefix) && /\d{3,}/.test(norm);
}
