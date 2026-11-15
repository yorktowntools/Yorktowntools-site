/** Instant-price math. Shelf numbers stay internal. Customer numbers are estimates. */

export function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 0 matches the lower shelf price. 1 is one percent under. Nonsense values fall back. */
export function discountPercent(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 25) return fallback;
  return n;
}

export function instantPrice(shelf, percent) {
  const base = Number(shelf);
  if (!Number.isFinite(base) || base < 0) return null;
  const pct = discountPercent(percent, 0);
  return roundMoney(base * (1 - pct / 100));
}

export function formatMoney(value) {
  const n = roundMoney(value);
  if (n == null) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function hasFirmPrice(entry) {
  if (!entry) return false;
  if (entry.fixedPrice && entry.price != null) return true;
  if (entry.shelfPrice != null && entry.shelfPrice !== "") return true;
  return false;
}

export function hasUsablePrice(entry) {
  if (hasFirmPrice(entry)) return true;
  return Boolean(entry && entry.shelfLow != null && entry.shelfLow !== "");
}

/**
 * Turn a catalog row or a model shelf pair into customer-facing numbers.
 * shelfPrice is the lower national shelf price. Discount comes off that number.
 * fixedPrice items (gloves, shirts) are the price already on the site.
 */
export function priceEntry(entry, percent) {
  if (!entry) return null;
  const asOf = entry.date || entry.asOf || null;
  const base = {
    sku: entry.sku || "",
    name: entry.name || entry.model || "Item",
    manufacturer: entry.manufacturer || "",
    manufacturerUrl: entry.manufacturerUrl || "",
    categoryPage: entry.categoryPage || "",
    asOf,
    qty: entry.qty ?? null,
  };

  if (entry.fixedPrice && entry.price != null) {
    return {
      ...base,
      estimate: roundMoney(entry.price),
      estimateHigh: null,
      confidence: "confirmed",
      kind: "listed",
    };
  }

  if (entry.shelfPrice != null && entry.shelfPrice !== "") {
    return {
      ...base,
      estimate: instantPrice(entry.shelfPrice, percent),
      estimateHigh: null,
      confidence: "list",
      kind: "instant",
    };
  }

  if (entry.shelfLow != null && entry.shelfLow !== "") {
    const lowShelf = Number(entry.shelfLow);
    const highShelf = entry.shelfHigh != null ? Number(entry.shelfHigh) : null;
    const lower = highShelf != null && Number.isFinite(highShelf) ? Math.min(lowShelf, highShelf) : lowShelf;
    const higher = highShelf != null && Number.isFinite(highShelf) ? Math.max(lowShelf, highShelf) : null;
    const tight = higher == null || (lower > 0 && (higher - lower) / lower <= 0.03);
    return {
      ...base,
      estimate: instantPrice(lower, percent),
      estimateHigh: tight || higher == null ? null : instantPrice(higher, percent),
      confidence: tight ? "list" : "range",
      kind: tight ? "instant" : "range",
    };
  }

  return {
    ...base,
    estimate: null,
    estimateHigh: null,
    confidence: "unsure",
    kind: "unsure",
  };
}

export function matchCatalog(catalog, query) {
  const q = normalizeText(query);
  if (!q) return [];
  const hits = [];
  for (const item of catalog?.items || []) {
    const keys = [item.sku, item.model, item.name, ...(item.aliases || [])].filter(Boolean);
    let score = 0;
    for (const key of keys) {
      const k = normalizeText(key);
      if (!k || k.length < 4) continue;
      if (q === k) score = Math.max(score, 120);
      else if (q.includes(k)) score = Math.max(score, 40 + Math.min(k.length, 50));
    }
    if (score >= 50) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length) return [];
  const top = hits[0].score;
  const picked = [];
  const seen = new Set();
  for (const hit of hits) {
    if (hit.score < top - 15) break;
    const id = hit.item.sku || hit.item.name;
    if (seen.has(id)) continue;
    seen.add(id);
    picked.push(hit.item);
    if (picked.length >= 4) break;
  }
  return picked;
}

/** Pull a quantity only when the customer actually gave one. Dimensions like 7-1/4 do not count. */
export function extractQty(text) {
  const raw = String(text || "");
  const patterns = [
    /\b(?:need|needs|want|wants|order|quote|get|send)\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s*(?:x|pcs|pc|pieces|piece|units|unit|pairs|pair|qty|each|gloves|saws|drills|kits)\b/i,
    /\bqty\s*:?\s*(\d{1,4})\b/i,
    /\b(\d{1,4})\s+of\b/i,
  ];
  for (const re of patterns) {
    const match = raw.match(re);
    if (match) {
      const n = Number(match[1]);
      if (n >= 1 && n <= 9999) return n;
    }
  }
  const words = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1,
  };
  const word = raw.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|a|an)\b(?:\s+(?:of|pair|pairs|units?|pcs))?\b/i);
  if (word && /\b(need|want|order|quote|get|send|pair)\b/i.test(raw)) {
    return words[word[1].toLowerCase()] || null;
  }
  return null;
}

export function formatEstimate(priced) {
  if (!priced || priced.estimate == null) return "";
  if (priced.estimateHigh != null && priced.estimateHigh !== priced.estimate) {
    return `${formatMoney(priced.estimate)} to ${formatMoney(priced.estimateHigh)}`;
  }
  return formatMoney(priced.estimate);
}

export function shouldSearch(userText, matches) {
  const text = String(userText || "");
  const priceAsk = /(\bprice\b|\bpricing\b|how much|\$|\bquote\b|\bestimate\b)/i.test(text);
  const modelish = /\b[a-z]{0,6}-?\d{2,}[a-z0-9-]*\b/i.test(text);
  if (!priceAsk && !modelish) return false;
  if (matches.length && matches.every(hasFirmPrice)) return false;
  return true;
}
