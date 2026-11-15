import {
  BULK_LINE,
  CATEGORIES,
  CONSIGNMENT_URL,
  CREDIT_APP_URL,
  ESTIMATE_NOTE,
  HOURS,
  PHONE_DISPLAY,
  SAFE_COST_REPLY,
  SERVICE_AREA,
} from "./copy.js";
import { filterCustomerText } from "./customer-text.js";
import {
  discountPercent,
  extractQty,
  formatEstimate,
  formatMoney,
  matchCatalog,
  paymentOnTop,
  priceEntry,
  splitRequestedItems,
} from "./pricing.js";

function pageLink(path, label) {
  return `[${label}](https://yorktowntools.com${path})`;
}

function ownProduct(priced) {
  return /yorktowntools\.com/i.test(priced.manufacturerUrl || "") || /yorktown tools/i.test(priced.manufacturer || "");
}

function itemLinks(priced) {
  if (ownProduct(priced)) {
    return priced.categoryPage ? ` [Our page](${priced.categoryPage}).` : "";
  }
  const brand = priced.manufacturer && !/yorktown tools/i.test(priced.manufacturer) ? priced.manufacturer : "Maker page";
  const maker = priced.manufacturerUrl ? ` Maker page: [${brand}](${priced.manufacturerUrl}).` : "";
  const ours = priced.categoryPage ? ` [Our page](${priced.categoryPage}).` : "";
  return `${maker}${ours}`;
}

function priceSentence(priced, qty) {
  const qtyBit = qty ? ` Quantity noted: ${qty}.` : " How many do you need?";
  const amount = formatEstimate(priced);
  if (priced.kind === "listed" && /victory/i.test(priced.name || "")) {
    const fees = paymentOnTop(priced.estimate);
    return `Victory Series gloves are ${amount} a pair.${qtyBit} Pay by card and the fee makes it about ${formatMoney(fees.card)} a pair. ACH is about ${formatMoney(fees.ach)}. A check stays ${amount}. ${ESTIMATE_NOTE}`;
  }
  if (priced.kind === "listed") {
    return `${priced.name} is listed at ${amount} on our site.${qtyBit} ${ESTIMATE_NOTE}`;
  }
  if (priced.kind === "range") {
    return `For ${priced.name} I would figure about ${amount}.${qtyBit} ${ESTIMATE_NOTE} Yorktown Tools will confirm it quickly.`;
  }
  if (priced.estimate != null) {
    return `For ${priced.name} my estimate is ${amount}.${qtyBit} ${ESTIMATE_NOTE}`;
  }
  return `I don't have a firm number on ${priced.name} yet. Tell me the model if you have it.${qtyBit} Zachary will confirm the price quickly. ${ESTIMATE_NOTE}`;
}

function toQuoteItem(priced, qty) {
  return {
    name: priced.name,
    sku: priced.sku,
    qty,
    estimate: priced.estimate,
    estimateHigh: priced.estimateHigh,
    confidence: priced.confidence,
    kind: priced.kind,
    manufacturerUrl: priced.manufacturerUrl,
    categoryPage: priced.categoryPage,
    asOf: priced.asOf,
  };
}

