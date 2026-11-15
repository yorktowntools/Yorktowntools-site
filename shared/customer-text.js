import { BULK_LINE, SAFE_COST_REPLY, SAFE_RETAILER_REPLY } from "./copy.js";

const BLOCKED_HOSTS = [
  "homedepot.com",
  "homedepot.ca",
  "lowes.com",
  "lowes.ca",
  "grainger.com",
  "whitecap.com",
  "whitecapdirect.com",
  "harborfreight.com",
  "menards.com",
  "northerntool.com",
  "fastenal.com",
  "acehardware.com",
  "walmart.com",
  "amazon.com",
  "amazon.ca",
  "amzn.to",
  "a.co",
  "colonyhardware.com",
  "hdsupply.com",
  "hdsupplysolutions.com",
  "mscdirect.com",
  "zoro.com",
  "toolbarn.com",
  "acmetools.com",
  "maxtool.com",
  "cpooutlets.com",
  "costco.com",
  "samsclub.com",
  "target.com",
  "truevalue.com",
  "doitbest.com",
  "ferguson.com",
  "supplyhouse.com",
  "homedepotpro.com",
];

const ALLOWED_HOSTS = [
  "yorktowntools.com",
  "yorktowntools.beehiiv.com",
  "dewalt.com",
  "milwaukeetool.com",
  "makitatools.com",
  "makita.com",
  "makita.co.jp",
  "boschtools.com",
  "bosch.com",
  "metabo.com",
  "metabohpt.com",
  "wernerco.com",
  "jackery.com",
  "kleintools.com",
  "knipex.com",
  "knipex-tools.com",
  "tekton.com",
  "craftsman.com",
  "gearwrench.com",
  "irwintools.com",
  "ridgid.com",
  "stanleytools.com",
  "bondhus.com",
  "keson.com",
  "diablotools.com",
  "diablo.com",
  "cutwithlenox.com",
  "lenoxtools.com",
  "freudtools.com",
  "spyderproducts.com",
  "knaack.com",
  "crescenttool.com",
  "channellock.com",
  "stabila.com",
  "empirelevel.com",
  "pyramex.com",
  "3m.com",
  "ergodyne.com",
  "mechanix.com",
  "bolle-safety.com",
  "howardleight.com",
  "howardleightshootingsports.com",
  "liftsafety.com",
  "msasafety.com",
  "fluke.com",
  "yellowjacket.com",
  "gearteam.com",
];

