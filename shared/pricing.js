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

function singularize(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

const MATCH_STOP = new Set([
  "the", "a", "an", "of", "for", "and", "in", "with", "to", "on", "my", "our",
  "job", "jobs", "need", "needs", "pair", "pairs", "inch",
]);

function contentTokens(value) {
  return normalizeText(value)
    .split(" ")
    .map(singularize)
    .filter((token) => token && token.length > 1 && !MATCH_STOP.has(token));
}

function scoreKey(queryTokens, keyTokens) {
  if (!queryTokens.length || !keyTokens.length) return 0;
  const query = queryTokens.join(" ");
  const key = keyTokens.join(" ");
  if (query === key) return 120;
  if (query.includes(key) && (keyTokens.length >= 2 || keyTokens[0].length >= 5)) {
    return 40 + Math.min(key.length, 50);
  }
  const overlap = keyTokens.filter((token) => queryTokens.includes(token));
  const distinctive = overlap.filter((token) => token.length >= 4);
  if (overlap.length >= 2 && distinctive.length >= 1) return 30 + overlap.length * 15;
  if (overlap.length === 1 && overlap[0].length >= 5 && (keyTokens.length === 1 || queryTokens.length === 1)) {
    return 70;
  }
  return 0;
}

function asMoney(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100000) return value;
  const match = String(value ?? "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 && number < 100000 ? number : null;
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
  const queryTokens = contentTokens(query);
  if (!queryTokens.length) return [];
  const hits = [];
  for (const item of catalog?.items || []) {
    const keys = [item.sku, item.model, item.name, ...(item.aliases || [])].filter(Boolean);
    let score = 0;
    for (const key of keys) {
      score = Math.max(score, scoreKey(queryTokens, contentTokens(key)));
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

/** Pull a shelf price for one item out of prose. Numbers only; store names are ignored. */
export function shelvesFromText(prose, name) {
  const nameTokens = contentTokens(name);
  if (!nameTokens.length) return null;
  const sentences = String(prose || "").split(/\n+|(?<=[.!?])\s+/);
  let best = "";
  let bestScore = 0;
  for (const sentence of sentences) {
    if (!/\$\s?\d/.test(sentence)) continue;
    const overlap = nameTokens.filter((token) => contentTokens(sentence).includes(token)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = sentence;
    }
  }
  if (!best || bestScore < 1) return null;
  const range = best.match(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:to|through|-|–|—)\s*\$?\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
  if (range) {
    const low = asMoney(range[1]);
    const high = asMoney(range[2]);
    if (low && high) return { shelfLow: Math.min(low, high), shelfHigh: Math.max(low, high), source: "A" };
  }
  const amounts = [...best.matchAll(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)]
    .map((match) => asMoney(match[1]))
    .filter(Boolean);
  if (!amounts.length) return null;
  if (amounts.length === 1) return { shelf: amounts[0], source: "A" };
  return { shelf: amounts[amounts.length - 1], source: "A" };
}

export function fillMissingShelf(raw, catalog, prose = "") {
  const next = { ...raw };
  next.shelf = asMoney(next.shelf);
  next.shelfLow = asMoney(next.shelfLow);
  next.shelfHigh = asMoney(next.shelfHigh);
  const hasShelf = (next.shelf && next.shelf > 0) || (next.shelfLow && next.shelfLow > 0);
  if (!hasShelf && !next.fixedPrice) {
    const hits = matchCatalog(catalog, `${next.sku || ""} ${next.name || ""}`);
    const known = hits.find(hasFirmPrice) || hits[0];
    if (known?.fixedPrice && known.price != null) {
      next.fixedPrice = true;
      next.listPrice = known.price;
      next.sku = next.sku || known.sku;
    } else if (known?.shelfPrice != null && known.shelfPrice !== "") {
      next.shelf = Number(known.shelfPrice);
      next.source = next.source || "A";
      next.sku = next.sku || known.sku;
    } else if (known && (known.shelfLow != null || known.shelfHigh != null)) {
      next.shelfLow = Number(known.shelfLow);
      next.shelfHigh = known.shelfHigh != null ? Number(known.shelfHigh) : null;
      next.source = next.source || "A";
      next.sku = next.sku || known.sku;
    }
  }
  const stillMissing = !(next.shelf > 0) && !(next.shelfLow > 0) && !next.fixedPrice;
  if (stillMissing) {
    const found = shelvesFromText(prose, `${next.name || ""} ${next.sku || ""}`);
    if (found) Object.assign(next, found);
  }
  return next;
}

export function paymentOnTop(price, cardRate = 0.03, achRate = 0.01) {
  return {
    card: roundMoney(Number(price) * (1 + cardRate)),
    ach: roundMoney(Number(price) * (1 + achRate)),
  };
}

export function formatEstimate(priced) {
  if (!priced || priced.estimate == null) return "";
  if (priced.estimateHigh != null && priced.estimateHigh !== priced.estimate) {
    return `${formatMoney(priced.estimate)} to ${formatMoney(priced.estimateHigh)}`;
  }
  return formatMoney(priced.estimate);
}

const PRODUCT_WORD = /\b(caulk|saws?|circular|drills?|drivers?|impacts?|tools?|ladders?|gloves?|blades?|bits?|batter(?:y|ies)|wrenches?|pliers|screws?|fasteners?|levels?|lasers?|packout|generators?|stations?|cases?|kits?|grinders?|nailers?|tapes?)\b/i;

export function shouldSearch(userText, matches) {
  const text = String(userText || "");
  const priceAsk = /(\bprice\b|\bpricing\b|how much|\$|\bquote\b|\bestimate\b|\bcost\b)/i.test(text);
  const modelish = /\b[a-z]{0,6}-?\d{2,}[a-z0-9-]*\b/i.test(text);
  const qty = extractQty(text);
  const namedProduct = PRODUCT_WORD.test(text) && (qty != null || priceAsk);
  if (!priceAsk && !modelish && !namedProduct) return false;
  if (matches.length && matches.every(hasFirmPrice)) return false;
  return true;
}
