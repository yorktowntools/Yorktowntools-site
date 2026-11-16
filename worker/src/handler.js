import catalog from "../../data/prices.json" with { type: "json" };
import { accessoryAsked, accessoryOffer } from "../config/accessories.js";
import { jackeryItems, resolveJackery, resolveJackeryFollowup } from "../config/jackery.js";
import { BULK_LINE, CLOSING_LINE, HANDOFF_LINE, SALES_EMAIL } from "../../shared/copy.js";
import { filterCustomerText } from "../../shared/customer-text.js";
import { confusedWhatReply, localReply } from "../../shared/local-reply.js";
import { chatStage, clarifyingQuestion, isShortReply } from "../../shared/talk.js";
import {
  fillMissingShelf,
  formatMoney,
  hasFirmPrice,
  matchCatalog,
  roundMoney,
  shouldSearch,
  splitRequestedItems,
} from "../../shared/pricing.js";
import { buildQuoteEmail, buildSalesEmail, formspreeBody } from "./email.js";
import { buildInstructions } from "./prompt.js";
import { privateCostFor, readPrivateCosts } from "../config/private-costs.js";
import { itemLinkLine, presentQuote, priceFromShelf, replyWithFinalPrices, rules, withoutRepeatedAfterHours } from "./policy.js";

const buckets = new Map();

