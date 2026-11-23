import { maskModelCodes } from "./models.js";
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

const TYPE_WORDS = new Set([
  "sds", "rotary", "pneumatic", "demolition", "jackhammer",
  "circular", "miter", "reciprocating", "oscillating",
]);

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
    model: entry.model || "",
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

import { canonicalBrand } from "./trade.js";

const TOOL_BRANDS = ["dewalt", "milwaukee", "makita", "bosch", "hilti", "festool", "metabo", "ridgid", "skil", "flex", "hercules", "kobalt", "ryobi"];

export function customerBrand(text) {
  return canonicalBrand(text);
}

export function customerBladeSize(text) {
  const normalized = String(text || "")
    .replace(/\beight and a quarter\b/gi, "8-1/4")
    .replace(/\bseven and a quarter\b/gi, "7-1/4")
    .replace(/\bfour and a half\b/gi, "4-1/2");
  const hits = [...normalized.matchAll(/(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)/g)];
  if (!hits.length) return "";
  const last = hits[hits.length - 1];
  return `${last[1]}-${last[2]}/${last[3]}`;
}

function itemBrand(item) {
  const blob = `${item?.manufacturer || ""} ${item?.name || ""} ${item?.model || ""}`.toLowerCase();
  return TOOL_BRANDS.find((brand) => blob.includes(brand)) || "";
}

export function catalogConflict(item, context = "") {
  const brand = customerBrand(context);
  const size = customerBladeSize(context);
  const theirs = itemBrand(item);
  const theirSize = customerBladeSize(`${item?.name || ""} ${item?.model || ""}`);
  if (brand && theirs && theirs !== brand) return true;
  if (size && theirSize && theirSize !== size) return true;
  return false;
}

