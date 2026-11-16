import { rules } from "../config/rules.js";
import { isAllowedCustomerUrl } from "../../shared/customer-text.js";
import { formatEstimate, formatMoney, paymentOnTop, roundMoney } from "../../shared/pricing.js";

const CONFIRM = "We'll confirm the price";
const BALLPARK = "Starting estimate, bulk pricing usually comes in better.";
const BULK_EMAIL = "We'll send your bulk pricing.";
const SAME_DAY = "This looks available for same-day delivery. We'll confirm before you count on a clock time.";
const SOURCED = "I can't get this one locally today, so it has to be sourced. I won't guess the lead time. We'll confirm it.";
const GLOVES = "We keep the Victory Series on hand. Same-day delivery is often possible if your size is here. We'll confirm before you count on it.";
const BULK_TIME = "For a bulk order, figure the next business day or one to two business days.";
const AFTER_HOURS = "It's outside business hours. We'll get back to you by 9 a.m. the next business day.";

const PLACES = [
  ["virginia beach", 36.8529, -75.978],
  ["newport news", 37.0871, -76.473],
  ["fort eustis", 37.159, -76.608],
  ["naval station", 36.946, -76.309],
  ["williamsburg", 37.2707, -76.7075],
  ["portsmouth", 36.8354, -76.2983],
  ["chesapeake", 36.7682, -76.2875],
  ["gloucester", 37.4099, -76.5258],
  ["yorktown", 37.2368, -76.5097],
  ["richmond", 37.5407, -77.436],
  ["hampton", 37.0299, -76.3452],
  ["norfolk", 36.8508, -76.2859],
  ["langley", 37.083, -76.36],
  ["oceana", 36.821, -76.033],
];

const ORIGIN = { lat: 37.2368, lng: -76.5097 };

