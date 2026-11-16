/**
 * Public Jackery catalog. shelfPrice is the current promo MAP.
 * No dealer cost and no supplier name live in this file.
 */

import rawCatalog from "./jackery-catalog.json" with { type: "json" };

export const JACKERY_HOME = "https://www.jackery.com/";
const SITE_PAGE = "https://yorktowntools.com/portable-power.html";

function displayName(entry) {
  const model = String(entry.model || "").trim();
  if (/^jackery\b/i.test(model)) return model;
  let name = model
    .replace(/^E(\d)/, "Explorer $1")
    .replace(/^HP(\d)/, "HomePower $1")
    .replace(/Plus/g, " Plus")
    .replace(/v2/gi, " v2")
    .replace(/Ultra/g, " Ultra")
    .replace(/ProMax/g, " Pro Max")
    .replace(/Red Cross/gi, " Red Cross")
    .replace(/\s+/g, " ")
    .trim();
  if (entry.category === "Solar Panels" && !/solar/i.test(name)) name = `${name} solar panel`;
  return `Jackery ${name}`;
}

export const jackeryItems = rawCatalog.map((entry) => ({
  sku: entry.id,
  model: entry.model,
  name: displayName(entry),
  description: entry.description || "",
  category: entry.category || "",
  manufacturer: "Jackery",
  manufacturerUrl: JACKERY_HOME,
  categoryPage: SITE_PAGE,
  shelfPrice: entry.shelfPrice,
  mapPrice: true,
  stockNote: entry.stockNote || "",
  source: "A",
  date: "2026-11-16",
}));

function mentionsJackery(text) {
  return /jackery|home\s*power|explorer|power station|solar generator|portable power|\bhp\s*\d{3,4}|\be\s*\d{3,4}/i.test(String(text || ""));
}

function norm(text) {
  let value = String(text || "").toLowerCase();
  value = value.replace(/home\s*power/g, "hp");
  value = value.replace(/explorer/g, "e");
  value = value.replace(/pro\s*max/g, "promax");
  value = value.replace(/red\s*cross/g, "redcross");
  value = value.replace(/\bv\s*2\b/g, "v2");
  value = value.replace(/[^a-z0-9+]+/g, " ");
  value = value.replace(/\b(e|hp)(\d{3,4})/g, "$1 $2");
  value = value.replace(/plus/g, " plus ");
  value = value.replace(/v2/g, " v2 ");
  value = value.replace(/ultra/g, " ultra ");
  value = value.replace(/promax/g, " promax ");
  value = value.replace(/redcross/g, " redcross ");
  return value.replace(/\s+/g, " ").trim();
}

function flags(text) {
  const parts = norm(text).split(" ").filter(Boolean);
  const numbers = parts.filter((part) => /^\d{3,4}$/.test(part));
  return {
    family: parts.includes("hp") ? "hp" : (parts.includes("e") ? "e" : ""),
    capacity: numbers[0] || "",
    plus: parts.includes("plus"),
    v2: parts.includes("v2"),
    ultra: parts.includes("ultra"),
    promax: parts.includes("promax"),
    white: parts.includes("white") || parts.includes("dune"),
    redcross: parts.includes("redcross"),
    solar: /solar|solarsaga|\bpanel\b/.test(norm(text)),
    battery: parts.includes("battery"),
    bag: parts.includes("bag") || parts.includes("case"),
  };
}

function scoreItem(query, item) {
  const q = flags(query);
  const itemFlags = flags(item.model);
  if (!q.capacity && !q.family) return -1;
  let score = 0;
  if (q.capacity) {
    if (itemFlags.capacity !== q.capacity) return -1;
    score += 50;
  }
  if (q.family) {
    if (itemFlags.family && itemFlags.family !== q.family) return -1;
    score += itemFlags.family === q.family ? 40 : 0;
  }
  score += q.plus === itemFlags.plus ? 15 : -20;
  score += q.v2 === itemFlags.v2 ? 10 : -8;
  score += q.ultra === itemFlags.ultra ? 12 : -12;
  score += q.promax === itemFlags.promax ? 12 : -12;
  if (q.white) score += itemFlags.white ? 24 : -30;
  else if (itemFlags.white) score -= 14;
  if (q.redcross) score += itemFlags.redcross ? 24 : -20;
  else if (itemFlags.redcross) score -= 14;
  const kit = /\+/.test(item.model);
  if (kit) score += q.solar || q.battery || q.bag ? 8 : -35;
  if (/battery pack/i.test(item.category || "") && !q.battery) score -= 25;
  if (item.category === "Accessories" && q.capacity && !q.bag) score -= 15;
  return score;
}

function suggestionLine(items) {
  const picks = [];
  for (const item of items) {
    if (picks.length >= 3) break;
    if (/\+/.test(item.model)) continue;
    if (/white|dune|red cross/i.test(item.model)) continue;
    if (picks.some((pick) => pick.sku === item.sku)) continue;
    picks.push(item);
  }
  const names = (picks.length ? picks : items.slice(0, 3)).map((item) => item.name.replace(/^Jackery\s+/, ""));
  return `What are you powering, and for about how long? Do you want solar with it? A few that fit a job site: ${names.join(", ")}.`;
}

export function resolveJackery(text) {
  const raw = String(text || "").trim();
  if (!raw || !mentionsJackery(raw)) return null;
  const ranked = jackeryItems
    .map((item) => ({ item, score: scoreItem(raw, item) }))
    .filter((row) => row.score >= 40)
    .sort((a, b) => b.score - a.score);
  const vague = !flags(raw).capacity;
  if (vague || ranked.length === 0) {
    const ideas = jackeryItems.filter((item) => ["JACKERY-E1000V2", "JACKERY-E2000V2", "JACKERY-HP3600PLUS"].includes(item.sku));
    return { action: "ask", reply: suggestionLine(ideas) };
  }
  const top = ranked[0];
  const second = ranked[1];
  if (second && top.score - second.score < 12) {
    return { action: "ask", reply: suggestionLine(ranked.map((row) => row.item)) };
  }
  return { action: "quote", item: top.item };
}

export function customerStockNote(note) {
  const text = String(note || "").trim();
  if (!/pre-order|out of stock/i.test(text)) return "";
  return text;
}
