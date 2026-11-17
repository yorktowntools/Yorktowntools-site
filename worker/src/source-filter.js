/** Server-only names of retailers, wholesalers, and sales groups. Not published. */

import {
  filterCustomerText as filterGeneric,
  hostnameOf,
  SAFE_COST_REPLY,
  SAFE_RETAILER_REPLY,
} from "../../shared/customer-text.js";

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

const SOURCE_COST_PATTERNS = [
  /\bors\b/i,
  /\bnasco\b/i,
  /\bpower\s*77\b/i,
];

function hostMatches(host, suffix) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  const s = String(suffix || "").toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
  return h === s || h.endsWith(`.${s}`);
}

function matchesAny(text, patterns) {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

function hasBlockedUrl(text) {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"')]+|\((https?:\/\/[^)\s]+)\)/gi) || [];
  return urls.some((raw) => {
    const host = hostnameOf(raw.replace(/^\(|\)$/g, ""));
    return BLOCKED_HOSTS.some((blocked) => hostMatches(host, blocked));
  });
}

function dropNamedSentences(text) {
  const lines = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) {
      lines.push("");
      continue;
    }
    const kept = [];
    for (const chunk of line.split(/(?<=[.!?])\s+/)) {
      if (matchesAny(chunk, RETAILER_PATTERNS) || matchesAny(chunk, SOURCE_COST_PATTERNS)) continue;
      const piece = chunk.trim();
      if (piece) kept.push(piece);
    }
    const joined = kept.join(" ").replace(/[ \t]{2,}/g, " ").trim();
    if (joined) lines.push(joined);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function filterCustomerText(input, options = {}) {
  const original = String(input || "");
  if (matchesAny(original, SOURCE_COST_PATTERNS)) {
    return { text: SAFE_COST_REPLY, retailerHit: false, costHit: true, replaced: true };
  }
  const generic = filterGeneric(input, options);
  if (generic.costHit || generic.replaced) return generic;
  const named = matchesAny(original, RETAILER_PATTERNS)
    || matchesAny(generic.text, RETAILER_PATTERNS)
    || hasBlockedUrl(original);
  if (!named) return generic;
  const text = dropNamedSentences(generic.text);
  if (!text || matchesAny(text, RETAILER_PATTERNS) || matchesAny(text, SOURCE_COST_PATTERNS)) {
    return { text: SAFE_RETAILER_REPLY, retailerHit: true, costHit: false, replaced: true };
  }
  return { ...generic, text, retailerHit: true };
}