export function haversineMiles(a, b) {
  const toRad = (n) => (n * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function roundTripMiles(jobsite) {
  const text = String(jobsite || "").toLowerCase();
  const hit = PLACES.find(([name]) => text.includes(name));
  if (!hit) return rules.defaultRoundTripMiles > 0 ? rules.defaultRoundTripMiles : null;
  const oneWay = haversineMiles(ORIGIN, { lat: hit[1], lng: hit[2] });
  return Math.max(2, oneWay * 2);
}

export function fuelDollars(miles) {
  if (!miles || miles <= 0) return 0;
  return roundMoney((miles / rules.mpg) * rules.gasPricePerGallon) || 0;
}

export function isCaseItem(name) {
  return /\b(case|cases|carton|cartons|caulk)\b/i.test(String(name || ""));
}

export function isBulkOrder(items, text = "") {
  if (/\b(bulk|pallet|pallets|truckload)\b/i.test(String(text || ""))) return true;
  return items.some((item) => {
    if (item.fixedPrice || item.fixedListed) return false;
    const qty = Number(item.qty) || 0;
    if (qty <= 0) return false;
    if (isCaseItem(item.name)) return qty >= rules.bulkCaseQty;
    return qty >= rules.bulkToolQty;
  });
}

export function looksOngoing(text) {
  return /\b(weekly|every week|each week|monthly|standing order|ongoing|regularly|all the time)\b/i.test(String(text || ""));
}

export function looksMultiSite(text) {
  return /\b(job\s*sites|several sites|multiple sites|a few sites|our sites|two sites|three sites)\b/i.test(String(text || ""));
}

export function looksHomeowner(text, company) {
  const blob = `${text} ${company}`;
  return /\b(homeowner|my house|at home|personal use|for myself|diy)\b/i.test(blob);
}

export function looksGovernment(text, taxExempt) {
  if (taxExempt) return true;
  return /\b(government|federal agency|city of|county of|tax-exempt|tax exempt|gsa|purchase card|gpc)\b/i.test(String(text || ""));
}

/**
 * Tier 1: a company plus bulk, ongoing need, or more than one job site.
 * Tier 2: any other business or government buyer.
 * Tier 3: homeowner or one-off.
 * A small order stays an instant quote even when the company is large.
 */
export function classifyLead({ company, text, items, taxExempt, jobsites }) {
  const bulk = isBulkOrder(items, text);
  const government = looksGovernment(`${text} ${company}`, taxExempt);
  const namedCompany = Boolean(String(company || "").trim()) && !looksHomeowner("", company);
  const ongoing = looksOngoing(text);
  const multi = looksMultiSite(text) || Number(jobsites) > 1;
  let tier = 3;
  if (namedCompany && (bulk || ongoing || multi)) tier = 1;
  else if (namedCompany || government) tier = 2;
  return {
    tier,
    bulk,
    priority: tier === 1 || bulk,
    instant: !bulk,
    askVolume: tier === 1,
  };
}

function channelOf(source) {
  const value = String(source || "A").toUpperCase();
  if (value === "B" || value === "OTHER-LOCAL") return "other";
  if (value === "C" || value === "A" || value === "BIG-BOX") return "chain";
  return "unknown";
}

function priceBound(shelf, channel) {
  if (channel === "other") {
    return {
      estimate: roundMoney(shelf * (1 + rules.otherLocalMarkupPercent / 100)),
      cost: null,
      confirm: false,
    };
  }
  const estimate = roundMoney(shelf * (1 - rules.matchPercentBelow / 100));
  const cost = roundMoney(shelf * (1 - rules.assumedCostBelowShelfPercent / 100));
  const margin = estimate > 0 ? (estimate - cost) / estimate : 0;
  if (margin + 1e-9 < rules.minGrossMargin) return { estimate: null, cost, confirm: true };
  return { estimate, cost, confirm: false };
}

function privateMarked(shelf, privateCost) {
  const cost = Number(privateCost);
  const shelfPrice = Number(shelf);
  if (!(cost > 0) || !(shelfPrice > 0) || cost > shelfPrice) return null;
  const marked = roundMoney(cost * rules.privateMarkup);
  if (marked == null || marked > shelfPrice) return null;
  const margin = (marked - cost) / marked;
  if (margin + 1e-9 < rules.minGrossMargin) return null;
  return marked;
}

function boundFor(shelf, channel, privateCost) {
  const marked = privateMarked(shelf, privateCost);
  if (marked != null) return { estimate: marked, cost: roundMoney(privateCost), confirm: false };
  return priceBound(shelf, channel);
}

export function priceFromShelf({ shelf, shelfHigh, source, fixedPrice, listPrice, privateCost, mapPrice }) {
  const shelfPrice = Number(shelf);
  if (mapPrice) {
    const map = roundMoney(shelfPrice);
    if (!map) {
      return { estimate: null, estimateHigh: null, cost: null, firm: false, confirm: true, ballpark: false, mapPrice: true, skipFuel: true };
    }
    const cost = Number(privateCost);
    if (cost > 0 && (map - cost) / map < rules.minGrossMargin) {
      return {
        estimate: null,
        estimateHigh: null,
        cost: roundMoney(cost),
        firm: false,
        confirm: true,
        ballpark: false,
        mapPrice: true,
        skipFuel: true,
        shelfCeiling: map,
      };
    }
    return {
      estimate: map,
      estimateHigh: null,
      cost: cost > 0 ? roundMoney(cost) : null,
      shelfCeiling: map,
      firm: true,
      confirm: false,
      ballpark: false,
      mapPrice: true,
      skipFuel: true,
    };
  }
  if (fixedPrice && listPrice != null) {
    return {
      estimate: roundMoney(listPrice),
      estimateHigh: null,
      cost: null,
      firm: true,
      confirm: false,
      ballpark: false,
    };
  }
  if (!Number.isFinite(shelfPrice) || shelfPrice <= 0) {
    return { estimate: null, estimateHigh: null, cost: null, firm: false, confirm: true, ballpark: false };
  }
  const channel = channelOf(source);
  if (channel === "unknown") {
    return { estimate: null, estimateHigh: null, cost: null, firm: false, confirm: true, ballpark: false };
  }
  const low = boundFor(shelfPrice, channel, privateCost);
  if (low.confirm || low.estimate == null) {
    return { estimate: null, estimateHigh: null, cost: low.cost, firm: false, confirm: true, ballpark: false };
  }
  const highShelf = Number(shelfHigh);
  let estimateHigh = null;
  if (Number.isFinite(highShelf) && highShelf > shelfPrice) {
    const high = boundFor(highShelf, channel, privateCost);
    if (high.confirm || high.estimate == null) {
      return { estimate: null, estimateHigh: null, cost: low.cost, firm: false, confirm: true, ballpark: false };
    }
    if (high.estimate > low.estimate) estimateHigh = high.estimate;
  }
  return {
    estimate: low.estimate,
    estimateHigh,
    cost: low.cost,
    shelfCeiling: roundMoney(shelfPrice),
    shelfHighCeiling: Number.isFinite(highShelf) && highShelf > shelfPrice ? roundMoney(highShelf) : null,
    firm: estimateHigh == null,
    confirm: false,
    ballpark: estimateHigh != null,
  };
}

function capToShelf(line) {
  if (!line) return;
  if (line.shelfCeiling != null && line.estimate != null && line.estimate > line.shelfCeiling) {
    line.estimate = line.shelfCeiling;
  }
  if (line.shelfHighCeiling != null && line.estimateHigh != null && line.estimateHigh > line.shelfHighCeiling) {
    line.estimateHigh = line.shelfHighCeiling;
  }
}

export function applyFuel(lines, miles) {
  const priced = lines.filter((line) => line.estimate != null && !line.confirm && !line.fixedListed && !line.skipFuel && !line.mapPrice);
  const marginDollars = priced.reduce((sum, line) => {
    if (line.cost == null) return sum;
    return sum + (line.estimate - line.cost) * (line.qty || 1);
  }, 0);
  const fuel = fuelDollars(miles);
  const trip = miles || 0;
  if (!(fuel > 0) || !(marginDollars > 0) || fuel <= rules.fuelShareOfMargin * marginDollars) {
    lines.forEach(capToShelf);
    return { lines, fuelAdded: 0, miles: trip };
  }
  const base = priced.reduce((sum, line) => sum + line.estimate * (line.qty || 1), 0);
  if (!(base > 0)) return { lines, fuelAdded: 0, miles: trip };
  let remaining = fuel;
  priced.forEach((line, index) => {
    const qty = line.qty || 1;
    const share = index === priced.length - 1
      ? remaining
      : roundMoney(fuel * ((line.estimate * qty) / base)) || 0;
    remaining = roundMoney(remaining - share) || 0;
    const each = share / qty;
    line.estimate = roundMoney(line.estimate + each);
    if (line.estimateHigh != null) line.estimateHigh = roundMoney(line.estimateHigh + each);
  });
  lines.forEach(capToShelf);
  return { lines, fuelAdded: fuel, miles: trip };
}

export function moneyTotals(lines, { taxExempt = false } = {}) {
  const subtotal = roundMoney(lines.reduce((sum, line) => {
    if (line.estimate == null || line.confirm) return sum;
    return sum + line.estimate * (line.qty || 1);
  }, 0)) || 0;
  const rate = taxExempt ? rules.exemptTaxRate : rules.salesTaxRate;
  const tax = roundMoney(subtotal * rate) || 0;
  const base = roundMoney(subtotal + tax) || 0;
  return {
    subtotal,
    tax,
    taxRate: rate,
    taxLabel: taxExempt ? "Tax exempt (certificate required)" : `Virginia sales tax ${Math.round(rate * 100)}%`,
    total: base,
    fees: [
      { method: "Card or government purchase card", rate: rules.cardFeeRate, amount: roundMoney(base * rules.cardFeeRate) || 0 },
      { method: "ACH", rate: rules.achFeeRate, amount: roundMoney(base * rules.achFeeRate) || 0 },
      { method: "Check", rate: rules.checkFeeRate, amount: 0 },
    ],
  };
}

export function zonedParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: rules.timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const grab = (type) => parts.find((part) => part.type === type)?.value || "";
  return { weekday: grab("weekday"), hour: Number(grab("hour")) };
}

export function withoutRepeatedAfterHours(reply, priorMessages = []) {
  const said = priorMessages.some((message) => message.role === "assistant" && /9 a\.m\./i.test(message.content || ""));
  if (!said) return String(reply || "");
  return String(reply || "").split(/\n+/).filter((line) => !/9 a\.m\./i.test(line)).join("\n").trim();
}

export function afterHoursNote(date = new Date()) {
  const { weekday, hour } = zonedParts(date);
  const openDay = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (openDay && hour >= rules.openHour && hour < rules.closeHour) return "";
  return AFTER_HOURS;
}

function gloveFees(item) {
  if (!item || item.estimate == null || item.estimateHigh != null) return null;
  const gloves = item.sku === "VICTORY-GLOVE" || (/victory/i.test(item.name || "") && /glove/i.test(item.name || ""));
  if (!gloves) return null;
  const fees = paymentOnTop(item.estimate, rules.cardFeeRate, rules.achFeeRate);
  return { price: formatMoney(item.estimate), card: formatMoney(fees.card), ach: formatMoney(fees.ach) };
}

export function leadTimeNote({ bulk, owned, localPickup }) {
  if (bulk) return BULK_TIME;
  if (owned) return GLOVES;
  if (localPickup === true) return SAME_DAY;
  if (localPickup === false) return SOURCED;
  return "";
}

function publicLine(line, bulk) {
  const locked = Boolean(line.fixedListed || line.mapPrice);
  const confirm = Boolean(line.confirm) || (bulk && !locked);
  return {
    name: line.name,
    sku: line.sku || "",
    qty: line.qty,
    estimate: confirm && bulk ? line.estimate : (line.confirm ? null : line.estimate),
    estimateHigh: confirm && !bulk ? null : (line.estimateHigh ?? null),
    firm: !confirm && line.firm,
    ballpark: bulk && line.estimate != null && !locked,
    confirm: line.confirm && !bulk,
    confidence: line.confirm ? "unsure" : (bulk ? "ballpark" : "list"),
    kind: locked ? "listed" : (bulk ? "ballpark" : "instant"),
    stockNote: line.stockNote || "",
    mapPrice: Boolean(line.mapPrice),
    model: line.model || "",
    manufacturer: line.manufacturer || "",
    manufacturerUrl: line.manufacturerUrl || "",
    categoryPage: line.categoryPage || "",
    warrantyUrl: line.warrantyUrl || "",
    asOf: line.asOf || null,
  };
}

export function presentQuote({
  lines,
  jobsite,
  text = "",
  company = "",
  taxExempt = false,
  owned = false,
  localPickup = null,
  now = new Date(),
}) {
  const lead = classifyLead({ company, text, items: lines, taxExempt, jobsite });
  let working = lines.map((line) => ({ ...line }));
  if (!lead.bulk) {
    const miles = roundTripMiles(jobsite);
    working = applyFuel(working, miles).lines;
  } else {
    const miles = (roundTripMiles(jobsite) || 0) + rules.bulkSourcingRoundTripMiles;
    working = applyFuel(working, miles).lines;
  }
  const items = working.map((line) => publicLine(line, lead.bulk));
  const totals = lead.bulk ? null : moneyTotals(working.filter((line) => !line.confirm), { taxExempt });
  const notes = [
    lead.bulk ? `${BALLPARK} ${BULK_EMAIL}` : "",
    lead.bulk ? "" : leadTimeNote({ bulk: false, owned, localPickup }),
    lead.askVolume ? "About how often do you order, and is this a typical size for you?" : "",
    taxExempt ? "Tax-exempt orders need a certificate. We'll follow up for that." : "",
  ].filter(Boolean);
  return {
    items,
    lead: { tier: lead.tier, bulk: lead.bulk, priority: lead.priority, instant: lead.instant },
    totals,
    notes,
    confirmLabel: CONFIRM,
    ballparkLabel: BALLPARK,
    bulkEmailLine: BULK_EMAIL,
  };
}

function dollarTokens(text) {
  return [...String(text || "").matchAll(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g)]
    .map((match) => match[0].replace(/\s/g, ""));
}

function brandLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (/dewalt\.com$/i.test(host)) return "DeWalt";
    if (/milwaukeetool\.com$/i.test(host)) return "Milwaukee";
    if (/makitatools\.com$/i.test(host) || /makita\.com$/i.test(host)) return "Makita";
    if (/bosch/i.test(host)) return "Bosch";
    if (/wernerco\.com$/i.test(host)) return "Werner";
    if (/jackery\.com$/i.test(host)) return "Jackery";
    return "Maker page";
  } catch {
    return "Maker page";
  }
}