const RETAILER_PATTERNS = [
  /\bh[\W_]*o[\W_]*m[\W_]*e[\W_]*d[\W_]*e[\W_]*p[\W_]*o[\W_]*t\b/i,
  /\bl[\W_]*o[\W_]*w[\W_]*e[\W_]*['’]?[\W_]*s\b/i,
  /\bhome[\s\-]*depot\b/i,
  /\blowes\b/i,
  /\bgrainger\b/i,
  /\bwhite[\s\-]*cap\b/i,
  /\bharbor[\s\-]*freight\b/i,
  /\bmenards\b/i,
  /\bnorthern[\s\-]*tool\b/i,
  /\bfastenal\b/i,
  /\bace[\s\-]+hardware\b/i,
  /\bwal[\s\-]*mart\b/i,
  /\bamazon\b/i,
  /\bcolony[\s\-]+hardware\b/i,
  /\bhd[\s\-]*supply\b/i,
  /\bmsc[\s\-]+(?:industrial|direct)\b/i,
  /\bcostco\b/i,
  /\bsam['’]?s[\s\-]*club\b/i,
  /\btoolbarn\b/i,
  /\bacme[\s\-]*tools\b/i,
];

const COST_PATTERNS = [
  /\bour cost\b/i,
  /\bmy cost\b/i,
  /\bat cost\b/i,
  /\bcost price\b/i,
  /\bwhat we pay\b/i,
  /\bwhat i pay\b/i,
  /\bmargin\b/i,
  /\bmarkup\b/i,
  /\bmark[\s\-]*up\b/i,
  /\bmilitary discount\b/i,
  /\bveteran discount\b/i,
  /\bsupplier discount\b/i,
  /\b(?:our|my) supplier\b/i,
  /\b(?:our|my) distributor\b/i,
  /\bstart at cost\b/i,
  /\bwork our way up\b/i,
];

function hostMatches(host, suffix) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  const s = String(suffix || "").toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
  return h === s || h.endsWith(`.${s}`);
}

export function hostnameOf(value) {
  try {
    const url = new URL(String(value), "https://yorktowntools.com");
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function isBlockedHost(hostname) {
  return BLOCKED_HOSTS.some((host) => hostMatches(hostname, host));
}

export function isAllowedCustomerUrl(value) {
  const raw = String(value || "").trim();
  if (/^tel:\+?17579405171$/i.test(raw)) return true;
  if (/^sms:\+?17579405171$/i.test(raw)) return true;
  if (/^mailto:sales@yorktowntools\.com$/i.test(raw)) return true;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (isBlockedHost(host)) return false;
  return ALLOWED_HOSTS.some((allowed) => hostMatches(host, allowed));
}

function stripInvisible(text) {
  return String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function splitChunks(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesAny(text, patterns) {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

function scrubUrls(text) {
  let retailerHit = false;
  const withoutMarkdown = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (full, label, url) => {
    if (isAllowedCustomerUrl(url)) return full;
    retailerHit = retailerHit || isBlockedHost(hostnameOf(url));
    return label || "";
  });
  const withoutBare = withoutMarkdown.replace(/\bhttps?:\/\/[^\s<>"')]+/gi, (url) => {
    const clean = url.replace(/[.,;:!?]+$/, "");
    const tail = url.slice(clean.length);
    if (isAllowedCustomerUrl(clean)) return url;
    if (isBlockedHost(hostnameOf(clean))) retailerHit = true;
    return tail.trim() ? "" : "";
  });
  return { text: withoutBare, retailerHit };
}

export function filterCustomerText(input) {
  const original = stripInvisible(input);
  if (!original.trim()) {
    return { text: "", retailerHit: false, costHit: false, replaced: false };
  }

  const costHit = matchesAny(original, COST_PATTERNS);
  if (costHit) {
    return { text: SAFE_COST_REPLY, retailerHit: false, costHit: true, replaced: true };
  }

  const urlPass = scrubUrls(original);
  const keptLines = [];
  let retailerHit = urlPass.retailerHit || matchesAny(original, RETAILER_PATTERNS);
  for (const line of urlPass.text.split(/\n+/)) {
    const kept = [];
    for (const chunk of splitChunks(line)) {
      if (matchesAny(chunk, RETAILER_PATTERNS) || matchesAny(chunk, COST_PATTERNS)) {
        retailerHit = true;
        continue;
      }
      if (isBlockedHost(hostnameOf(chunk))) {
        retailerHit = true;
        continue;
      }
      kept.push(chunk);
    }
    const joined = kept.join(" ").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
    if (joined) keptLines.push(joined);
  }

  let text = keptLines.join("\n").trim();
  if (retailerHit && !text) {
    return { text: SAFE_RETAILER_REPLY, retailerHit: true, costHit: false, replaced: true };
  }
  if (matchesAny(text, RETAILER_PATTERNS) || matchesAny(text, COST_PATTERNS)) {
    return { text: SAFE_RETAILER_REPLY, retailerHit: true, costHit: false, replaced: true };
  }
  return { text, retailerHit, costHit: false, replaced: false };
}

export function hasDollarAmount(text) {
  return /\$\s?\d/.test(String(text || ""));
}

export function ensureBulkLine(text, needed) {
  const body = String(text || "").trim();
  if (!needed) return body;
  if (/better pricing/i.test(body)) return body;
  if (!body) return BULK_LINE;
  return `${body}\n\n${BULK_LINE}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderSafeHtml(input) {
  const filtered = filterCustomerText(input).text;
  const escaped = escapeHtml(filtered);
  const linked = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
    const decoded = url.replace(/&amp;/g, "&");
    if (!isAllowedCustomerUrl(decoded)) return label;
    const href = escapeHtml(decoded);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return linked.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
}

export function publicQuoteItem(item) {
  if (!item) return null;
  const name = filterCustomerText(item.name || "Item").text || "Item";
  const manufacturerUrl = isAllowedCustomerUrl(item.manufacturerUrl) ? item.manufacturerUrl : "";
  const categoryPage = isAllowedCustomerUrl(item.categoryPage) ? item.categoryPage : "";
  const qty = Number(item.qty);
  return {
    name,
    sku: String(item.sku || "").slice(0, 80),
    qty: Number.isFinite(qty) && qty > 0 ? qty : null,
    estimate: item.estimate == null ? null : item.estimate,
    estimateHigh: item.estimateHigh == null ? null : item.estimateHigh,
    confidence: item.confidence || "unsure",
    kind: item.kind || "unsure",
    manufacturerUrl,
    categoryPage,
    asOf: item.asOf || null,
  };
}

export { BULK_LINE, SAFE_COST_REPLY, SAFE_RETAILER_REPLY };
