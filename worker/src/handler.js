import catalog from "../../data/prices.json" with { type: "json" };
import { BULK_LINE, SALES_EMAIL } from "../../shared/copy.js";
import {
  ensureBulkLine,
  filterCustomerText,
  hasDollarAmount,
  publicQuoteItem,
} from "../../shared/customer-text.js";
import { localReply } from "../../shared/local-reply.js";
import {
  discountPercent,
  hasFirmPrice,
  matchCatalog,
  priceEntry,
  shouldSearch,
} from "../../shared/pricing.js";
import { buildQuoteEmail, formspreeBody } from "./email.js";
import { buildInstructions } from "./prompt.js";

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

function json(body, status, request, env, extra = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...extra,
  };
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
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
  return clean.slice(-max);
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

function applyCatalog(quote, percent) {
  const items = Array.isArray(quote?.items) ? quote.items.slice(0, 8) : [];
  return items.map((raw) => {
    const name = String(raw?.name || raw?.sku || "").slice(0, 160);
    const hits = matchCatalog(catalog, `${raw?.sku || ""} ${name}`);
    const firm = hits.find(hasFirmPrice);
    let priced;
    if (firm) {
      priced = priceEntry({ ...firm, qty: raw?.qty }, percent);
    } else if (raw?.shelfLow != null || raw?.shelfHigh != null) {
      const lows = [Number(raw.shelfLow), Number(raw.shelfHigh)].filter((n) => Number.isFinite(n) && n > 0);
      priced = priceEntry({
        name,
        sku: raw?.sku || "",
        manufacturerUrl: raw?.manufacturerUrl || "",
        categoryPage: raw?.categoryPage || "",
        shelfPrice: lows.length ? Math.min(...lows) : null,
        qty: raw?.qty,
        date: new Date().toISOString().slice(0, 10),
      }, percent);
      if (raw?.confidence === "unsure" || lows.length < 2) {
        priced.confidence = lows.length ? "range" : "unsure";
        priced.kind = lows.length ? "instant" : "unsure";
      } else {
        priced.confidence = "list";
        priced.kind = "instant";
      }
    } else if (hits[0]) {
      priced = priceEntry({ ...hits[0], qty: raw?.qty }, percent);
    } else {
      priced = priceEntry({
        name: name || "Item",
        sku: raw?.sku || "",
        manufacturerUrl: raw?.manufacturerUrl || "",
        categoryPage: raw?.categoryPage || "",
        qty: raw?.qty,
      }, percent);
    }
    const qty = Number(raw?.qty);
    priced.qty = Number.isFinite(qty) && qty > 0 ? qty : null;
    return publicQuoteItem(priced);
  }).filter(Boolean);
}