function productLinkLabel(item, url) {
  const model = String(item?.model || "").trim();
  if (model) return model;
  const brand = item?.manufacturer && !/yorktown tools/i.test(item.manufacturer) ? item.manufacturer : brandLabel(url);
  const sku = String(item?.sku || "").trim();
  if (brand && sku && !brand.toLowerCase().includes(sku.toLowerCase())) return `${brand} ${sku}`;
  return brand || "Maker page";
}

function ownProduct(item) {
  return /yorktowntools\.com/i.test(item?.manufacturerUrl || "")
    || item?.sku === "VICTORY-GLOVE"
    || (/victory/i.test(item?.name || "") && /glove/i.test(item?.name || ""));
}

export function itemLinkLine(item) {
  const page = isAllowedCustomerUrl(item?.categoryPage) ? item.categoryPage : "";
  const maker = isAllowedCustomerUrl(item?.manufacturerUrl) ? item.manufacturerUrl : "";
  if (ownProduct(item)) {
    const url = page || maker;
    return url ? `[Our page](${url})` : "";
  }
  if (maker && !/yorktowntools\.com/i.test(maker)) return `[${productLinkLabel(item, maker)}](${maker})`;
  return page ? `[Our page](${page})` : "";
}

function nameTokens(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((token) => token.length >= 4 && !["series", "drivers", "cases", "case", "inch"].includes(token));
}

