import catalog from "../../data/prices.json" with { type: "json" };
import { accessoryAsked, accessoryOffer } from "../config/accessories.js";
import { jackeryItems, resolveJackery, resolveJackeryFollowup } from "../config/jackery.js";
import { BULK_LINE, CLOSING_LINE, HANDOFF_LINE, READY_LINE, SALES_EMAIL, SCAM_CLOSE } from "../../shared/copy.js";
import { cartFromThread, eachQty, listReadback, readIdentity, readyClose, askedForReach, sawGuide, userBlob } from "../../shared/job.js";
import { acceptsModel, pendingModelConfirm } from "../../shared/trade.js";
import { isCustomerPriceAsk } from "../../shared/customer-text.js";
import { filterCustomerText } from "./source-filter.js";
import { confusedWhatReply, localReply } from "../../shared/local-reply.js";
import { cannedWouldRepeat, chatStage, clarifyingQuestion, concreteDrillingAdvice, genericSawQuestion, isConfusedOrFrustrated, isShortReply, shouldKeepLocal } from "../../shared/talk.js";
import {
  collectSearchShelves,
  collectSearchUrls,
  exactModelsIn,
  fetchShelfPrices,
  lowestShelf,
  normalizeModel,
  pageMatchesModel,
  readModelShelf,
  resetShelfCache,
  writeModelShelf,
} from "./shelf-fetch.js";
import {
  fillMissingShelf,
  formatMoney,
  hasFirmPrice,
  catalogConflict,
  customerBrand,
  matchCatalog,
  roundMoney,
  shouldSearch,
  splitRequestedItems,
} from "../../shared/pricing.js";
import { buildHandoffEmail, buildQuoteEmail, buildSalesEmail, formspreeBody, handoffFormspreeBody } from "./email.js";
import { buildInstructions } from "./prompt.js";
import { privateCostFor, readPrivateCosts } from "../config/private-costs.js";
import { itemLinkLine, presentQuote, priceFromShelf, replyWithFinalPrices, rules, withoutRepeatedAfterHours } from "./policy.js";

const buckets = new Map();

const handoffSent = new Map();

export function resetLimits() {
  buckets.clear();
  resetShelfCache();
  handoffSent.clear();
}

function limit(key, max, windowMs, now) {
  const hit = buckets.get(key);
  if (!hit || now - hit.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return { ok: true, remaining: max - 1 };
  }
  if (hit.count >= max) return { ok: false, remaining: 0 };
  hit.count += 1;
  return { ok: true, remaining: max - hit.count };
}

function underCap(key, max, windowMs, now) {
  const hit = buckets.get(key);
  if (!hit || now - hit.start >= windowMs) return true;
  return hit.count < max;
}

function take(key, amount, windowMs, now) {
  const hit = buckets.get(key);
  if (!hit || now - hit.start >= windowMs) {
    buckets.set(key, { start: now, count: amount });
    return;
  }
  hit.count += amount;
}

function clientIp(request) {
  const header = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
  return header.split(",")[0].trim() || "unknown";
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (origin && list.includes(origin)) return origin;
  return "";
}

function corsHeaders(request, env, extra = {}) {
  const headers = { ...extra };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function json(body, status, request, env, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(request, env, {
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    }),
  });
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safePage(page) {
  try {
    const url = new URL(String(page || ""), "https://yorktowntools.com");
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "yorktowntools.com" && host !== "localhost" && host !== "127.0.0.1") return "";
    return (url.pathname || "/").slice(0, 180);
  } catch {
    return "";
  }
}

function sessionId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return "";
  return id;
}

function trimMessages(messages, max) {
  const clean = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const content = String(message.content || "").slice(0, 1200);
    if (!content.trim()) continue;
    clean.push({ role: message.role, content });
  }
  if (clean.length <= max) return clean;
  const recent = clean.slice(-(max - 1));
  const anchor = clean.find((message) => message.role === "user" && !isShortReply(message.content));
  if (!anchor || recent.includes(anchor)) return clean.slice(-max);
  return [anchor, ...recent];
}

function splitModelOutput(raw) {
  const text = String(raw || "");
  const index = text.search(/QUOTE_JSON\s*:/i);
  let reply = text;
  let quote = null;
  if (index >= 0) {
    reply = text.slice(0, index).trim();
    const jsonPart = text.slice(index).replace(/^[^\n{]*/, "");
    const start = jsonPart.indexOf("{");
    const end = jsonPart.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        quote = JSON.parse(jsonPart.slice(start, end + 1));
      } catch {
        quote = null;
      }
    }
  }
  reply = reply.replace(/^REPLY\s*:\s*/i, "").trim();
  return { reply, quote };
}

function outputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function countSearches(data) {
  const usage = data?.usage?.server_side_tool_usage || data?.server_side_tool_usage || {};
  const direct = Number(usage.SERVER_SIDE_TOOL_WEB_SEARCH || usage.web_search || 0);
  if (direct) return direct;
  return (data?.output || []).filter((item) => String(item?.type || "").includes("web_search")).length;
}

async function callXai(env, instructions, input, useSearch) {
  const model = env.XAI_MODEL || "grok-4.3";
  const full = {
    model,
    instructions,
    input,
    temperature: 0.3,
    max_output_tokens: num(env.MAX_OUTPUT_TOKENS, 320),
    // grok-4.3 defaults to low reasoning, which is most of a no-search wait.
    // none skips that. Search turns stay on low so tool use still works.
    reasoning: { effort: useSearch ? "low" : "none" },
  };
  if (useSearch) {
    full.tools = [{
      type: "web_search",
      filters: { allowed_domains: ["homedepot.com", "lowes.com"] },
    }];
  }
  const send = (body) => fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.XAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let response = await send(full);
  if (response.status === 400) {
    const slim = { model, instructions, input };
    if (useSearch) slim.tools = [{ type: "web_search" }];
    response = await send(slim);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("xai");
    error.status = response.status;
    throw error;
  }
  return data;
}

const WARRANTIES = [
  [/dewalt/i, "https://www.dewalt.com/support/warranty"],
  [/milwaukee/i, "https://www.milwaukeetool.com/support/warranty"],
  [/makita/i, "https://www.makitatools.com/support/warranty"],
  [/klein/i, "https://www.kleintools.com/support/warranty"],
];

function warrantyFor(name) {
  const hit = WARRANTIES.find(([pattern]) => pattern.test(String(name || "")));
  return hit ? hit[1] : "";
}

function collectDollarText(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") {
    if (/\$\s?\d/.test(value) && value.length < 8000) out.push(value);
    return out;
  }
  if (Array.isArray(value)) value.forEach((item) => collectDollarText(item, out, depth + 1));
  else if (typeof value === "object") Object.values(value).forEach((item) => collectDollarText(item, out, depth + 1));
  return out;
}

function searchCards(value, out = [], depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item) => searchCards(item, out, depth + 1));
    return out;
  }
  const bits = [];
  for (const key of ["title", "name", "snippet", "description", "content"]) {
    if (typeof value[key] === "string" && value[key].trim()) bits.push(value[key].trim());
  }
  const numeric = [value.price, value.salePrice].find((item) => typeof item === "number" && item > 0);
  if (numeric) bits.push(`$${numeric}`);
  const blob = bits.join("\n");
  if (bits.length >= 2 && /\$\s?\d|\b\d{2,5}(?:\.\d{2})\b/.test(blob)) out.push(blob);
  Object.values(value).forEach((item) => {
    if (item && typeof item === "object") searchCards(item, out, depth + 1);
  });
  return out;
}