export function localReply({ message, catalog, discount, page }) {
  const text = String(message || "").trim();
  const percent = discountPercent(discount, catalog?.discountPercent ?? 1);
  const filteredUser = filterCustomerText(text);
  const requested = splitRequestedItems(text);
  const qty = requested.length === 1 ? requested[0].qty : extractQty(text);
  const matches = (requested.length
    ? requested.map((ask) => {
      const hit = matchCatalog(catalog, ask.query)[0];
      if (!hit) {
        return {
          name: ask.name,
          sku: "",
          qty: ask.qty,
          estimate: null,
          estimateHigh: null,
          confidence: "unsure",
          kind: "unsure",
          manufacturer: "",
          manufacturerUrl: "",
          categoryPage: "",
        };
      }
      return priceEntry({ ...hit, qty: ask.qty }, percent);
    })
    : matchCatalog(catalog, text).map((item) => priceEntry({ ...item, qty }, percent))
  );

  const finish = (reply, items, offerForm) => {
    const bulk = /\b(bulk|pallet|truckload)\b/i.test(text)
      || (qty >= 5 && /\b(saw|saws|drill|drills|tool|tools|ladder|ladders|impact|impacts)\b/i.test(text))
      || (qty >= 2 && /\b(case|cases|caulk)\b/i.test(text))
      || items.some((item) => item.kind !== "listed" && Number(item.qty) >= 5)
      || items.some((item) => /\b(case|cases|caulk)\b/i.test(item.name || "") && Number(item.qty) >= 2);
    const shaped = bulk
      ? items.map((item) => (item.kind === "listed" ? item : { ...item, kind: "ballpark", firm: false }))
      : items;
    const withBulk = bulk ? `${reply}\n\n${BULK_LINE}` : reply;
    const safe = filterCustomerText(withBulk);
    const body = safe.costHit ? SAFE_COST_REPLY : safe.text;
    return {
      reply: body,
      quote: { items: shaped, offerForm: Boolean(offerForm || shaped.length), bulk },
    };
  };

  if (!text) {
    return finish(
      "Hey, I'm George with Yorktown Tools. You build the project. We deliver the tools. What do you need on the job?",
      [],
      false,
    );
  }

  if (/ignore (all |any |the )?(previous|above|prior) instructions|system prompt|you are now|jailbreak|developer mode/i.test(text)) {
    return finish(
      "I only help with tools, quotes, and delivery for Yorktown Tools. What do you need on the job?",
      [],
      false,
    );
  }

  if (filteredUser.costHit || /\b(your cost|the margin|markup|military discount|supplier discount)\b/i.test(text)) {
    return { reply: SAFE_COST_REPLY, quote: { items: [], offerForm: true } };
  }

  if (/^(hi|hey|hello|yo|good morning|good afternoon)\b/i.test(text) && text.length < 40) {
    return finish(
      "Hey, I'm George with Yorktown Tools. You build the project. We deliver the tools. What do you need on the job?",
      [],
      false,
    );
  }

  if (/\b(hour|open|close|when are you)\b/i.test(text)) {
    return finish(
      `We're here ${HOURS}. Phone and text ${PHONE_DISPLAY}. Email sales@yorktowntools.com. After hours, Zachary will reply by 9 a.m. the next business day.`,
      [],
      false,
    );
  }

  if (/\b(deliver|delivery|service area|how far|richmond|virginia beach|hampton roads|jobsite|job site)\b/i.test(text) && !matches.length) {
    return finish(
      `Delivery to the job site, shop, or trailer is free from ${SERVICE_AREA}. No minimum. You stay on the job. We bring the tools.`,
      [],
      false,
    );
  }

  if (/\b(pay|payment|card|ach|check|net ?30|net ?15|credit|terms|invoice|po)\b/i.test(text)) {
    return finish(
      `Card, a government purchase card, ACH, and check are all fine. Card costs more to process than ACH, and a check has no fee. Don't send card or bank numbers in this chat. Net terms are only for approved customers. The credit application is here: [credit application](${CREDIT_APP_URL}). Sending it does not promise terms. Virginia sales tax is on the quote unless the order is tax-exempt, and a tax-exempt order needs a certificate.`,
      [],
      false,
    );
  }

  if (/\bconsign/i.test(text)) {
    return finish(
      `We can put a small stock on your site. You pay for what you use, and it costs nothing to start. Here's the one-pager: [consignment](${CONSIGNMENT_URL}).`,
      [],
      true,
    );
  }

  if (/\b(who are you|who is zach|about you|veteran|army|truck|cobalt|silverado)\b/i.test(text)) {
    let reply =
      "Yorktown Tools is Zachary Barber's company in Yorktown, Virginia. He's a veteran. Army aviation maintenance and leadership. The whole point is to keep your crew on the job site. Veteran-owned, and the money stays local. SAM.gov registered.";
    if (/\b(cobalt|silverado|truck)\b/i.test(text)) {
      reply += " He started deliveries in a Chevy Cobalt. The work truck now is a Silverado.";
    }
    return finish(reply, [], false);
  }

  if (/\b(gsa|government|sam\.gov|cage|uei)\b/i.test(text)) {
    return finish(
      "We're SAM.gov registered. UEI SMYXDLJDJMZ4. CAGE 16LD9. I can't promise a GSA schedule or special terms. Zachary handles government pricing and purchase orders directly. Call or text (757) 940-5171.",
      [],
      true,
    );
  }

  if (matches.length) {
    const lines = matches.map((priced) => {
      const lineQty = priced.qty || qty;
      const amount = formatEstimate(priced);
      if (priced.estimate == null) {
        return `${lineQty ? `${lineQty} × ` : ""}${priced.name}: Zachary will confirm the price.`;
      }
      if ((lineQty >= 5 && priced.kind !== "listed") || (lineQty >= 2 && /\bcase/i.test(priced.name || ""))) {
        return `${lineQty} × ${priced.name}: starting estimate ${amount}. Bulk pricing usually comes in better. ${ESTIMATE_NOTE}${itemLinks(priced)}`;
      }
      return `${priceSentence(priced, lineQty)}${itemLinks(priced)}`;
    });
    return finish(lines.join("\n\n"), matches.map((priced) => toQuoteItem(priced, priced.qty || qty)), true);
  }

  if (/\b(price|pricing|how much|quote|cost)\b/i.test(text)) {
    return finish(
      `Tell me the brand and model, and how many you need. I'll write the estimate. If I'm not sure of the number, I'll say so and Zachary will confirm it quickly. Free delivery from ${SERVICE_AREA}.`,
      [],
      true,
    );
  }

  if (/\b(drills?|saws?|ladders?|gloves?|batter(?:y|ies)|blades?|bits?|wrenches?|storage|packout|ppe|hard hats?|lasers?|levels?|jackery|power)\b/i.test(text)) {
    const hint = CATEGORIES.slice(0, 4)
      .map((cat) => pageLink(cat.path, cat.name))
      .join(", ");
    return finish(
      `I can quote that. Brand and model help, plus the quantity. A few places to look: ${hint}. Or just tell me what the crew is trying to do.`,
      [],
      true,
    );
  }

  if (page && /what.*(page|sell|categor)/i.test(text)) {
    const list = CATEGORIES.map((cat) => pageLink(cat.path, cat.name)).join(", ");
    return finish(`Here's how the site is split: ${list}.`, [], false);
  }

  return finish(
    "I stick to tools, quotes, and delivery for Yorktown Tools. Tell me what you need on the job, or call or text (757) 940-5171.",
    [],
    false,
  );
}

export { BULK_LINE };
