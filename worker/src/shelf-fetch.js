/** Pull a shelf price off a few product pages when search returns URLs only. */

const TTL_MS = 6 * 60 * 60 * 1000;
const MODEL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FETCH_PAGES = 4;
const cache = new Map();
const modelShelves = new Map();

const PRODUCT_HOSTS = [
  "homedepot.com",
  "lowes.com",
  "dewalt.com",
  "milwaukeetool.com",
  "makitatools.com",
  "makita.com",
  "boschtools.com",
  "bosch.com",
  "ridgid.com",
  "metabo.com",
];

export function resetShelfCache() {
  cache.clear();
  modelShelves.clear();
}

export function normalizeModel(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const MODEL_TOKEN = /\b[a-z]{1,6}\d{3,}[a-z0-9-]*\b/gi;

export function exactModelsIn(text) {
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const norm = normalizeModel(value);
    if (norm.length < 5 || !/\d{3,}/.test(norm) || seen.has(norm)) return;
    seen.add(norm);
    found.push(norm);
  };
  const raw = String(text || "");
  for (const match of raw.matchAll(MODEL_TOKEN)) add(match[0]);
  for (const match of raw.matchAll(/\b([a-z]{2,6})[\s-]+(\d{3,}[a-z0-9]*)\b/gi)) add(`${match[1]}${match[2]}`);
  return found;
}

export function textHasExactModel(value, model) {
  const wanted = normalizeModel(model);
  if (!wanted || wanted.length < 5) return false;
  const tokens = String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    let joined = "";
    for (let j = i; j < tokens.length; j += 1) {
      joined += tokens[j];
      if (joined === wanted) return true;
      if (joined.length >= wanted.length) break;
    }
  }
  return false;
}

export function pageMatchesModel(page, model) {
  const fields = [page?.url, page?.title, page?.name, page?.model, page?.sku];
  return fields.some((field) => textHasExactModel(field, model));
}

function shelfKey(model) {
  const norm = normalizeModel(model).toUpperCase();
  return norm ? `shelf:${norm}` : "";
}

export async function readModelShelf(env, model) {
  const key = shelfKey(model);
  if (!key) return null;
  const now = Date.now();
  const memory = modelShelves.get(key);
  if (memory && memory.expires > now && Number(memory.shelf) > 0) return Number(memory.shelf);
  const kv = env?.PRIVATE_COSTS_KV;
  if (!kv || typeof kv.get !== "function") return null;
  try {
    const raw = await kv.get(key);
    if (raw == null || !String(raw).trim()) return null;
    const parsed = JSON.parse(String(raw));
    const shelf = Number(parsed?.shelf);
    const expires = Number(parsed?.expires) || 0;
    if (!(shelf > 0) || (expires && expires <= now)) return null;
    modelShelves.set(key, { shelf, expires: expires || now + MODEL_TTL_MS });
    return shelf;
  } catch {
    return null;
  }
}

export async function writeModelShelf(env, model, shelf) {
  const price = Number(shelf);
  const key = shelfKey(model);
  if (!key || !(price > 0)) return;
  const record = { shelf: Math.round(price * 100) / 100, expires: Date.now() + MODEL_TTL_MS };
  modelShelves.set(key, record);
  const kv = env?.PRIVATE_COSTS_KV;
  if (!kv || typeof kv.put !== "function") return;
  try {
    await kv.put(key, JSON.stringify(record), { expirationTtl: 24 * 60 * 60 });
  } catch {
    // The in-memory shelf still keeps this run consistent.
  }
}

function hostOk(hostname) {
  const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
  return PRODUCT_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

export function usableProductUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (!hostOk(url.hostname)) return "";
  if (/\/s(?:earch)?\/|\/b\/|\/browse|\/s\?/i.test(`${url.pathname}${url.search}`)) return "";
  return url.toString();
}

function asShelf(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") {
    if (value.price != null) return asShelf(value.price);
    if (value.lowPrice != null) return asShelf(value.lowPrice);
    return null;
  }
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(number) || number < 10 || number > 20000) return null;
  return Math.round(number * 100) / 100;
}

function priceFromOffer(offer) {
  const list = Array.isArray(offer) ? offer : [offer];
  for (const entry of list) {
    const amount = asShelf(entry?.price ?? entry?.lowPrice ?? entry?.highPrice);
    if (amount) return amount;
  }
  return null;
}

