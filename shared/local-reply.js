import {
  AFTER_HOURS_LINE,
  BULK_LINE,
  CATEGORIES,
  CONSIGNMENT_URL,
  CREDIT_APP_URL,
  ESTIMATE_NOTE,
  GREETING,
  HOURS,
  PHONE_DISPLAY,
  QUOTE_OFFER,
  SAFE_COST_REPLY,
  SERVICE_AREA,
} from "./copy.js";
import { filterCustomerText } from "./customer-text.js";
import { acceptingQuote, chatStage, clarifyingQuestion, drillTurn } from "./talk.js";
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

function itemLink(priced) {
  if (ownProduct(priced)) {
    return priced.categoryPage ? `[Our page](${priced.categoryPage})` : "";
  }
  if (priced.manufacturerUrl && !/yorktowntools\.com/i.test(priced.manufacturerUrl)) {
    const label = priced.model
      || (priced.manufacturer && priced.sku ? `${priced.manufacturer} ${priced.sku}` : (priced.manufacturer || "Maker page"));
    return `[${label}](${priced.manufacturerUrl})`;
  }
  return priced.categoryPage ? `[Our page](${priced.categoryPage})` : "";
}

function toQuoteItem(priced, qty) {
  return {
    name: priced.name,
    sku: priced.sku,
    model: priced.model,
    manufacturer: priced.manufacturer,
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

function recommendCordedHammers(catalog, percent) {
  const wanted = ["DWE5010", "5378-20"];
  const picks = wanted
    .map((sku) => (catalog?.items || []).find((item) => item.sku === sku))
    .filter(Boolean)
    .map((item) => priceEntry(item, percent));
  const why = {
    DWE5010: "Corded, so it keeps going on a long day of anchors.",
    "5378-20": "A tougher housing when the bit stays in the hole.",
  };
  const lines = picks.map((priced) => {
    const amount = formatEstimate(priced);
    const link = itemLink(priced);
    return `${priced.model}. ${why[priced.sku] || "A solid corded hammer drill for concrete."} Starting estimate ${amount}. ${link}.`;
  });
  const reply = [
    "Okay, here are a couple of good options for concrete.",
    lines.join("\n\n"),
    QUOTE_OFFER,
  ].filter(Boolean).join("\n\n");
  return {
    reply,
    quote: {
      items: picks.map((priced) => toQuoteItem(priced, 1)),
      offerForm: false,
      hold: true,
      stage: "recommend",
      bulk: false,
    },
  };
}

export function localReply({ message, history = [], catalog, discount, page }) {
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
    const withBulk = bulk && items.length ? `${reply}\n\n${BULK_LINE}` : reply;
    const withOffer = items.length && !/quote together/i.test(withBulk) ? `${withBulk}\n\n${QUOTE_OFFER}` : withBulk;
    const safe = filterCustomerText(withOffer);
    const body = safe.costHit ? SAFE_COST_REPLY : safe.text;
    return {
      reply: body,
      quote: {
        items: shaped,
        offerForm: false,
        hold: shaped.length > 0,
        stage: shaped.length ? "quote" : "script",
        bulk,
      },
    };
  };

  if (!text) {
    return { reply: GREETING, quote: { items: [], offerForm: false, stage: "script" } };
  }

  if (acceptingQuote(text, history)) {
    const earlier = [...history].reverse().find((entry) => entry.role === "user");
    const again = earlier
      ? localReply({ message: earlier.content, history: history.filter((entry) => entry !== earlier), catalog, discount, page })
      : { quote: { items: [] } };
    return {
      reply: "Okay. Add your name and the job site and we'll send it.",
      quote: {
        items: again.quote?.items || [],
        offerForm: true,
        hold: false,
        stage: "form",
        bulk: Boolean(again.quote?.bulk),
      },
    };
  }

  const drill = drillTurn(text, history);
  if (drill?.stage === "clarify") {
    return { reply: drill.reply, quote: { items: [], offerForm: false, stage: "clarify" } };
  }
  if (drill?.stage === "recommend") return recommendCordedHammers(catalog, percent);

  const stage = chatStage(text, history, catalog);
  if (stage === "clarify") {
    return { reply: clarifyingQuestion(text, history), quote: { items: [], offerForm: false, stage: "clarify" } };
  }

  if (/ignore (all |any |the )?(previous|above|prior) instructions|system prompt|you are now|jailbreak|developer mode/i.test(text)) {
    return finish(
      "I only help with tools, quotes, and delivery for Yorktown Tools. What do you need on the job?",
      [],
      false,
    );
  }

  if (filteredUser.costHit || /\b(your cost|the margin|markup|military discount|supplier discount)\b/i.test(text)) {
    return { reply: SAFE_COST_REPLY, quote: { items: [], offerForm: false, stage: "script" } };
  }

  if (/^(hi|hey|hello|yo|good morning|good afternoon)\b/i.test(text) && text.length < 40) {
    return finish(
      GREETING,
      [],
      false,
    );
  }

  if (/\b(hour|open|close|when are you)\b/i.test(text)) {
    return finish(
      `We're here ${HOURS}. Phone and text ${PHONE_DISPLAY}. Email sales@yorktowntools.com. ${AFTER_HOURS_LINE}`,
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
      "Yorktown Tools is a veteran-owned company in Yorktown, Virginia. The founder spent 19-plus years in Army aviation. The whole point is to keep your crew on the job site, and the money stays local. SAM.gov registered.";
    if (/\b(cobalt|silverado|truck)\b/i.test(text)) {
      reply += " He started deliveries in a Chevy Cobalt. The work truck now is a Silverado.";
    }
    return finish(reply, [], false);
  }

  if (/\b(gsa|government|sam\.gov|cage|uei)\b/i.test(text)) {
    return finish(
      "We're SAM.gov registered. UEI SMYXDLJDJMZ4. CAGE 16LD9. I can't promise a GSA schedule or special terms. We handle government pricing and purchase orders directly. Call or text (757) 940-5171.",
      [],
      true,
    );
  }

  if (matches.length) {
    const lines = matches.map((priced) => {
      const lineQty = priced.qty || qty;
      const amount = formatEstimate(priced);
      const qtyBit = lineQty ? `${lineQty} × ` : "";
      if (priced.estimate == null) return `- ${qtyBit}${priced.name}.`;
      if (priced.kind === "listed" && /victory/i.test(priced.name || "")) {
        const fees = paymentOnTop(priced.estimate);
        return `- ${qtyBit}${priced.name}: ${amount} a pair. Card about ${formatMoney(fees.card)}. ACH about ${formatMoney(fees.ach)}. No fee by check.`;
      }
      if ((lineQty >= 5 && priced.kind !== "listed") || (lineQty >= 2 && /\bcase/i.test(priced.name || ""))) {
        return `- ${qtyBit}${priced.name}: Starting estimate ${amount}.`;
      }
      return `- ${qtyBit}${priced.name}: ${amount}.`;
    });
    const links = [];
    for (const priced of matches) {
      const link = itemLink(priced);
      if (link && !links.includes(link)) links.push(link);
    }
    const blocks = [lines.join("\n")];
    if (links.length) blocks.push(links.join("\n"));
    blocks.push(ESTIMATE_NOTE);
    return finish(blocks.join("\n\n"), matches.map((priced) => toQuoteItem(priced, priced.qty || qty)), true);
  }

  if (/\b(price|pricing|how much|quote|cost)\b/i.test(text)) {
    return finish(
      `Tell me the brand and model, and how many you need. I'll write the estimate. ${ESTIMATE_NOTE} Free delivery from ${SERVICE_AREA}.`,
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
