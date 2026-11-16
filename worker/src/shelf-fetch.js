/** Pull a shelf price off one or two product pages when search returns URLs only. */

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

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

function walkUrls(value, pages, seen, depth) {
  if (depth > 8 || value == null || pages.length >= 2) return;
  if (typeof value === "string") {
    const found = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const raw of found) {
      const url = usableProductUrl(raw.replace(/[),.;]+$/, ""));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      pages.push({ url, title: "" });
      if (pages.length >= 2) return;
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
  if (pages.length >= 2) return;
  Object.values(value).forEach((item) => {
    if (item && (typeof item === "object" || typeof item === "string")) walkUrls(item, pages, seen, depth + 1);
  });
}

export function collectSearchUrls(data, limit = 2) {
  const pages = [];
  walkUrls(data, pages, new Set(), 0);
  return pages.slice(0, limit);
}

async function loadOne(page, fetchImpl, budgetMs, now) {
  const hit = cache.get(page.url);
  if (hit && hit.expires > now) return { ...page, shelf: hit.shelf, cached: true };
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
    const shelf = extractShelfPrice(String(raw).slice(0, 250000));
    if (shelf) cache.set(page.url, { shelf, expires: now + TTL_MS });
    return { ...page, shelf, cached: false };
  } catch {
    return { ...page, shelf: null, cached: false };
  } finally {
    clearTimeout(rejectTimer);
  }
}

export async function fetchShelfPrices(pages, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1800;
  const now = options.now || Date.now();
  const list = (Array.isArray(pages) ? pages : []).slice(0, 2).map((page) => {
    if (typeof page === "string") return { url: usableProductUrl(page), title: "" };
    return { url: usableProductUrl(page?.url || ""), title: String(page?.title || "") };
  }).filter((page) => page.url);
  if (!list.length) return [];
  const started = Date.now();
  const results = await Promise.all(list.map((page) => {
    const budget = Math.max(0, timeoutMs - (Date.now() - started));
    return loadOne(page, fetchImpl, budget, now);
  }));
  return results;
}