function restatesServerPrice(sentence, items) {
  if (/listed for a pair/i.test(sentence)) return true;
  if (/prepare a quote for you/i.test(sentence)) return true;
  const lower = sentence.toLowerCase();
  const glove = items.some((item) => gloveFees(item));
  if (glove && /a pair|\bcard\b|\bach\b|a check/.test(lower) && /\$|\d/.test(lower)) return true;
  const talksPrice = /\$|\bestimate\b|\blisted\b|\bprice\b|\bpricing\b/.test(lower);
  if (!talksPrice) return false;
  return items.some((item) => {
    const tokens = nameTokens(item.name);
    if (!tokens.length) return false;
    const hits = tokens.filter((token) => lower.includes(token));
    return hits.length >= Math.min(2, tokens.length);
  });
}

function withoutModelLinks(sentence) {
  const cleaned = sentence
    .replace(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (/^(our page|maker page)\s*[:.]?\s*$/i.test(cleaned)) return "";
  return cleaned;
}

export function itemPriceLine(item) {
  const name = String(item?.name || "").trim();
  if (!name || /^item$/i.test(name)) return "";
  const qty = item.qty ? `${item.qty} × ` : "";
  const fees = gloveFees(item);
  if (fees) {
    return `${qty}${name}: ${fees.price} a pair. Card about ${fees.card}. ACH about ${fees.ach}. No fee by check.`;
  }
  const amount = formatEstimate(item);
  if (item.ballpark && amount) {
    return `${qty}${name}: Starting estimate ${amount}.`;
  }
  const stock = /pre-order|out of stock/i.test(item.stockNote || "") ? ` ${item.stockNote}` : "";
  if (!amount || item.confirm) return `${qty}${name}.${stock}`.trim();
  return `${qty}${name}: ${amount}.${stock}`;
}

/** Chat text uses the same rounded figures as the quote form. Shelf dollars that differ are dropped. */
export function replyWithFinalPrices(modelReply, items) {
  const list = Array.isArray(items) ? items : [];
  const allowed = new Set();
  const itemLines = [];
  for (const item of list) {
    const line = itemPriceLine(item);
    if (line) itemLines.push(`- ${line}`);
    const fees = gloveFees(item);
    if (fees) {
      allowed.add(fees.price);
      allowed.add(fees.card);
      allowed.add(fees.ach);
    }
    if (item.estimate != null) allowed.add(formatMoney(item.estimate));
    if (item.estimateHigh != null) allowed.add(formatMoney(item.estimateHigh));
  }
  const seen = new Set(itemLines.map((line) => line.toLowerCase()));
  const explanation = [];
  const questions = [];
  for (const sentence of String(modelReply || "").split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)) {
    const trimmed = withoutModelLinks(sentence.trim());
    if (!trimmed || /^(our page|maker page|makita|dewalt|milwaukee)$/i.test(trimmed)) continue;
    if (/^-?\s*item\.?$/i.test(trimmed)) continue;
    if (/not a promise that it(?:'s| is) on the truck/i.test(trimmed)) continue;
    if (/that is a plan, not a promise/i.test(trimmed)) continue;
    if (/that(?:'s| is) an estimate/i.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    const amounts = dollarTokens(trimmed);
    if (amounts.length && itemLines.length) continue;
    if (amounts.length && amounts.some((amount) => !allowed.has(amount))) continue;
    if (restatesServerPrice(trimmed, list)) continue;
    if (list.some((item) => item.ballpark) && /bulk pricing usually comes in better|we['’]?ll send (your |the )?bulk pricing|zachary will send (your |the )?bulk pricing/i.test(trimmed)) continue;
    seen.add(key);
    if (/\?\s*$/.test(trimmed)) questions.push(trimmed);
    else explanation.push(trimmed);
  }
  const links = [];
  for (const item of list) {
    const link = itemLinkLine(item);
    if (link && !links.includes(link)) links.push(link);
  }
  const blocks = [];
  if (itemLines.length) blocks.push(itemLines.join("\n"));
  if (links.length) blocks.push(links.join("\n"));
  if (explanation.length) blocks.push(explanation.join(" "));
  if (questions.length) blocks.push(questions.join(" "));
  const anyPrice = list.some((item) => formatEstimate(item));
  if (!anyPrice && list.some((item) => !formatEstimate(item) || item.confirm)) blocks.push("We'll confirm the price.");
  return blocks.join("\n\n").trim();
}

export function feeSentence(totals) {
  if (!totals) return "Card, ACH, and check are all fine. The fee depends on how you pay. Net terms are only for approved customers.";
  const card = totals.fees[0];
  const ach = totals.fees[1];
  return `Pay by card or government purchase card (${Math.round(card.rate * 100)}%, ${formatMoney(card.amount)} on this total), ACH (${Math.round(ach.rate * 100)}%, ${formatMoney(ach.amount)}), or check (no fee). Net terms are only for approved customers.`;
}

export { CONFIRM, BALLPARK, BULK_EMAIL, rules };