function modelCodesIn(text) {
  const tokens = String(text || "").match(/[a-z0-9][a-z0-9-]{2,}[a-z0-9]/gi) || [];
  return tokens
    .filter((token) => /\d/.test(token) && /[a-z]/i.test(token))
    .filter((token) => !/^\d+(?:v|w|ah|ft|in|mm|cm|lbs?|oz|gal|pcs?|pk|amp|amps|rpm|psi|mah|wh)$/i.test(token))
    .filter((token) => !/^jp-?8$/i.test(token))
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export function matchCatalog(catalog, query, context = "") {
  const queryTokens = contentTokens(query);
  if (!queryTokens.length) return [];
  const guard = `${context || ""} ${query || ""}`;
  const hits = [];
  const codes = modelCodesIn(query);
  for (const item of catalog?.items || []) {
    if (catalogConflict(item, guard)) continue;
    const keys = [item.sku, item.model, item.name, ...(item.aliases || [])].filter(Boolean);
    // A named model number only matches an entry that carries that model. Never substitute.
    if (codes.length) {
      const own = keys.join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!codes.some((code) => own.includes(code))) continue;
    }
    const covered = new Set(contentTokens(keys.join(" ")));
    if (queryTokens.some((token) => TYPE_WORDS.has(token) && !covered.has(token))) continue;
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
/**
 * "6 cases of caulk and 5 circular saws" -> two lines, each with its own quantity.
 * A bare "need 2" with no product words returns nothing so the single-item path can handle it.
 */
export function splitRequestedItems(text) {
  const source = maskModelCodes(text);
  const re = /(?:(\d{1,4})|(?:\b(?:a|an|one)\b))\s+(?:(cases?|boxes|pairs?|packs?)\s+of\s+)?([a-z0-9][^.\n;]{1,80}?)(?=\s*(?:,|\band\b|\bfor\b|\bin\b)|$)/gi;
  const found = [];
  let match;
  while ((match = re.exec(source))) {
    let product = match[3].replace(/\s+/g, " ").trim().replace(/^(a|an|the)\s+/i, "");
    if (product.length < 2) continue;
    if (!match[1] && !match[2]) continue;
    const unit = (match[2] || "").toLowerCase();
    const name = unit.startsWith("case") ? `cases of ${product}` : product;
    const qty = match[1] ? Number(match[1]) : 1;
    found.push({ qty, name, query: product });
  }
  return found;
}

export function extractQty(text) {
  const raw = String(text || "");
  if (/^(?:just\s+)?one\b/i.test(raw.trim()) && raw.trim().split(/\s+/).length <= 3) return 1;
  if (/^(?:just\s+)?(\d{1,4})\s*$/i.test(raw.trim())) return Number(raw.trim().match(/(\d{1,4})/)[1]);
  if (/\b(?:a|an|one)\s+(?:case|cases|pair|pairs|box|boxes)\b/i.test(raw)) return 1;
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

const OTHER_PRODUCT = new Set([
  "saw", "drill", "hammer", "blade", "bit", "grinder", "nailer", "battery",
  "glove", "ladder", "caulk", "gun", "compressor", "generator", "wrench",
]);

function priceFromSnippet(text) {
  const range = String(text || "").match(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:to|through|-|–|—)\s*\$?\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i);
  if (range) {
    const low = asMoney(range[1]);
    const high = asMoney(range[2]);
    if (low && high) return { shelfLow: Math.min(low, high), shelfHigh: Math.max(low, high), source: "A" };
  }
  const amounts = [...String(text || "").matchAll(/\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)]
    .map((match) => asMoney(match[1]))
    .filter(Boolean);
  if (!amounts.length) return null;
  if (amounts.length === 1) return { shelf: amounts[0], source: "A" };
  return { shelf: amounts[amounts.length - 1], source: "A" };
}

function modelCode(name) {
  const match = String(name || "").match(/\b[a-z]{0,6}\d{3,}[a-z0-9-]*\b/i);
  return match ? match[0] : "";
}

function namesItem(text, nameTokens, sku) {
  if (sku && String(text || "").toLowerCase().includes(sku.toLowerCase())) return true;
  const overlap = nameTokens.filter((token) => contentTokens(text).includes(token)).length;
  return overlap >= 2;
}

function productConflict(text, nameTokens) {
  return contentTokens(text).some((token) => OTHER_PRODUCT.has(token) && !nameTokens.includes(token));
}

/**
 * Pull a shelf price for one item out of prose. A price in the same sentence
 * wins. A search card often puts the model on one line and the dollar amount
 * on the next, so a nearby price counts when that line is not a different product.
 */
export function shelvesFromText(prose, name) {
  const nameTokens = contentTokens(name);
  if (!nameTokens.length) return null;
  const text = String(prose || "");
  const parts = text.split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  let best = "";
  let bestScore = 0;
  for (const part of parts) {
    if (!/\$\s?\d/.test(part)) continue;
    const overlap = nameTokens.filter((token) => contentTokens(part).includes(token)).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = part;
    }
  }
  if (best && bestScore >= 1) return priceFromSnippet(best);
  const sku = modelCode(name);
  for (let i = 0; i < parts.length; i += 1) {
    if (!/\$\s?\d/.test(parts[i]) || productConflict(parts[i], nameTokens)) continue;
    for (let back = 1; back <= 3 && i - back >= 0; back += 1) {
      if (namesItem(parts[i - back], nameTokens, sku)) return priceFromSnippet(parts[i]);
      if (productConflict(parts[i - back], nameTokens)) break;
    }
  }
  return null;
}

export function fillMissingShelf(raw, catalog, prose = "") {
  const next = { ...raw };
  const givenShelf = asMoney(next.shelf);
  const altShelf = asMoney(next.price) || asMoney(next.shelfPrice) || asMoney(next.unitPrice);
  next.shelf = givenShelf || altShelf;
  next.shelfLow = asMoney(next.shelfLow);
  next.shelfHigh = asMoney(next.shelfHigh);
  if (!givenShelf && altShelf && (!next.source || String(next.source).toUpperCase() === "U")) next.source = "A";
  const hasShelf = (next.shelf && next.shelf > 0) || (next.shelfLow && next.shelfLow > 0);
  if (!hasShelf && !next.fixedPrice) {
    const exact = (catalog?.items || []).find((item) => item.sku && next.sku && String(item.sku).toLowerCase() === String(next.sku).toLowerCase());
    const hits = exact ? [exact] : matchCatalog(catalog, `${next.sku || ""} ${next.name || ""}`);
    const known = hits.find(hasFirmPrice) || hits[0];
    if (known?.fixedPrice && known.price != null) {
      next.fixedPrice = true;
      next.listPrice = known.price;
      next.sku = next.sku || known.sku;
    } else if (known?.shelfPrice != null && known.shelfPrice !== "") {
      next.shelf = Number(known.shelfPrice);
      if (!next.source || String(next.source).toUpperCase() === "U") next.source = "A";
      next.sku = next.sku || known.sku;
    } else if (known && (known.shelfLow != null || known.shelfHigh != null)) {
      next.shelfLow = Number(known.shelfLow);
      next.shelfHigh = known.shelfHigh != null ? Number(known.shelfHigh) : null;
      if (!next.source || String(next.source).toUpperCase() === "U") next.source = "A";
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

function coveredByCatalog(catalog, query) {
  return matchCatalog(catalog, query).some((item) => hasUsablePrice(item) || item.fixedPrice);
}

export function shouldSearch(userText, catalogOrMatches) {
  const text = String(userText || "");
  const priceAsk = /(\bprice\b|\bpricing\b|how much|\$|\bquote\b|\bestimate\b|\bcost\b)/i.test(text);
  const modelish = /\b[a-z]{0,6}-?\d{2,}[a-z0-9-]*\b/i.test(text);
  const qty = extractQty(text);
  const namedProduct = PRODUCT_WORD.test(text) && (qty != null || priceAsk);
  if (!priceAsk && !modelish && !namedProduct) return false;
  if (Array.isArray(catalogOrMatches)) {
    if (catalogOrMatches.length && catalogOrMatches.every((item) => hasUsablePrice(item) || item.fixedPrice)) return false;
    return true;
  }
  const catalog = catalogOrMatches || { items: [] };
  const queries = splitRequestedItems(text).map((part) => part.query);
  const subjects = queries.length ? queries : [text];
  return subjects.some((subject) => {
    if (coveredByCatalog(catalog, subject)) return false;
    return priceAsk || /\b[a-z]{0,6}-?\d{2,}[a-z0-9-]*\b/i.test(subject);
  });
}