function alignRequested(rawItems, userText) {
  const requested = splitRequestedItems(userText);
  if (requested.length < 2) return rawItems;
  const used = new Set();
  return requested.map((ask) => {
    const catalogHits = matchCatalog(catalog, ask.query);
    const index = rawItems.findIndex((item, i) => {
      if (used.has(i)) return false;
      const lineHits = matchCatalog(catalog, `${item?.name || ""} ${item?.sku || ""}`);
      if (catalogHits[0] && lineHits[0] && catalogHits[0].sku === lineHits[0].sku) return true;
      return `${item?.name || ""} ${item?.sku || ""}`.toLowerCase().includes(ask.query.toLowerCase());
    });
    if (index >= 0) {
      used.add(index);
      return { ...rawItems[index], qty: ask.qty, name: rawItems[index].name || ask.name };
    }
    if (catalogHits[0]) return { name: catalogHits[0].name, sku: catalogHits[0].sku, qty: ask.qty };
    return { name: ask.name, qty: ask.qty, source: "U" };
  });
}

function familyOf(name) {
  const value = String(name || "").toLowerCase();
  if (/caulk gun/.test(value)) return "caulk-gun";
  if (/caulk/.test(value)) return "caulk";
  if (/blade/.test(value)) return "blade";
  if (/circular saw|5007|\bsaws?\b/.test(value)) return "saw";
  return "";
}

function rankItem(item) {
  return (item?.sku ? 10 : 0) + (/\d{3,}/.test(`${item?.sku || ""} ${item?.name || ""}`) ? 5 : 0);
}

function preferSpecific(items) {
  const out = [];
  for (const item of items || []) {
    if (!item?.name || /^item$/i.test(item.name)) continue;
    const family = familyOf(item.name);
    const index = family ? out.findIndex((existing) => familyOf(existing.name) === family) : -1;
    if (index >= 0) {
      if (rankItem(item) > rankItem(out[index])) {
        out[index] = { ...item, qty: item.qty || out[index].qty };
      }
      continue;
    }
    if (item.sku && out.some((existing) => existing.sku === item.sku)) continue;
    out.push(item);
  }
  return out;
}

const quoteCatalog = {
  ...catalog,
  items: [...catalog.items.filter((item) => item.sku !== "JACKERY"), ...jackeryItems],
};

async function costsFromEnv(env) {
  return readPrivateCosts(env);
}

function withJackery(latest, prior, local) {
  const follow = resolveJackeryFollowup(latest, prior);
  if (follow?.action === "choose") {
    return {
      reply: follow.reply,
      quote: { items: [], offerForm: false, hold: false, stage: "choose" },
    };
  }
  const hit = resolveJackery(latest);
  if (!hit) return local;
  if (hit.action === "ask") {
    return {
      reply: hit.reply,
      quote: { items: [], offerForm: false, hold: false, stage: "clarify" },
    };
  }
  const offer = accessoryOffer(`${latest} ${hit.item.name}`);
  const ask = offer && !accessoryAsked(prior) ? `\n\n${offer.line}` : "";
  return {
    reply: `Okay, the ${hit.item.name}.${ask}`,
    quote: {
      items: [{ name: hit.item.name, sku: hit.item.sku, qty: 1, stockNote: hit.item.stockNote || "" }],
      offerForm: false,
      hold: true,
      stage: "quote",
    },
  };
}