export function resetLimits() {
  buckets.clear();
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

function linesFromQuote(rawQuote, prose = "", costs = {}) {
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
    const exact = (quoteCatalog.items || []).find((item) => item.sku && filled?.sku && String(item.sku).toLowerCase() === String(filled.sku).toLowerCase());
    const hits = exact ? [exact] : (filled?.lockName && !filled?.sku ? [] : matchCatalog(quoteCatalog, `${filled?.sku || ""} ${name}`));
    const known = hits.find(hasFirmPrice) || hits[0];
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
    const sku = known?.sku || filled?.sku || "";
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
    const displayName = known?.name || (name && name !== "Item" ? name : "Item");
    return {
      name: displayName,
      sku,
      model: known?.model || "",
      manufacturer: known?.manufacturer || "",
      qty: Number.isFinite(qty) && qty > 0 ? qty : null,
      ...priced,
      stockNote: known?.stockNote || filled?.stockNote || "",
      fixedListed: fixed || Boolean(filled?.fixedPrice),
      manufacturerUrl: known?.manufacturerUrl || filled?.manufacturerUrl || "",
      categoryPage: known?.categoryPage || filled?.categoryPage || "",
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
  "item", "product",
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
  if (BRAND.test(blob) && !MODEL.test(blob)) return "Which model or size do you want?";
  return clarifyingQuestion(text || blob);
}

function scriptOrderReply(baseReply, items, { government = false, bulk = false, text = "" } = {}) {
  const lines = (items || []).filter((item) => item?.name && !isPlaceholderName(item.name));
  if (!lines.length) {
    if (/\b(jack\s*hammers?|demolition hammers?|drills?|saws?|grinders?|hammers?)\b/i.test(text || "") || (BRAND.test(text || "") && !MODEL.test(text || ""))) {
      return genericCategoryReply([], text);
    }
    return String(baseReply || "");
  }
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
  const factor = (government ? 1 : 1.07) * 1.03;
  const otdLow = roundMoney(low * factor);
  const otdHigh = roundMoney(high * factor);
  const over = (otdHigh || otdLow || 0) > 500;
  const upsell = String(baseReply || "").match(/(?:^|[.!?]\s+|\n+)(Need [^\n?]+\?)/)?.[1]?.trim() || "";
  const links = lines.map((item) => itemLinkLine(item)).filter(Boolean);
  const linkBlock = links.length ? `\n\n${links.join("\n")}` : "";
  const head = upsell ? `${upsell}\n\n` : "";
  if (missingPrice && !bulk && !(lines.some(specificItem) || customerConfirmed(text))) {
    return genericCategoryReply(lines, text);
  }
  if (missingPrice && !bulk) {
    return `${head}I have ${read}. That one's for our team to price. What's your name, company, and cell or email?${linkBlock}`;
  }
  if (uncertain || over || bulk) {
    const bulkNote = bulk ? ` ${BULK_LINE}` : "";
    return `${head}I have ${read}.${bulkNote} That's one for our team to price. ${HANDOFF_LINE} ${CLOSING_LINE}${linkBlock}`;
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

function finalizeReply(reply, priorMessages = []) {
  return withoutRepeatedAfterHours(filterCustomerText(withoutRepeatedGreeting(reply, priorMessages)).text, priorMessages);
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

export async function handleRequest(request, env = {}) {
  try {
    return await routeRequest(request, env);
  } catch {
    return json({
      reply: "Something went wrong on my side. Tell me the tool again, or call or text (757) 940-5171.",
      quote: { items: [], offerForm: false },
      searchesUsed: 0,
      mode: "error",
    }, 200, request, env);
  }
}

async function routeRequest(request, env = {}) {
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
    return chat(request, env);
  }
  if (url.pathname === "/api/quote" && request.method === "POST") {
    return quote(request, env);
  }
  return json({ error: "not_found" }, 404, request, env);
}

async function chat(request, env) {
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
  const prior = messages.slice(0, -1);
  const convo = [...prior.filter((message) => message.role === "user").map((message) => message.content), latest].join("\n");
  const matches = matchCatalog(catalog, latest);
  const mock = env.MOCK_MODE === "true" || !env.XAI_API_KEY;
  const local = withSiblingLines(latest, prior, withJackery(latest, prior, localReply({ message: latest, history: prior, catalog: quoteCatalog, discount: percent, page })));
  const stage = local.quote?.stage || chatStage(latest, prior, catalog);
  const pricedLocally = (local.quote?.items || []).some((item) => item.name && !/^item$/i.test(item.name));
  const followUp = isShortReply(latest);
  const keepLocal = Boolean(local.quote?.scripted)
    || stage === "form"
    || ((stage !== "quote" && stage !== "script") && !(followUp && pricedLocally));
  if (keepLocal) {
    return json({
      reply: finalizeReply(local.reply, messages),
      quote: {
        items: stage === "form" || stage === "recommend" || (stage === "script" && (local.quote?.items || []).length) ? (local.quote?.items || []) : [],
        offerForm: Boolean(local.quote?.offerForm),
        hold: Boolean(local.quote?.hold),
        bulk: Boolean(local.quote?.bulk),
      },
      searchesUsed: 0,
      mode: mock ? "mock" : "live",
    }, 200, request, env);
  }
  if (mock || pricedLocally || followUp) {
    const alreadyNamed = (local.quote?.items || []).length > 0 && (local.quote.items || []).every((item) => item.sku);
    const sourceItems = preferSpecific(followUp || alreadyNamed
      ? (local.quote?.items || [])
      : alignRequested(local.quote?.items || [], convo));
    const lines = linesFromQuote({ items: sourceItems }, convo, await costsFromEnv(env));
    const view = viewFor(lines, { text: convo });
    const kept = (view.items.length ? view.items : local.quote.items).filter((item) => item?.name && !/^item$/i.test(item.name));
    const government = /\b(government|gpc|tax-exempt|tax exempt)\b/i.test(convo);
    const reply = kept.length
      ? finalizeReply(scriptOrderReply(local.reply, kept, { government, bulk: view.lead.bulk || Boolean(local.quote?.bulk), text: convo }), messages)
      : finalizeReply(local.reply, messages);
    return json({
      reply,
      quote: { items: kept, offerForm: false, hold: true, bulk: view.lead.bulk || Boolean(local.quote?.bulk) },
      searchesUsed: 0,
      mode: mock ? "mock" : "live",
    }, 200, request, env);
  }

  const sid = sessionId(body.data?.sessionId) || ip;
  const searchCap = num(env.MAX_SEARCHES_PER_CHAT, 2);
  const dayCap = num(env.MAX_SEARCHES_PER_IP_DAY, 15);
  const canSearch = stage === "quote" && shouldSearch(latest, catalog)
    && underCap(`search-s:${sid}`, searchCap, 6 * 60 * 60 * 1000, now)
    && underCap(`search-ip:${ip}`, dayCap, 24 * 60 * 60 * 1000, now);
  if (canSearch) {
    take(`search-s:${sid}`, 1, 6 * 60 * 60 * 1000, now);
    take(`search-ip:${ip}`, 1, 24 * 60 * 60 * 1000, now);
  }

  try {
    const data = await (typeof env.callXai === "function" ? env.callXai : callXai)(
      env,
      buildInstructions({ catalog: quoteCatalog, discount: percent, page }),
      messages.map((message) => ({ role: message.role, content: message.content })),
      canSearch,
    );
    const parsed = splitModelOutput(outputText(data));
    const prose = [latest, parsed.reply, ...searchCards(data), ...collectDollarText(data)].join("\n");
    const lines = linesFromQuote({ items: alignRequested(parsed.quote?.items || [], latest) }, prose, await costsFromEnv(env));
    const view = viewFor(lines, { text: latest });
    const government = /\b(government|gpc|tax-exempt|tax exempt)\b/i.test(convo);
    const quotable = view.items.filter((item) => item?.name && !isPlaceholderName(item.name));
    const pricedReply = mergeNotes(replyWithFinalPrices(parsed.reply, quotable), view.notes);
    const ordered = view.items.length
      ? scriptOrderReply(pricedReply, quotable, { government, bulk: view.lead.bulk, text: convo })
      : pricedReply;
    const reply = replaceRepeatedReply(parsed.reply, finalizeReply(ordered, messages), messages);
    const searchesUsed = canSearch ? Math.max(1, countSearches(data)) : 0;
    if (canSearch && searchesUsed > 1) {
      take(`search-s:${sid}`, searchesUsed - 1, 6 * 60 * 60 * 1000, now);
      take(`search-ip:${ip}`, searchesUsed - 1, 24 * 60 * 60 * 1000, now);
    }
    return json({
      reply: reply || localReply({ message: latest, catalog, discount: percent, page }).reply,
      quote: {
        items: quotable,
        offerForm: false,
        hold: quotable.length > 0,
        bulk: view.lead.bulk,
      },
      searchesUsed,
      mode: "live",
    }, 200, request, env);
  } catch {
    const local = localReply({ message: latest, catalog, discount: percent, page });
    return json({ ...local, mode: "fallback", searchesUsed: 0 }, 200, request, env);
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