function priceFromJson(value, depth = 0) {
  if (depth > 7 || value == null) return null;
  if (typeof value === "string") {
    try {
      return priceFromJson(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = priceFromJson(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const type = String(value["@type"] || "");
  if (value.offers && /product|offer/i.test(type || "Product")) {
    const priced = priceFromOffer(value.offers);
    if (priced) return priced;
  }
  if (value["@graph"]) return priceFromJson(value["@graph"], depth + 1);
  if (/^product$/i.test(type) && value.offers) return priceFromOffer(value.offers);
  return null;
}

export function extractShelfPrice(html) {
  const text = String(html || "");
  const blocks = text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    const priced = priceFromJson(block[1]);
    if (priced) return priced;
  }
  const meta = text.match(/(?:itemprop|property)=["']price["'][^>]*content=["'](\d+(?:\.\d{1,2})?)["']/i)
    || text.match(/content=["'](\d+(?:\.\d{1,2})?)["'][^>]*(?:itemprop|property)=["']price["']/i);
  if (meta) {
    const amount = asShelf(meta[1]);
    if (amount) return amount;
  }
  const named = text.match(/"(?:currentPrice|sellingPrice|specialPrice|salePrice)"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/i)
    || text.match(/"pricing"\s*:\s*\{[^}]{0,240}"value"\s*:\s*"?(\d+(?:\.\d{1,2})?)"?/i);
  if (named) {
    const amount = asShelf(named[1]);
    if (amount) return amount;
  }
  return null;
}

function modelFromJson(value, depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") {
    try {
      return modelFromJson(JSON.parse(value), depth + 1);
    } catch {
      return "";
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = modelFromJson(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const type = String(value["@type"] || "");
  if (/product/i.test(type) || value.sku || value.mpn || value.model) {
    const direct = exactModelsIn(`${value.sku || ""} ${value.mpn || ""} ${value.model || ""}`)[0];
    if (direct) return direct;
    const named = exactModelsIn(String(value.name || ""))[0];
    if (named) return named;
  }
  if (value["@graph"]) return modelFromJson(value["@graph"], depth + 1);
  return "";
}

export function extractPageModel(html) {
  const text = String(html || "");
  const blocks = text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    const model = modelFromJson(block[1]);
    if (model) return model;
  }
  return "";
}

const COLLECT_LIMIT = 8;

function hostKey(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function pickDiverseProductPages(pages, limit = 2) {
  const firstByHost = [];
  const seenHost = new Set();
  const rest = [];
  for (const page of pages || []) {
    const host = hostKey(page?.url);
    if (!page?.url || !host) continue;
    if (seenHost.has(host)) {
      rest.push(page);
      continue;
    }
    seenHost.add(host);
    firstByHost.push(page);
  }
  return [...firstByHost, ...rest].slice(0, limit);
}

function walkUrls(value, pages, seen, depth) {
  if (depth > 8 || value == null || pages.length >= COLLECT_LIMIT) return;
  if (typeof value === "string") {
    const found = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const raw of found) {
      const url = usableProductUrl(raw.replace(/[),.;]+$/, ""));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pages.push({ url, title: "" });
      if (pages.length >= COLLECT_LIMIT) return;
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walkUrls(item, pages, seen, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const url = usableProductUrl(value.url || value.link || "");
  if (url && !seen.has(url)) {
    seen.add(url);
    pages.push({ url, title: String(value.title || value.name || "") });
  }
  if (pages.length >= COLLECT_LIMIT) return;
  Object.values(value).forEach((item) => {
    if (item && (typeof item === "object" || typeof item === "string")) walkUrls(item, pages, seen, depth + 1);
  });
}

export function collectSearchUrls(data, limit = 2) {
  const pages = [];
  walkUrls(data, pages, new Set(), 0);
  return pickDiverseProductPages(pages, limit);
}

async function loadOne(page, fetchImpl, budgetMs, now) {
  const hit = cache.get(page.url);
  if (hit && hit.expires > now) return { ...page, shelf: hit.shelf, model: hit.model || page.model || "", cached: true };
  if (budgetMs < 30) return { ...page, shelf: null, cached: false };
  const controller = new AbortController();
  let rejectTimer;
  const timeout = new Promise((_, reject) => {
    rejectTimer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, budgetMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(page.url, {
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "YorktownToolsGeorge/1.0",
        },
      }),
      timeout,
    ]);
    const raw = typeof response === "string"
      ? response
      : await Promise.race([response.text(), timeout]);
    const html = String(raw).slice(0, 250000);
    const shelf = extractShelfPrice(html);
    const model = extractPageModel(html);
    if (shelf) cache.set(page.url, { shelf, model, expires: now + TTL_MS });
    return { ...page, shelf, model: model || page.model || "", cached: false };
  } catch {
    return { ...page, shelf: null, cached: false };
  } finally {
    clearTimeout(rejectTimer);
  }
}

export async function fetchShelfPrices(pages, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 2500;
  const now = options.now || Date.now();
  const deadline = Number(options.deadline) > 0 ? Number(options.deadline) : now + timeoutMs;
  const list = (Array.isArray(pages) ? pages : []).slice(0, MAX_FETCH_PAGES).map((page) => {
    if (typeof page === "string") return { url: usableProductUrl(page), title: "" };
    return { url: usableProductUrl(page?.url || ""), title: String(page?.title || ""), model: page?.model || "" };
  }).filter((page) => page.url);
  if (!list.length) return [];
  const results = await Promise.all(list.map((page) => {
    const budget = Math.max(0, deadline - Date.now());
    return loadOne(page, fetchImpl, budget, now);
  }));
  return results;
}