function customerNamedTool(context) {
  const brand = customerBrand(context);
  const pretty = { dewalt: "DeWalt", makita: "Makita", milwaukee: "Milwaukee", bosch: "Bosch" }[brand] || "";
  const size = (context.match(/(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1);
  const sizeBit = size.length === 3 ? `${size[0]}-${size[1]}/${size[2]} in.` : "";
  if (/\b(?:circ(?:ular)?\s+saws?)\b/i.test(context)) {
    return [pretty, sizeBit, /\bcordless\b/i.test(context) ? "cordless" : "", "circular saw"].filter(Boolean).join(" ");
  }
  return "";
}

function linesFromQuote(rawQuote, prose = "", costs = {}, context = "") {
  const rawItems = Array.isArray(rawQuote?.items) ? rawQuote.items.slice(0, 8) : [];
  return rawItems.map((raw) => {
    if (raw?.lockName && !raw?.sku) {
      const qty = Number(raw.qty);
      return {
        name: String(raw.name || "Item").slice(0, 160),
        sku: "",
        model: "",
        manufacturer: "",
        qty: Number.isFinite(qty) && qty > 0 ? qty : null,
        estimate: null,
        estimateHigh: null,
        cost: null,
        firm: false,
        confirm: true,
        ballpark: false,
        fixedListed: false,
        manufacturerUrl: "",
        categoryPage: "",
        warrantyUrl: "",
        localPickup: null,
        asOf: null,
      };
    }
    const filled = fillMissingShelf(raw, quoteCatalog, prose);
    const name = String(filled?.name || filled?.sku || "Item").slice(0, 160);
    const exactHit = (quoteCatalog.items || []).find((item) => item.sku && filled?.sku && String(item.sku).toLowerCase() === String(filled.sku).toLowerCase());
    const exact = exactHit && !catalogConflict(exactHit, context) ? exactHit : null;
    const hits = exact ? [exact] : (filled?.lockName && !filled?.sku ? [] : matchCatalog(quoteCatalog, `${filled?.sku || ""} ${name}`, context));
    const known = (hits.find(hasFirmPrice) || hits[0]);
    const fixed = Boolean(known?.fixedPrice);
    let shelf = null;
    let shelfHigh = null;
    const takeRange = (low, high) => {
      const nums = [low, high].map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!nums.length) return;
      shelf = Math.min(...nums);
      const top = Math.max(...nums);
      shelfHigh = top > shelf ? top : null;
    };
    if (!fixed && filled?.shelf != null && Number(filled.shelf) > 0) shelf = Number(filled.shelf);
    else if (!fixed && (filled?.shelfLow != null || filled?.shelfHigh != null)) takeRange(filled.shelfLow, filled.shelfHigh);
    else if (!fixed && known?.shelfPrice != null && known.shelfPrice !== "") shelf = Number(known.shelfPrice);
    else if (!fixed && known && (known.shelfLow != null || known.shelfHigh != null)) takeRange(known.shelfLow, known.shelfHigh);
    const conflict = Boolean(exactHit && catalogConflict(exactHit, context)) || catalogConflict({ name, manufacturer: name, model: filled?.model }, context);
    const sku = conflict ? "" : (known?.sku || filled?.sku || "");
    const priced = priceFromShelf({
      shelf,
      shelfHigh,
      source: fixed ? "A" : (["A", "B", "C"].includes(String(filled?.source || "").toUpperCase()) ? String(filled.source).toUpperCase() : (shelf ? "A" : "U")),
      fixedPrice: fixed || Boolean(filled?.fixedPrice),
      listPrice: fixed ? known.price : (filled?.listPrice ?? null),
      privateCost: privateCostFor(sku, costs),
      mapPrice: Boolean(known?.mapPrice),
    });
    const qty = Number(filled?.qty);
    const displayName = known?.name || (catalogConflict({ name, manufacturer: name }, context) ? customerNamedTool(context) : (name && name !== "Item" ? name : "Item"));
    return {
      name: displayName,
      sku,
      model: known?.model || "",
      manufacturer: known?.manufacturer || "",
      qty: Number.isFinite(qty) && qty > 0 ? qty : null,
      ...priced,
      stockNote: known?.stockNote || filled?.stockNote || "",
      fixedListed: fixed || Boolean(filled?.fixedPrice),
      manufacturerUrl: conflict ? "" : (known?.manufacturerUrl || filled?.manufacturerUrl || ""),
      categoryPage: conflict ? "" : (known?.categoryPage || filled?.categoryPage || ""),
      warrantyUrl: filled?.warrantyUrl || warrantyFor(known?.name || name),
      localPickup: filled?.localPickup === true ? true : (filled?.localPickup === false ? false : null),
      asOf: known?.date || null,
    };
  }).filter((line) => line.name);
}

function pickupOf(lines) {
  if (lines.some((line) => line.localPickup === false)) return false;
  if (lines.some((line) => line.localPickup === true)) return true;
  return null;
}

function withSiblingLines(latest, prior, local) {
  const earlier = [...(prior || [])].reverse().find((entry) => entry.role === "user" && splitRequestedItems(entry.content).length >= 2);
  const current = local?.quote?.items || [];
  if (!earlier || current.length === 0) return local;
  const base = localReply({
    message: earlier.content,
    history: [],
    catalog: quoteCatalog,
    discount: rules.matchPercentBelow,
    rebuilding: true,
  });
  const priorItems = base.quote?.items || [];
  if (priorItems.length < 2) return local;
  const overlaps = current.some((item) => priorItems.some((old) => {
    const family = familyOf(old.name);
    return family && family === familyOf(item.name);
  }));
  if (!overlaps) return local;
  return {
    ...local,
    quote: {
      ...local.quote,
      items: preferSpecific([...priorItems, ...current]),
      bulk: Boolean(base.quote?.bulk || local.quote?.bulk),
      stage: local.quote?.stage === "script" || local.quote?.stage === "form" ? local.quote.stage : "quote",
    },
  };
}

function normalizedReply(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function replaceRepeatedReply(modelReply, drafted, priorMessages) {
  const previous = [...(priorMessages || [])].reverse().find((message) => message.role === "assistant")?.content || "";
  if (!previous || normalizedReply(modelReply) !== normalizedReply(previous)) return drafted;
  return confusedWhatReply(priorMessages);
}

function itemAmount(item) {
  if (item.estimate == null) return "";
  if (item.estimateHigh != null && item.estimateHigh !== item.estimate) {
    return `${formatMoney(item.estimate)} to ${formatMoney(item.estimateHigh)}`;
  }
  return formatMoney(item.estimate);
}

const BRAND = /\b(dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid|skil|flex|hercules|kobalt|stanley|klein|werner|stabila|jackery|porter|dap)\b/i;
const BRAND_WORDS = new Set(String(BRAND.source).match(/[a-z]+/g));
const MODEL = /\b[a-z]{0,6}\d{3,}[a-z0-9-]*\b/i;
const GENERIC = new Set([
  "jack", "hammer", "drill", "saw", "grinder", "nailer", "tool", "ladder", "glove",
  "battery", "blade", "bit", "wrench", "caulk", "case", "box", "pair", "demolition",
  "rotary", "sds", "corded", "cordless", "electric", "pneumatic", "power", "impact",
  "driver", "circular", "angle", "heat", "gun", "kit", "plus", "inch", "amp",
  "item", "product", "reciprocating", "sawzall", "sawzaw",
]);

function nameTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
    .filter((word) => word.length > 2);
}

function isPlaceholderName(name) {
  return /^(items?|tools?|products?)$/i.test(String(name || "").trim());
}

function specificItem(item) {
  const blob = `${item?.name || ""} ${item?.sku || ""} ${item?.model || ""} ${item?.manufacturer || ""}`;
  if (MODEL.test(blob)) return true;
  return nameTokens(blob).some((token) => !GENERIC.has(token) && !BRAND_WORDS.has(token));
}

function accessoryLine(item) {
  return /\b(blades?|bits?|anchors?|discs?|wheels?|nails?|batter(?:y|ies)|chargers?|stabilizers?|gloves?|caulk guns?)\b/i.test(item?.name || "");
}

function customerConfirmed(text) {
  const value = String(text || "");
  if (MODEL.test(value)) return true;
  const use = /\b(concrete|tile|asphalt|brick|masonry|wood|steel|metal|drywall)\b/i.test(value);
  const power = /\b(corded|cordless|pneumatic|electric)\b/i.test(value);
  return use && power;
}

function genericCategoryReply(items, text) {
  const blob = `${text || ""}\n${(items || []).map((item) => item?.name || "").join("\n")}`;
  if (/\bjack\s*hammers?\b|\bdemolition hammers?\b/i.test(text || "")) {
    return "We can source a jack hammer for you. What are you breaking up, and do you want electric corded, cordless, or pneumatic?";
  }
  const saw = genericSawQuestion(blob);
  if (saw) return saw;
  if (BRAND.test(blob) && !MODEL.test(blob)) return "Which model or size do you want?";
  return clarifyingQuestion(text || blob) || "I can quote that. Brand and model help, plus the quantity.";
}

function priceAnswer(text) {
  if (/\b(my cost|my price|how much|what would i pay|what(?:'s| is| does) it cost|pricing|do you have any pric)\b/i.test(String(text || ""))) {
    return "Yes, we can price that. ";
  }
  return "";
}

function modelCodeOf(item) {
  const match = `${item?.sku || ""} ${item?.name || ""} ${item?.model || ""}`.match(/\b[a-z]{0,6}\d{3,}[a-z0-9-]*\b/i);
  return match ? match[0] : "";
}

const BRAND_PRETTY = {
  dewalt: "DeWalt",
  milwaukee: "Milwaukee",
  makita: "Makita",
  bosch: "Bosch",
  ridgid: "Ridgid",
  hilti: "Hilti",
};

function pagesForLine(line, pages, waiting = []) {
  const code = modelCodeOf(line);
  const priced = (pages || []).filter((page) => Number(page?.shelf) > 0);
  if (code) return priced.filter((page) => pageMatchesModel(page, code));
  if (waiting.length === 1) return priced;
  return [];
}

function alignItemsToCustomerModels(items, latest) {
  const wanted = exactModelsIn(latest);
  if (!wanted.length) return items || [];
  return wanted.map((code) => {
    const hit = (items || []).find((item) => pageMatchesModel({
      title: `${item?.name || ""} ${item?.sku || ""}`,
      model: item?.model || "",
      sku: item?.sku || "",
    }, code));
    const brand = String(latest || "").match(/\b(dewalt|milwaukee|makita|bosch|ridgid|hilti)\b/i);
    const label = brand ? BRAND_PRETTY[brand[1].toLowerCase()] || brand[1] : "";
    const pretty = code.toUpperCase();
    if (hit) {
      // Keep the model the customer named. Never let a different sku ride along under it.
      const flat = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const want = flat(code);
      const next = { ...hit };
      if (next.sku && !flat(next.sku).includes(want)) {
        next.sku = pretty;
        next.manufacturerUrl = null;
        next.warrantyUrl = null;
      }
      if (!flat(next.name).includes(want)) next.name = label ? `${label} ${pretty}` : pretty;
      return next;
    }
    return {
      name: label ? `${label} ${pretty}` : pretty,
      sku: pretty,
      qty: 1,
      shelf: null,
      source: "U",
    };
  });
}

function applyLowestFetchedShelves(items, pages, cached = {}) {
  const list = (items || []).map((item) => ({ ...item }));
  for (const item of list) {
    const hits = pagesForLine(item, pages, list);
    const prices = hits.map((page) => Number(page.shelf)).filter((price) => price > 0);
    const saved = Number(cached[normalizeModel(modelCodeOf(item))]);
    if (saved > 0) prices.push(saved);
    if (!prices.length) continue;
    const fetched = Math.min(...prices);
    const current = Number(item.shelf);
    item.shelf = current > 0 ? Math.min(current, fetched) : fetched;
    if (item.shelf > 0 && (!item.source || String(item.source).toUpperCase() === "U")) item.source = "A";
  }
  return list;
}

function matchingPageCount(items, pages) {
  const urls = new Set();
  for (const item of items || []) {
    for (const page of pagesForLine(item, pages)) urls.add(page.url || `${page.title}:${page.shelf}`);
  }
  return urls.size;
}

function scriptOrderReply(baseReply, items, { government = false, bulk = false, text = "", latest = "" } = {}) {
  const asked = String(latest || text || "");
  const context = [text, latest].filter(Boolean).join("\n");
  const stillNeedsClarify = Boolean(clarifyingQuestion(context));
  const followUpTurn = Boolean(String(text || "").trim()) && String(text || "").trim() !== String(latest || "").trim();
  const protectModel = Boolean(String(baseReply || "").trim()) && (
    isConfusedOrFrustrated(latest) || followUpTurn
  );
  const categoryAsk = (lines, blob) => {
    const ask = genericCategoryReply(lines, blob || context);
    if (protectModel) return String(baseReply || "");
    if (stillNeedsClarify) return ask;
    return String(baseReply || "");
  };
  const lines = (items || []).filter((item) => item?.name && !isPlaceholderName(item.name));
  const sawAsk = genericSawQuestion(asked);
  if (!lines.length) {
    if (sawAsk) return sawAsk;
    const advice = concreteDrillingAdvice(asked);
    if (advice) return advice;
    if (/\b(jack\s*hammers?|demolition hammers?|drills?|saws?|grinders?|hammers?)\b/i.test(asked) || (BRAND.test(asked) && !MODEL.test(asked))) {
      return categoryAsk([], asked) || String(baseReply || "");
    }
    return String(baseReply || "");
  }
  const named = lines.filter((item) => specificItem(item));
  const vague = lines.filter((item) => !specificItem(item) && !accessoryLine(item));
  const confirmed = customerConfirmed(asked);
  const sawLine = (item) => /\b(sawzall|sawzaw|reciprocat)/i.test(`${item?.name || ""} ${item?.sku || ""}`);
  const onlySaws = lines.some(sawLine) && !lines.some((item) => specificItem(item) && !sawLine(item));
  if ((sawAsk || onlySaws) && !MODEL.test(asked) && !lines.some((item) => specificItem(item) && !sawLine(item))) {
    return sawAsk || "Which model do you want, or do you want it cordless or corded?";
  }
  if (!named.length && !confirmed && lines.every((item) => item.estimate == null)) {
    return categoryAsk(lines, context) || composeQuote(baseReply, lines, { government, bulk, asked });
  }
  const quoteLines = named.length ? lines.filter((item) => specificItem(item) || accessoryLine(item)) : lines;
  const vagueAsk = named.length && vague.length ? categoryAsk(vague, `${context}\n${vague.map((item) => item.name).join("\n")}`) : "";
  const core = composeQuote(baseReply, quoteLines, { government, bulk, asked });
  if (!vagueAsk || vagueAsk === core) return core;
  return `${vagueAsk}\n\n${core}`;
}

function composeQuote(baseReply, lines, { government = false, bulk = false, asked = "" } = {}) {
  const read = lines.map((item) => {
    const amount = itemAmount(item);
    const label = amount && item.ballpark ? `Starting estimate ${amount}` : amount;
    const stock = /pre-order|out of stock/i.test(item.stockNote || "") ? ` ${item.stockNote}` : "";
    return `${item.qty || 1} × ${item.name}${label ? `: ${label}` : ""}${stock}`;
  }).join(", ");
  const uncertain = lines.some((item) => item.confirm || item.estimate == null);
  const missingPrice = lines.every((item) => item.estimate == null);
  let low = 0;
  let high = 0;
  for (const item of lines) {
    if (item.estimate == null) continue;
    const qty = item.qty || 1;
    low += item.estimate * qty;
    high += (item.estimateHigh ?? item.estimate) * qty;
  }
  // v2 Section 13: tax stays on until the team verifies exemption documents.
  const factor = 1.07 * 1.03;
  const otdLow = roundMoney(low * factor);
  const otdHigh = roundMoney(high * factor);
  // v2 Section 16: hand off when any single item is $1,000 or more.
  const over = lines.some((item) => Number(item.estimateHigh ?? item.estimate) >= 1000);
  const upsell = String(baseReply || "").match(/(?:^|[.!?]\s+|\n+)(Need [^\n?]+\?)/)?.[1]?.trim() || "";
  const links = lines.map((item) => itemLinkLine(item)).filter(Boolean);
  const linkBlock = links.length ? `\n\n${links.join("\n")}` : "";
  const head = upsell ? `${upsell}\n\n` : "";
  if (missingPrice && !bulk && !(lines.some(specificItem) || customerConfirmed(asked))) {
    if (clarifyingQuestion(asked)) return genericCategoryReply(lines, asked);
  }
  const team = lines.length > 1 ? "Those are for our team to price." : "That one's for our team to price.";
  const teamShort = lines.length > 1 ? "Those are for our team to price." : "That's one for our team to price.";
  if (missingPrice && !bulk) {
    return `${head}${priceAnswer(asked)}I have ${read}. ${team} What's your name, company, and cell or email?${linkBlock}`;
  }
  if (uncertain || over || bulk) {
    const bulkNote = bulk ? ` ${BULK_LINE}` : "";
    return `${head}I have ${read}.${bulkNote} ${teamShort} ${HANDOFF_LINE} ${CLOSING_LINE}${linkBlock}`;
  }
  const total = otdHigh && otdHigh !== otdLow
    ? `${formatMoney(otdLow)} to ${formatMoney(otdHigh)}`
    : formatMoney(otdLow);
  return `${head}I have ${read}. Out the door that's ${total}. Would you like to place an order?${linkBlock}`;
}

function mergeNotes(reply, notes) {
  let text = String(reply || "").trim();
  for (const note of notes) {
    const key = note.slice(0, 28).toLowerCase();
    if (!text.toLowerCase().includes(key)) text = text ? `${text}\n\n${note}` : note;
  }
  return text;
}

function viewFor(lines, extra) {
  return presentQuote({
    lines,
    jobsite: extra.jobsite || "",
    text: extra.text || "",
    company: extra.company || "",
    taxExempt: Boolean(extra.taxExempt),
    owned: lines.length > 0 && lines.every((line) => line.fixedListed),
    localPickup: pickupOf(lines),
    now: extra.now || new Date(),
  });
}

function withoutRepeatedGreeting(reply, priorMessages) {
  const greeted = (priorMessages || []).some((message) => message.role === "assistant" && /hey, i'm george|welcome to yorktown tools/i.test(message.content || ""));
  if (!greeted) return String(reply || "");
  const stripped = String(reply || "")
    .replace(/Hey, I'm George\.\s*Welcome to Yorktown Tools!(?:\s*Are you putting together a tool order for an upcoming jobsite\?)?/gi, "")
    .replace(/Hey, I'm George\.\s*/gi, "")
    .replace(/Welcome to Yorktown Tools!\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped || "What do you need for the job?";
}

const CONTACT_ASK = /what'?s your name, company, and cell or email\??/i;

function withoutRepeatedContactAsk(reply, priorMessages) {
  const previous = [...(priorMessages || [])].reverse().find((message) => message.role === "assistant")?.content || "";
  if (!CONTACT_ASK.test(previous) || !CONTACT_ASK.test(String(reply || ""))) return String(reply || "");
  return String(reply || "")
    .replace(/what'?s your name, company, and cell or email\??/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fallbackAnswer(latest) {
  const advice = concreteDrillingAdvice(latest);
  if (advice) return advice;
  const saw = genericSawQuestion(latest);
  if (saw) return saw;
  if (isCustomerPriceAsk(latest) || /\b(price|pricing|cost|how much)\b/i.test(String(latest || ""))) {
    return "Yes, we can price that. Tell me the brand and model if I don't have it yet.";
  }
  if (/\b(what|how|which|can i|do you)\b/i.test(String(latest || ""))) {
    return "Yes, we can help with that. What tool or job is this for?";
  }
  return "What do you need for the job?";
}

function needsAnAnswer(text) {
  const raw = String(text || "");
  if (concreteDrillingAdvice(raw) || genericSawQuestion(raw) || isCustomerPriceAsk(raw)) return true;
  return /\?/.test(raw) || /\b(what|how|which|do you|can i|price|pricing|quote)\b/i.test(raw);
}

function finalizeReply(reply, priorMessages = [], latest = "") {
  const previous = [...(priorMessages || [])].reverse().find((message) => message.role === "assistant")?.content || "";
  let body = withoutRepeatedContactAsk(withoutRepeatedGreeting(reply, priorMessages), priorMessages);
  const onlyContact = !String(body || "").trim() || (CONTACT_ASK.test(body) && !String(body).replace(CONTACT_ASK, "").trim());
  if (onlyContact && (CONTACT_ASK.test(previous) || needsAnAnswer(latest))) {
    const next = fallbackAnswer(latest);
    if (!isConfusedOrFrustrated(latest) && !cannedWouldRepeat(next, priorMessages)) body = next;
  }
  return withoutRepeatedAfterHours(filterCustomerText(body).text, priorMessages);
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 40000) return { error: "too_large" };
  const text = await request.text();
  if (text.length > 40000) return { error: "too_large" };
  try {
    return { data: text ? JSON.parse(text) : {} };
  } catch {
    return { error: "bad_json" };
  }
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function validPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export async function handleRequest(request, env = {}, ctx) {
  try {
    return await routeRequest(request, env, ctx || env.ctx);
  } catch {
    return json({
      reply: "Something went wrong on my side. Tell me the tool again, or call or text (757) 940-5171.",
      quote: { items: [], offerForm: false },
      searchesUsed: 0,
      mode: "error",
    }, 200, request, env);
  }
}

async function routeRequest(request, env = {}, ctx) {
  if (env?.FORCE_HANDLER_ERROR) throw new Error("forced");
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      }),
    });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    const mock = env.MOCK_MODE === "true" || !env.XAI_API_KEY;
    return json({
      ok: true,
      service: "george",
      mode: mock ? "mock" : "live",
      matchPercentBelow: rules.matchPercentBelow,
    }, 200, request, env);
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {
    return chat(request, env, ctx);
  }
  if (url.pathname === "/api/quote" && request.method === "POST") {
    return quote(request, env);
  }
  return json({ error: "not_found" }, 404, request, env);
}

function handoffWhy(reply) {
  const reasons = [];
  if (/team to price/i.test(reply)) reasons.push("team to price");
  if (/bulk pricing/i.test(reply)) reasons.push("bulk");
  if (/consign/i.test(reply)) reasons.push("consignment");
  if (reply === SCAM_CLOSE || /only able to serve local/i.test(reply)) reasons.push("scam screen");
  if (/specialist will reach out/i.test(reply)) reasons.push("specialist handoff");
  return reasons.join(", ");
}

function isOwnerHandoff(reply) {
  return /for our team to price|specialist will reach out|only able to serve local customers/i.test(String(reply || ""));
}

function alertFingerprint(identity, items) {
  const list = (items || []).map((item) => `${item.qty || 1}|${item.name || ""}`).join(";");
  return [identity.name, identity.phone, identity.email, identity.note, list].join("~");
}

async function postHandoff(url, init) {
  try {
    const response = await fetch(url, init);
    return Boolean(response?.ok);
  } catch (error) {
    console.error(`handoff mail failed: ${error instanceof Error ? error.message : "error"}`);
    return false;
  }
}

async function sendOwnerMail(env, mail) {
  if (Array.isArray(env.handoffOutbox)) env.handoffOutbox.push({ subject: mail.subject, text: mail.text, html: mail.html });
  const mock = env.MOCK_MODE === "true";
  // Same RESEND_API_KEY, from address, and sales inbox as the quote-form mail.
  if (env.RESEND_API_KEY) {
    const from = env.FROM_EMAIL || "Yorktown Tools <quotes@quotes.yorktowntools.com>";
    const sales = env.SALES_EMAIL || SALES_EMAIL;
    const sent = await postHandoff("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [sales],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });
    if (sent) return true;
    console.error("handoff mail failed: resend");
  } else if (mock) {
    console.error("handoff mail skipped: RESEND_API_KEY is not set");
    return Boolean(env.handoffOutbox);
  } else {
    console.error("handoff mail: RESEND_API_KEY is not set, using formspree");
  }
  if (mock) return Boolean(env.handoffOutbox);
  const formspree = env.FORMSPREE_URL || "https://formspree.io/f/xanlvyan";
  const sent = await postHandoff(formspree, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(handoffFormspreeBody(mail)),
  });
  if (sent) console.log("handoff mail sent via formspree");
  else console.error("handoff mail failed: formspree");
  return sent;
}

async function maybeAlert(env, messages, reply, items, sessionKey) {
  const identity = readIdentity(messages);
  const canSend = identity.name && (identity.phone || identity.email || identity.knowsZach);
  const prior = handoffSent.get(sessionKey);
  if (!isOwnerHandoff(reply) && !prior) return { reply, alerted: false };
  if (!canSend) return { reply, alerted: false };
  const listed = (items || []).length ? items : cartFromThread(messages.slice(0, -1));
  let next = reply;
  if (isOwnerHandoff(reply)) {
    const close = readyClose(identity, askedForReach(messages.slice(0, -1)), listed);
    next = String(reply || "")
      .replace(/What's your name, company, and cell or email\??/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!/you're all set/i.test(next)) {
      next = next.replace(/A Yorktown Tools specialist will reach out shortly\.?\s*Tools Worth Fighting For!/gi, close).trim();
      if (!/you're all set/i.test(next)) next = `${next}\n\n${close}`.trim();
    } else if (listed.some((item) => item?.name && !next.includes(item.name))) {
      const read = listed.filter((item) => item?.name).map((item) => `${item.qty || 1} × ${item.name}`).join(", ");
      next = `I have ${read}.\n\n${next}`;
    }
  }
  const fingerprint = alertFingerprint(identity, listed);
  if ((isOwnerHandoff(reply) || prior) && prior !== fingerprint) {
    const mail = buildHandoffEmail({
      identity,
      items: listed,
      why: handoffWhy(reply) || "contact update",
      transcript: messages.map((message) => `${message.role}: ${message.content}`).slice(-8).join("\n"),
      update: Boolean(prior),
    });
    await sendOwnerMail(env, mail);
    handoffSent.set(sessionKey, fingerprint);
  }
  return { reply: next, alerted: canSend };
}

function followUpSearch(code) {
  return `Search again for the current shelf price of exact model ${code}. Check both Home Depot and Lowe's, and use a different retailer if the first results were only one store. Return product page URLs for ${code} only, and write the visible shelf price next to each URL as $123.45. Do not substitute a different model.`;
}

async function chat(request, env, ctx) {
  const ip = clientIp(request);
  const now = Date.now();
  const perHour = limit(`chat-h:${ip}`, num(env.RATE_LIMIT_CHAT_PER_HOUR, 20), 60 * 60 * 1000, now);
  const perDay = limit(`chat-d:${ip}`, num(env.RATE_LIMIT_CHAT_PER_DAY, 60), 24 * 60 * 60 * 1000, now);
  if (!perHour.ok || !perDay.ok) {
    return json({
      error: "rate_limited",
      reply: `I'm getting a lot of messages from this connection. Call or text (757) 940-5171, or use the quote form on the site. ${BULK_LINE}`,
    }, 429, request, env);
  }

  const body = await readJson(request);
  if (body.error) return json({ error: body.error }, 400, request, env);
  const page = safePage(body.data?.page);
  const percent = rules.matchPercentBelow;
  const messages = trimMessages(body.data?.messages, num(env.MAX_HISTORY_MESSAGES, 8));
  const userTurns = messages.filter((message) => message.role === "user");
  if (!userTurns.length) return json({ error: "empty" }, 400, request, env);
  if (userTurns.length > num(env.MAX_USER_TURNS, 12)) {
    return json({
      reply: `This chat is as long as I should keep it. Call or text (757) 940-5171 and we'll take it from here, or use the quote form on the site.`,
      quote: { items: [], offerForm: true },
      searchesUsed: 0,
      mode: "capped",
    }, 200, request, env);
  }

  const latest = userTurns[userTurns.length - 1].content;
  const sid = sessionId(body.data?.sessionId) || clientIp(request);
  const prior = messages.slice(0, -1);
  const respond = async (payload, status = 200) => {
    const meant = pendingModelConfirm(prior);
    if (meant && acceptsModel(latest) && !new RegExp(meant.code, "i").test(payload.reply || "")) {
      const items = (payload.quote?.items || []).filter((item) => new RegExp(meant.code, "i").test(`${item?.name || ""} ${item?.sku || ""}`));
      payload.reply = `I can price the ${meant.label} for you.`;
      payload.quote = { ...(payload.quote || {}), items };
    }
    const guided = sawGuide(prior, latest);
    if (guided && (/makita/i.test(payload.reply || "") || /what are you using it for|brand or model in mind/i.test(payload.reply || ""))) {
      payload.reply = guided;
      payload.quote = { ...(payload.quote || {}), items: [] };
    }
    if (customerBrand(userBlob(prior, latest)) === "dewalt") {
      const items = (payload.quote?.items || []).filter((item) => !/makita/i.test(`${item?.name || ""} ${item?.sku || ""}`));
      payload.quote = { ...(payload.quote || {}), items };
    }
    if (eachQty(latest)) {
      const cart = cartFromThread(prior, latest);
      if (cart.length) {
        payload.reply = listReadback(cart);
        payload.quote = { ...(payload.quote || {}), items: cart, hold: true };
      }
    }
    const alert = await maybeAlert(env, messages, payload.reply, payload.quote?.items || [], sid);
    payload.reply = alert.reply;
    return json(payload, status, request, env);
  };
  const convo = [...prior.filter((message) => message.role === "user").map((message) => message.content), latest].join("\n");
  const matches = matchCatalog(catalog, latest);
  const mock = env.MOCK_MODE === "true" || !env.XAI_API_KEY;
  const local = withSiblingLines(latest, prior, withJackery(latest, prior, localReply({ message: latest, history: prior, catalog: quoteCatalog, discount: percent, page })));
  const stage = local.quote?.stage || chatStage(latest, prior, catalog);
  const pricedLocally = (local.quote?.items || []).some((item) => item.name && !/^item$/i.test(item.name));
  const followUp = isShortReply(latest);
  const keepLocal = shouldKeepLocal({
    latest,
    prior,
    userTurns: userTurns.length,
    stage,
    scripted: Boolean(local.quote?.scripted),
    reply: local.reply,
  });
  if (keepLocal) {
    return respond({
      reply: finalizeReply(local.reply, messages, latest),
      quote: {
        items: stage === "form" || stage === "recommend" || (stage === "script" && (local.quote?.items || []).length) ? (local.quote?.items || []) : [],
        offerForm: Boolean(local.quote?.offerForm),
        hold: Boolean(local.quote?.hold),
        bulk: Boolean(local.quote?.bulk),
      },
      searchesUsed: 0,
      mode: mock ? "mock" : "live",
    });
  }
  const localHasPrice = (local.quote?.items || []).some((item) => {
    const estimate = Number(item?.estimate);
    const shelf = Number(item?.shelf);
    return (Number.isFinite(estimate) && estimate > 0) || (Number.isFinite(shelf) && shelf > 0);
  });
  const exactUnpriced = !mock && exactModelsIn(latest).length > 0 && !localHasPrice;
  if ((mock || pricedLocally || followUp) && !exactUnpriced) {
    const alreadyNamed = (local.quote?.items || []).length > 0 && (local.quote.items || []).every((item) => item.sku);
    const sourceItems = preferSpecific(followUp || alreadyNamed
      ? (local.quote?.items || [])
      : alignRequested(local.quote?.items || [], convo));
    const lines = linesFromQuote({ items: sourceItems }, convo, await costsFromEnv(env), convo);
    const view = viewFor(lines, { text: convo });
    const kept = (view.items.length ? view.items : local.quote.items).filter((item) => item?.name && !/^item$/i.test(item.name));
    const government = /\b(government|gpc|tax-exempt|tax exempt)\b/i.test(convo);
    const reply = kept.length
      ? finalizeReply(scriptOrderReply(local.reply, kept, { government, bulk: view.lead.bulk || Boolean(local.quote?.bulk), text: convo, latest }), messages, latest)
      : finalizeReply(local.reply, messages, latest);
    return respond({
      reply,
      quote: { items: kept, offerForm: false, hold: true, bulk: view.lead.bulk || Boolean(local.quote?.bulk) },
      searchesUsed: 0,
      mode: mock ? "mock" : "live",
    });
  }

  const searchCap = num(env.MAX_SEARCHES_PER_CHAT, 2);
  const dayCap = num(env.MAX_SEARCHES_PER_IP_DAY, 15);
  const canSearch = stage === "quote" && shouldSearch(latest, catalog)
    && underCap(`search-s:${sid}`, searchCap, 6 * 60 * 60 * 1000, now)
    && underCap(`search-ip:${ip}`, dayCap, 24 * 60 * 60 * 1000, now);
  if (canSearch) {
    take(`search-s:${sid}`, 1, 6 * 60 * 60 * 1000, now);
    take(`search-ip:${ip}`, 1, 24 * 60 * 60 * 1000, now);
  }

  const preload = {};
  for (const code of exactModelsIn(latest)) {
    const saved = await readModelShelf(env, code);
    if (saved > 0) preload[normalizeModel(code)] = saved;
  }

  try {
    const data = await (typeof env.callXai === "function" ? env.callXai : callXai)(
      env,
      buildInstructions({ catalog: quoteCatalog, discount: percent, page }),
      messages.map((message) => ({ role: message.role, content: message.content })),
      canSearch,
    );
    const parsed = splitModelOutput(outputText(data));
    let prose = [latest, parsed.reply, ...searchCards(data), ...collectDollarText(data)].join("\n");
    let rawItems = alignItemsToCustomerModels(alignRequested(parsed.quote?.items || [], latest), latest);
    const costs = await costsFromEnv(env);
    let lines = linesFromQuote({ items: rawItems }, prose, costs, convo);
    let extraSearches = 0;
    const namedModel = exactModelsIn(latest).length > 0 || rawItems.some((item) => modelCodeOf(item));
    if (namedModel && (lines.some((line) => specificItem(line) || customerConfirmed(latest)) || exactModelsIn(latest).length)) {
      try {
        const fetchImpl = typeof env.fetchProductPage === "function" ? env.fetchProductPage : fetch;
        const budgetMs = num(env.SHELF_FETCH_TIMEOUT_MS, 4000);
        const deadline = Date.now() + budgetMs;
        const askModel = typeof env.callXai === "function" ? env.callXai : callXai;
        const code = exactModelsIn(latest)[0] || "";
        let pages = collectSearchUrls(data, 4, code);
        const dollarBits = collectDollarText(data).concat(searchCards(data));
        console.log(`shelf search: model=${code || "none"} urls=${pages.map((page) => page.url).join(" | ") || "none"} dollarTexts=${dollarBits.length} sample=${(dollarBits[0] || outputText(data) || "").replace(/\s+/g, " ").slice(0, 220)}`);
        const matchedUrls = code ? pages.filter((page) => pageMatchesModel(page, code)) : pages;
        const already = canSearch ? Math.max(1, countSearches(data)) : 0;
        const firstSnippets = code ? collectSearchShelves(data, code) : [];
        const ipRoom = underCap(`search-ip:${ip}`, dayCap, 24 * 60 * 60 * 1000, now);
        // Home Depot and Lowe's product pages 403 from the Worker, so a named
        // model with no snippet price gets one follow-up even at the chat cap.
        const room = ipRoom && (already < searchCap
          || (firstSnippets.length === 0 && underCap(`search-s:${sid}`, searchCap + 1, 6 * 60 * 60 * 1000, now)));
        const firstFetch = pages.length
          ? fetchShelfPrices(pages, { fetchImpl, timeoutMs: budgetMs, deadline, perPageMs: 1500 })
          : Promise.resolve([]);
        let secondSearch = Promise.resolve(null);
        if (code && (matchedUrls.length < 2 || firstSnippets.length < 2) && room) {
          take(`search-s:${sid}`, 1, 6 * 60 * 60 * 1000, now);
          take(`search-ip:${ip}`, 1, 24 * 60 * 60 * 1000, now);
          extraSearches += 1;
          secondSearch = askModel(
            env,
            buildInstructions({ catalog: quoteCatalog, discount: percent, page }),
            [
              ...messages.map((message) => ({ role: message.role, content: message.content })),
              { role: "user", content: followUpSearch(code.toUpperCase()) },
            ],
            true,
          ).catch((error) => {
            console.error(`shelf search: follow-up failed: ${error instanceof Error ? error.message : "error"}`);
            return null;
          });
        }
        const [firstPages, extra] = await Promise.all([firstFetch, secondSearch]);
        let fetched = firstPages;
        if (extra) {
          const extraBits = collectDollarText(extra).concat(searchCards(extra));
          console.log(`shelf search follow-up: urls=${collectSearchUrls(extra, 4, code).map((page) => page.url).join(" | ") || "none"} dollarTexts=${extraBits.length} sample=${(extraBits[0] || outputText(extra) || "").replace(/\s+/g, " ").slice(0, 220)}`);
          const seen = new Set(pages.map((page) => page.url));
          const morePages = collectSearchUrls(extra, 4, code).filter((page) => page.url && !seen.has(page.url));
          if (morePages.length && Date.now() + 30 < deadline) {
            const more = await fetchShelfPrices(morePages, { fetchImpl, timeoutMs: budgetMs, deadline, perPageMs: 1500 });
            fetched = fetched.concat(more);
            pages = pages.concat(morePages);
          }
        } else if (code && matchingPageCount(rawItems, fetched) < 2 && extraSearches === 0 && room && Date.now() + 150 < deadline) {
          take(`search-s:${sid}`, 1, 6 * 60 * 60 * 1000, now);
          take(`search-ip:${ip}`, 1, 24 * 60 * 60 * 1000, now);
          extraSearches += 1;
          const follow = await askModel(
            env,
            buildInstructions({ catalog: quoteCatalog, discount: percent, page }),
            [
              ...messages.map((message) => ({ role: message.role, content: message.content })),
              { role: "user", content: followUpSearch(code.toUpperCase()) },
            ],
            true,
          );
          const seen = new Set(pages.map((page) => page.url));
          const morePages = collectSearchUrls(follow, 4, code).filter((page) => page.url && !seen.has(page.url));
          if (morePages.length && Date.now() + 30 < deadline) {
            const more = await fetchShelfPrices(morePages, { fetchImpl, timeoutMs: budgetMs, deadline, perPageMs: 1500 });
            fetched = fetched.concat(more);
          }
        }
        const snippets = (code ? firstSnippets.concat(extra ? collectSearchShelves(extra, code) : []) : []);
        if (snippets.length) fetched = fetched.concat(snippets);
        rawItems = applyLowestFetchedShelves(rawItems, fetched, preload);
        const wrote = [];
        for (const item of rawItems) {
          const itemCode = modelCodeOf(item);
          if (!itemCode) continue;
          const seen = pagesForLine(item, fetched).map((page) => Number(page.shelf)).filter((price) => price > 0);
          const quoted = Number(item.shelf);
          const saved = Number(preload[normalizeModel(itemCode)]) || 0;
          // Persist the lowest shelf we are actually quoting, including a
          // model- or snippet-supplied price when product-page fetches miss.
          const durable = lowestShelf(saved, seen.concat(quoted > 0 ? [quoted] : []));
          if (!(durable > 0) || (saved > 0 && durable > saved)) continue;
          const stored = await writeModelShelf(env, itemCode, durable, ctx);
          if (stored > 0) wrote.push(`${normalizeModel(itemCode).toUpperCase()}:${stored}`);
        }
        const fetchNotes = fetched.map((page) => {
          const host = (() => { try { return new URL(page.url).hostname.replace(/^www\./, ""); } catch { return "snippet"; } })();
          return `${host}${page.status ? ":" + page.status : ""}:${page.shelf || 0}`;
        });
        console.log(`shelf lookup: model=${code || "none"} pages=${pages.length} fetched=${fetchNotes.join(",") || "none"} snippets=${snippets.length} wrote=${wrote.join(",") || "none"} ctx=${ctx && typeof ctx.waitUntil === "function" ? "yes" : "no"}`);
        lines = linesFromQuote({ items: rawItems }, prose, costs, convo);
      } catch (error) {
        console.error(`shelf lookup failed: ${error instanceof Error ? error.message : "error"}`);
        rawItems = applyLowestFetchedShelves(rawItems, [], preload);
        lines = linesFromQuote({ items: rawItems }, prose, costs, convo);
      }
    }
    const view = viewFor(lines, { text: latest });
    const government = /\b(government|gpc|tax-exempt|tax exempt)\b/i.test(convo);
    const quotable = view.items.filter((item) => item?.name && !isPlaceholderName(item.name));
    const pricedReply = mergeNotes(replyWithFinalPrices(parsed.reply, quotable), view.notes);
    let ordered = view.items.length
      ? scriptOrderReply(pricedReply, quotable, { government, bulk: view.lead.bulk, text: convo, latest })
      : pricedReply;
    let quoteItems = quotable;
    const sawAsk = genericSawQuestion(latest);
    if (sawAsk && !/cordless or corded|which model/i.test(ordered)) {
      ordered = sawAsk;
      quoteItems = quoteItems.filter((item) => specificItem(item) && !/\b(sawzall|sawzaw|reciprocat)/i.test(`${item.name} ${item.sku}`));
    }
    const advice = concreteDrillingAdvice(latest);
    if (advice) {
      const modelText = String(parsed.reply || "");
      if (/sds-max/i.test(modelText) && /\brebar\b/i.test(modelText)) {
        ordered = modelText.replace(/\s*What'?s your name, company, and cell or email\??/gi, "").trim();
        if (!/\?/.test(ordered)) ordered = `${ordered} Do you already have an SDS-Max hammer?`;
      } else {
        ordered = advice;
      }
      quoteItems = [];
    }
    const finalized = finalizeReply(ordered, messages, latest);
    const reply = advice ? finalized : replaceRepeatedReply(parsed.reply, finalized, messages);
    const firstSearches = canSearch ? Math.max(1, countSearches(data)) : 0;
    if (canSearch && firstSearches > 1) {
      take(`search-s:${sid}`, firstSearches - 1, 6 * 60 * 60 * 1000, now);
      take(`search-ip:${ip}`, firstSearches - 1, 24 * 60 * 60 * 1000, now);
    }
    const searchesUsed = firstSearches + extraSearches;
    return respond({
      reply: reply || "",
      quote: {
        items: quoteItems,
        offerForm: false,
        hold: quoteItems.length > 0,
        bulk: view.lead.bulk,
      },
      searchesUsed,
      mode: "live",
    });
  } catch {
    const fallback = localReply({ message: latest, history: prior, catalog, discount: percent, page });
    const fallbackReply = (!isConfusedOrFrustrated(latest) && !cannedWouldRepeat(fallback.reply, prior) && fallback.reply)
      ? fallback.reply
      : "I'm having trouble answering that right now. Call or text (757) 940-5171 and we'll take it from here.";
    return json({ ...fallback, reply: fallbackReply, mode: "fallback", searchesUsed: 0 }, 200, request, env);
  }
}

function cleanLead(data) {
  const items = (Array.isArray(data.items) ? data.items : []).slice(0, 8).map((item) => ({
    name: String(item?.name || "").slice(0, 160),
    sku: String(item?.sku || "").slice(0, 80),
    qty: item?.qty,
    shelf: item?.shelf,
    shelfLow: item?.shelfLow,
    shelfHigh: item?.shelfHigh,
    source: item?.source,
    localPickup: item?.localPickup,
    manufacturerUrl: item?.manufacturerUrl,
    warrantyUrl: item?.warrantyUrl,
    categoryPage: item?.categoryPage,
  })).filter((item) => item.name);
  return {
    name: String(data.name || "").trim().slice(0, 120),
    company: String(data.company || "").trim().slice(0, 160),
    phone: String(data.phone || "").trim().slice(0, 40),
    email: String(data.email || "").trim().slice(0, 160),
    jobsite: String(data.jobsite || "").trim().slice(0, 240),
    neededBy: String(data.neededBy || "").trim().slice(0, 80),
    notes: String(data.notes || "").trim().slice(0, 800),
    taxExempt: data.taxExempt === true || data.taxExempt === "true" || data.taxExempt === "on",
    items,
  };
}

async function quote(request, env) {
  const ip = clientIp(request);
  const gate = limit(`quote:${ip}`, num(env.RATE_LIMIT_QUOTE_PER_DAY, 8), 24 * 60 * 60 * 1000, Date.now());
  if (!gate.ok) {
    return json({
      error: "rate_limited",
      message: "That's enough quote emails from this connection for today. Call or text (757) 940-5171.",
    }, 429, request, env);
  }
  const body = await readJson(request);
  if (body.error) return json({ error: body.error }, 400, request, env);
  const lead = cleanLead(body.data || {});
  const missing = [];
  if (!lead.name) missing.push("name");
  if (!validEmail(lead.email)) missing.push("email");
  if (!validPhone(lead.phone)) missing.push("phone");
  if (!lead.jobsite) missing.push("jobsite");
  if (!lead.neededBy) missing.push("neededBy");
  if (!lead.items.length || lead.items.some((item) => !item.qty || !item.name)) missing.push("quantity");
  if (missing.length) return json({ error: "missing", missing }, 400, request, env);

  const view = viewFor(linesFromQuote({ items: lead.items }, "", await costsFromEnv(env)), {
    text: `${lead.notes} ${lead.company}`,
    company: lead.company,
    jobsite: lead.jobsite,
    taxExempt: lead.taxExempt,
  });
  const customerMail = buildQuoteEmail({
    lead,
    items: view.items,
    totals: view.totals,
    leadInfo: view.lead,
    notes: view.notes.filter((note) => !note.startsWith("About how often")),
  });
  const salesMail = buildSalesEmail({ lead, items: view.items, leadInfo: view.lead, totals: view.totals });
  const leaked = filterCustomerText(`${customerMail.subject}\n${customerMail.text}\n${salesMail.text}`);
  if (leaked.costHit || leaked.retailerHit) {
    return json({ error: "blocked" }, 422, request, env);
  }

  const done = view.lead.bulk
    ? "We'll send your bulk pricing. Yorktown Tools has the details."
    : "A copy is on the way to your email, and Yorktown Tools has it too.";
  if (env.MOCK_MODE === "true") {
    return json({ ok: true, via: "mock", customerEmailed: false, message: "Preview only. Nothing was sent." }, 200, request, env);
  }

  let customerEmailed = false;
  if (env.RESEND_API_KEY) {
    const from = env.FROM_EMAIL || "Yorktown Tools <quotes@quotes.yorktowntools.com>";
    const sales = env.SALES_EMAIL || SALES_EMAIL;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [lead.email],
          reply_to: sales,
          subject: customerMail.subject,
          html: customerMail.html,
          text: customerMail.text,
        }),
      });
      customerEmailed = response.ok;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [sales],
          reply_to: lead.email,
          subject: salesMail.subject,
          html: salesMail.html,
          text: salesMail.text,
        }),
      });
    } catch {
      customerEmailed = false;
    }
  }

  if (!customerEmailed) {
    const formspree = env.FORMSPREE_URL || "https://formspree.io/f/xanlvyan";
    try {
      const response = await fetch(formspree, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(formspreeBody(lead, view.items, view.lead)),
      });
      if (!response.ok) return json({ error: "delivery_failed" }, 502, request, env);
      return json({
        ok: true,
        via: "formspree",
        customerEmailed: false,
        message: view.lead.bulk
          ? "We'll send your bulk pricing. Yorktown Tools has the details."
          : "Yorktown Tools has the quote. If a branded email is not set up yet, call or text (757) 940-5171. We still have your request.",
      }, 200, request, env);
    } catch {
      return json({ error: "delivery_failed" }, 502, request, env);
    }
  }

  return json({
    ok: true,
    via: "resend",
    customerEmailed: true,
    message: done,
  }, 200, request, env);
}

export { splitModelOutput, finalizeReply, catalog };