async function callXai(env, instructions, input, useSearch) {
  const model = env.XAI_MODEL || "grok-4.3";
  const full = {
    model,
    instructions,
    input,
    temperature: 0.3,
    max_output_tokens: num(env.MAX_OUTPUT_TOKENS, 650),
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

function finalizeReply(reply, items) {
  const filtered = filterCustomerText(reply);
  const hasPrice = items.some((item) => item.estimate != null) || hasDollarAmount(filtered.text);
  return ensureBulkLine(filtered.text, hasPrice);
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
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return json({ ok: true }, 204, request, env, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    const mock = env.MOCK_MODE === "true" || !env.XAI_API_KEY;
    return json({
      ok: true,
      service: "george",
      mode: mock ? "mock" : "live",
      discountPercent: discountPercent(env.PRICE_DISCOUNT_PERCENT, catalog.discountPercent ?? 1),
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
  const percent = discountPercent(env.PRICE_DISCOUNT_PERCENT, catalog.discountPercent ?? 1);
  const messages = trimMessages(body.data?.messages, num(env.MAX_HISTORY_MESSAGES, 8));
  const userTurns = messages.filter((message) => message.role === "user");
  if (!userTurns.length) return json({ error: "empty" }, 400, request, env);
  if (userTurns.length > num(env.MAX_USER_TURNS, 12)) {
    return json({
      reply: `This chat is as long as I should keep it. Call or text (757) 940-5171 and Zachary will take it from here, or send the quote form.`,
      quote: { items: [], offerForm: true },
      searchesUsed: 0,
      mode: "capped",
    }, 200, request, env);
  }

  const latest = userTurns[userTurns.length - 1].content;
  const matches = matchCatalog(catalog, latest);
  const mock = env.MOCK_MODE === "true" || !env.XAI_API_KEY;
  if (mock) {
    const local = localReply({ message: latest, catalog, discount: percent, page });
    return json({ ...local, searchesUsed: 0, mode: "mock" }, 200, request, env);
  }

  const sid = sessionId(body.data?.sessionId) || ip;
  const searchCap = num(env.MAX_SEARCHES_PER_CHAT, 2);
  const dayCap = num(env.MAX_SEARCHES_PER_IP_DAY, 15);
  const canSearch = shouldSearch(latest, matches)
    && underCap(`search-s:${sid}`, searchCap, 6 * 60 * 60 * 1000, now)
    && underCap(`search-ip:${ip}`, dayCap, 24 * 60 * 60 * 1000, now);
  if (canSearch) {
    take(`search-s:${sid}`, 1, 6 * 60 * 60 * 1000, now);
    take(`search-ip:${ip}`, 1, 24 * 60 * 60 * 1000, now);
  }

  try {
    const data = await callXai(
      env,
      buildInstructions({ catalog, discount: percent, page }),
      messages.map((message) => ({ role: message.role, content: message.content })),
      canSearch,
    );
    const parsed = splitModelOutput(outputText(data));
    const items = applyCatalog(parsed.quote || { items: [] }, percent);
    const reply = finalizeReply(parsed.reply, items);
    const searchesUsed = canSearch ? Math.max(1, countSearches(data)) : 0;
    if (canSearch && searchesUsed > 1) {
      take(`search-s:${sid}`, searchesUsed - 1, 6 * 60 * 60 * 1000, now);
      take(`search-ip:${ip}`, searchesUsed - 1, 24 * 60 * 60 * 1000, now);
    }
    return json({
      reply: reply || localReply({ message: latest, catalog, discount: percent, page }).reply,
      quote: {
        items,
        offerForm: Boolean(parsed.quote?.offerForm) || items.length > 0,
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
  const items = (Array.isArray(data.items) ? data.items : []).slice(0, 8).map((item) => publicQuoteItem({
    name: item?.name,
    sku: item?.sku,
    qty: item?.qty,
    estimate: item?.estimate,
    estimateHigh: item?.estimateHigh,
    confidence: item?.confidence,
    kind: item?.kind,
    manufacturerUrl: item?.manufacturerUrl,
    categoryPage: item?.categoryPage,
    asOf: item?.asOf,
  })).filter(Boolean);
  return {
    name: String(data.name || "").trim().slice(0, 120),
    company: String(data.company || "").trim().slice(0, 160),
    phone: String(data.phone || "").trim().slice(0, 40),
    email: String(data.email || "").trim().slice(0, 160),
    jobsite: String(data.jobsite || "").trim().slice(0, 240),
    neededBy: String(data.neededBy || "").trim().slice(0, 80),
    notes: String(data.notes || "").trim().slice(0, 800),
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
  if (!lead.company) missing.push("company");
  if (!validEmail(lead.email)) missing.push("email");
  if (!validPhone(lead.phone)) missing.push("phone");
  if (!lead.jobsite) missing.push("jobsite");
  if (!lead.neededBy) missing.push("neededBy");
  if (!lead.items.length || lead.items.some((item) => !item.qty || !item.name)) missing.push("quantity");
  if (missing.length) return json({ error: "missing", missing }, 400, request, env);

  const mail = buildQuoteEmail({ lead, items: lead.items });
  const leaked = filterCustomerText(`${mail.subject}\n${mail.text}`);
  if (leaked.costHit || leaked.retailerHit) {
    return json({ error: "blocked" }, 422, request, env);
  }

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
          bcc: [sales],
          reply_to: sales,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        }),
      });
      customerEmailed = response.ok;
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
        body: JSON.stringify(formspreeBody(lead, lead.items)),
      });
      if (!response.ok) return json({ error: "delivery_failed" }, 502, request, env);
      return json({
        ok: true,
        via: "formspree",
        customerEmailed: false,
        message: "Yorktown Tools has the quote. If a branded email is not set up yet, call or text (757) 940-5171. We still have your request.",
      }, 200, request, env);
    } catch {
      return json({ error: "delivery_failed" }, 502, request, env);
    }
  }

  return json({
    ok: true,
    via: "resend",
    customerEmailed: true,
    message: "A copy is on the way to your email, and Yorktown Tools has it too.",
  }, 200, request, env);
}

export { splitModelOutput, applyCatalog, finalizeReply, catalog };
