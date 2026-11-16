import {
  AFTER_HOURS_LINE,
  BULK_LINE,
  CATEGORIES,
  CLOSING_LINE,
  CONSIGNMENT_URL,
  CREDIT_APP_URL,
  DELIVERY_LINE,
  GREETING,
  HANDOFF_LINE,
  LINE_CARD_URL,
  SCAM_CLOSE,
  HOURS,
  PHONE_DISPLAY,
  QUOTE_OFFER,
  SAFE_COST_REPLY,
  SERVICE_AREA,
} from "./copy.js";
import { filterCustomerText } from "./customer-text.js";
import { acceptingQuote, chatStage, clarifyingQuestion, drillTurn, isShortReply } from "./talk.js";
import { accessoryAsked, accessoryOffer, isAccessoryQuestion } from "../worker/config/accessories.js";
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
    "Which one do you want, the DeWalt DWE5010 or the Milwaukee 5378-20?",
  ].filter(Boolean).join("\n\n");
  return {
    reply,
    quote: {
      items: [],
      offerForm: false,
      hold: false,
      stage: "choose",
      bulk: false,
    },
  };
}

function substantiveUsers(history) {
  return (history || []).filter((entry) => entry.role === "user" && !isShortReply(entry.content));
}

function accessoryLine(addition, catalog, discount) {
  const known = addition.sku ? (catalog?.items || []).find((entry) => entry.sku === addition.sku) : null;
  const priced = known ? priceEntry({ ...known, qty: addition.qty }, discountPercent(discount, catalog?.discountPercent ?? 0)) : null;
  return priced
    ? toQuoteItem(priced, addition.qty)
    : { name: addition.name, sku: addition.sku || "", qty: addition.qty, estimate: null, estimateHigh: null, confidence: "unsure", kind: "unsure", lockName: true };
}

function carryQuote(text, history, catalog, discount, page) {
  const users = (history || []).filter((entry) => entry.role === "user");
  const subject = [...users].reverse().find((entry) => !isShortReply(entry.content) && !addedAccessory(entry.content))?.content || "";
  if (!subject) return null;
  const base = localReply({ message: subject, history, catalog, discount, page, rebuilding: true });
  if (!base.quote?.items?.length) return null;
  const qty = addedAccessory(text) ? null : (extractQty(text) || extractQty(subject));
  const tools = base.quote.items.filter((item) => !item.lockName);
  let items = qty && tools.length === 1
    ? base.quote.items.map((item) => (item.lockName ? item : { ...item, qty }))
    : base.quote.items.slice();
  for (const entry of users) {
    const addition = addedAccessory(entry.content);
    if (!addition) continue;
    items = items.filter((item) => item.name !== addition.name);
    items.push(accessoryLine(addition, catalog, discount));
  }
  let asked = false;
  let accepted = false;
  for (const entry of history || []) {
    if (entry.role === "assistant" && isAccessoryQuestion(entry.content)) asked = true;
    if (asked && entry.role === "user" && /^(yes|yeah|yep|sure|ok|okay)\b/i.test(String(entry.content || "").trim()) && !addedAccessory(entry.content)) accepted = true;
  }
  if (accepted) {
    const offer = accessoryOffer(`${subject}\n${items.map((item) => item.name).join(" ")}`);
    for (const suggestion of offer?.suggestions || []) {
      if (items.some((item) => item.name === suggestion.name)) continue;
      items.push(accessoryLine(suggestion, catalog, discount));
    }
  }
  return { ...base, quote: { ...base.quote, items, stage: base.quote.stage || "quote" } };
}

function pickedModel(text, history) {
  const asked = (history || []).some((entry) => entry.role === "assistant" && /which one do you want/i.test(entry.content || ""));
  if (!asked) return null;
  if (/dewalt|dwe5010/i.test(text)) return "DWE5010";
  if (/milwaukee|5378/i.test(text)) return "5378-20";
  return null;
}

function addedAccessory(text) {
  const raw = String(text || "");
  if (!/\b(add|throw in|include)\b/i.test(raw)) return null;
  let name = "";
  if (/\bblades?\b/i.test(raw)) name = "Circular saw blades";
  else if (/\banchors?\b/i.test(raw)) name = "Concrete anchors";
  else if (/\bbits?\b/i.test(raw)) name = "Driver bits";
  else if (/\b(discs?|wheels?)\b/i.test(raw)) name = "Grinding discs";
  else if (/\bnails?\b/i.test(raw)) name = "Nails";
  else if (/\bcaulk gun\b/i.test(raw)) name = "Caulk gun";
  else if (/\bbatter/i.test(raw)) name = "Extra battery";
  else if (/\bcharg/i.test(raw)) name = "Charger";
  else if (/\bstabilizer\b/i.test(raw)) name = "Ladder stabilizer";
  else if (/\bgloves?\b/i.test(raw)) name = "Victory Series drivers gloves";
  else return null;
  const qty = /\b(a couple|couple of|two|2)\b/i.test(raw) ? 2 : (extractQty(raw) || 1);
  return { name, qty, sku: /victory/i.test(name) ? "VICTORY-GLOVE" : "" };
}

export function localReply({ message, history = [], catalog, discount, page, rebuilding = false }) {
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
    const offer = accessoryOffer(`${text}\n${items.map((item) => item.name).join(" ")}`);
    const askAccessories = items.length && offer && !accessoryAsked(history);
    const withOffer = askAccessories
      ? `${withBulk}\n\n${offer.line}`
      : (items.length && !/quote together/i.test(withBulk) ? `${withBulk}\n\n${QUOTE_OFFER}` : withBulk);
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

  const picked = pickedModel(text, history);
  if (picked) {
    const item = (catalog?.items || []).find((entry) => entry.sku === picked);
    if (item) {
      const priced = priceEntry({ ...item, qty: 1 }, percent);
      return finish(`Okay, the ${priced.model}.`, [priced], true);
    }
  }

  if (!rebuilding) {
    const addition = addedAccessory(text);
    if (addition) {
      const carried = carryQuote(text, history, catalog, discount, page);
      const kept = (carried?.quote?.items || []).filter((item) => item.name !== addition.name);
      const known = addition.sku ? (catalog?.items || []).find((entry) => entry.sku === addition.sku) : null;
      const priced = known ? priceEntry({ ...known, qty: addition.qty }, percent) : null;
      const extra = priced
        ? toQuoteItem(priced, addition.qty)
        : { name: addition.name, sku: addition.sku || "", qty: addition.qty, estimate: null, estimateHigh: null, confidence: "unsure", kind: "unsure", lockName: true };
      const items = [...kept, extra];
      return {
        reply: `Okay, I'll add ${addition.qty} × ${addition.name}.\n\n${QUOTE_OFFER}`,
        quote: {
          items,
          offerForm: false,
          hold: true,
          stage: "quote",
          bulk: Boolean(carried?.quote?.bulk),
        },
      };
    }
  }

  if (!rebuilding) {
  const yes = /^(yes|yeah|yep|sure|ok|okay|add them|do it)\b/i.test(text);
  const no = /^(no|nope|nah|i'm set|im set|all set|we're set)\b/i.test(text);
  const pickNamed = (suggestions) => {
    const raw = text.toLowerCase();
    if (/\b(both|all of them|all)\b/i.test(raw)) return suggestions;
    return suggestions.filter((item) => {
      const name = item.name.toLowerCase();
      if (raw.includes(name)) return true;
      return name.split(/\s+/).some((word) => {
        if (word.length <= 3) return false;
        const stem = word.endsWith("s") ? word.slice(0, -1) : word;
        return raw.includes(word) || (stem.length > 3 && raw.includes(stem));
      });
    });
  };
  const whichLine = (suggestions) => {
    const names = suggestions.map((item) => item.name);
    const choice = names.length === 2 ? `the ${names[0]} or the ${names[1]}` : names.map((name) => `the ${name}`).join(", ");
    return `Which ones do you want, ${choice}?`;
  };
  const lastAssistant = [...history].reverse().find((entry) => entry.role === "assistant");
  if (/which ones do you want/i.test(lastAssistant?.content || "")) {
    const earlierUsers = history.filter((entry) => entry.role === "user" && !isShortReply(entry.content));
    const base = earlierUsers.length
      ? localReply({ message: earlierUsers[earlierUsers.length - 1].content, history, catalog, discount, page, rebuilding: true })
      : { quote: { items: [] } };
    const toolText = [...earlierUsers.map((entry) => entry.content), ...(base.quote?.items || []).map((item) => item.name)].join("\n");
    const offer = accessoryOffer(toolText);
    const picked = offer ? pickNamed(offer.suggestions) : [];
    if (!picked.length) {
      return {
        reply: offer ? whichLine(offer.suggestions) : "Which of those do you want?",
        quote: { items: base.quote?.items || [], offerForm: false, hold: true, stage: "quote", bulk: Boolean(base.quote?.bulk) },
      };
    }
    const extra = picked.map((item) => {
      const known = item.sku ? (catalog?.items || []).find((entry) => entry.sku === item.sku) : null;
      const priced = known ? priceEntry({ ...known, qty: item.qty }, percent) : null;
      return priced
        ? toQuoteItem(priced, item.qty)
        : { name: item.name, sku: item.sku || "", qty: item.qty, estimate: null, estimateHigh: null, confidence: "unsure", kind: "unsure", lockName: true };
    });
    return {
      reply: `Okay, I'll add ${picked.map((item) => item.name).join(" and ")}.\n\n${QUOTE_OFFER}`,
      quote: {
        items: [...(base.quote?.items || []), ...extra],
        offerForm: false,
        hold: true,
        stage: "quote",
        bulk: Boolean(base.quote?.bulk),
      },
    };
  }
  const accessoryPending = (() => {
    let asked = false;
    let answered = false;
    for (const entry of history) {
      if (entry.role === "assistant" && isAccessoryQuestion(entry.content)) asked = true;
      if (entry.role === "assistant" && /which ones do you want/i.test(entry.content || "")) answered = true;
      if (asked && entry.role === "user" && (
        addedAccessory(entry.content)
        || /^(yes|yeah|yep|sure|no|nope|nah|ok|okay|i'm set|im set|all set)\b/i.test(String(entry.content || "").trim())
      )) answered = true;
    }
    return asked && !answered;
  })();
  if ((yes || no) && accessoryPending) {
    const earlierUsers = history.filter((entry) => entry.role === "user" && !isShortReply(entry.content));
    const base = earlierUsers.length
      ? localReply({ message: earlierUsers[earlierUsers.length - 1].content, history, catalog, discount, page, rebuilding: true })
      : { quote: { items: [] } };
    const toolText = [...earlierUsers.map((entry) => entry.content), ...(base.quote?.items || []).map((item) => item.name)].join("\n");
    const offer = accessoryOffer(toolText);
    const chosen = yes && offer
      ? (offer.suggestions.length > 1 ? pickNamed(offer.suggestions) : offer.suggestions)
      : [];
    if (yes && offer && offer.suggestions.length > 1 && chosen.length === 0) {
      return {
        reply: whichLine(offer.suggestions),
        quote: {
          items: base.quote?.items || [],
          offerForm: false,
          hold: (base.quote?.items || []).length > 0,
          stage: (base.quote?.items || []).length ? "quote" : "script",
          bulk: Boolean(base.quote?.bulk),
        },
      };
    }
    const extra = chosen.map((item) => {
      const known = item.sku ? (catalog?.items || []).find((entry) => entry.sku === item.sku) : null;
      const priced = known ? priceEntry({ ...known, qty: item.qty }, percent) : null;
      return priced
        ? toQuoteItem(priced, item.qty)
        : { name: item.name, sku: item.sku || "", qty: item.qty, estimate: null, estimateHigh: null, confidence: "unsure", kind: "unsure", lockName: true };
    });
    const items = [...(base.quote?.items || []), ...extra];
    return {
      reply: yes
        ? `Okay, I'll add those.\n\n${QUOTE_OFFER}`
        : `No problem.\n\n${QUOTE_OFFER}`,
      quote: {
        items,
        offerForm: false,
        hold: items.length > 0,
        stage: items.length ? "quote" : "script",
        bulk: Boolean(base.quote?.bulk),
      },
    };
  }

  if (acceptingQuote(text, history)) {
    const carried = carryQuote(text, history, catalog, discount, page);
    return {
      reply: "Okay. Add your name and the job site and we'll send it.",
      quote: {
        items: carried?.quote?.items || [],
        offerForm: true,
        hold: false,
        stage: "form",
        bulk: Boolean(carried?.quote?.bulk),
      },
    };
  }

  if (isShortReply(text) && history.some((entry) => entry.role === "user" && !isShortReply(entry.content))) {
    const carried = carryQuote(text, history, catalog, discount, page);
    if (carried?.quote?.items?.length) return carried;
  }
  }

  const drill = drillTurn(text, history);
  if (drill?.stage === "clarify") {
    return { reply: drill.reply, quote: { items: [], offerForm: false, stage: "clarify" } };
  }
  if (drill?.stage === "recommend") return recommendCordedHammers(catalog, percent);

  if (/\bjack\s*hammers?\b|\bdemolition hammers?\b/i.test(text)) {
    return {
      reply: "Yes, we can source a jack hammer. What are you breaking up? And do you want it electric corded, cordless, or pneumatic?",
      quote: { items: [], offerForm: false, hold: false, stage: "quote" },
    };
  }

  if (/^what\??$/i.test(text)) {
    return {
      reply: confusedWhatReply(history),
      quote: { items: [], offerForm: false, hold: false, stage: "clarify" },
    };
  }

  if (/\bpvc\b/i.test(text) && /\b(saw|cutt)/i.test(text)) {
    return {
      reply: "For cutting PVC pipe, a fine-tooth saw or a PVC cutter keeps the cut clean. Are you cutting a few sticks or a lot of pipe?",
      quote: { items: [], offerForm: false, hold: false, stage: "quote" },
    };
  }

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

  if (/\b(overpay|extra for shipping|freight forwarder)\b/i.test(text)) {
    return finish(SCAM_CLOSE, [], false);
  }

  if (/\boregon\b/i.test(text) && /\b(ship|deliver|send)\b/i.test(text)) {
    return finish("Happy to look at that. What's the company name?", [], false);
  }

  if (/\b(talk to|speak to|real person|human|someone on the phone)\b/i.test(text)) {
    return finish(
      `You can reach our team at ${PHONE_DISPLAY}, Monday through Friday, 8 to 5. What's your name, company, and cell or email? ${HANDOFF_LINE} ${CLOSING_LINE}`,
      [],
      false,
    );
  }

  if (/\b(line card|what do you carry|what brands)\b/i.test(text)) {
    return finish(
      `Here's our line card: [line card](${LINE_CARD_URL}). Are you putting together a tool order for an upcoming jobsite?`,
      [],
      false,
    );
  }

  if (/\b(crew time|pick (it|them) up myself)\b/i.test(text)) {
    return finish(
      `A supply run feels like it costs $10 to $20, but it really costs $100 to $300 in lost crew time. ${DELIVERY_LINE}`,
      [],
      false,
    );
  }

  if (/\b(deliver|delivery|service area|how far|norfolk|newport news|richmond|virginia beach|hampton roads|hampton|chesapeake|portsmouth|yorktown|williamsburg|gloucester|jobsite|job site)\b/i.test(text) && !matches.length) {
    const named = text.match(/\b(norfolk|newport news|richmond|virginia beach|hampton|chesapeake|portsmouth|yorktown|williamsburg|gloucester)\b/i);
    const ack = named ? `Yes, we deliver to ${named[1]}.` : "Yes.";
    return finish(
      `${ack} ${DELIVERY_LINE} You can type the list here, or text or email a list or photo to ${PHONE_DISPLAY} or sales@yorktowntools.com.`,
      [],
      false,
    );
  }

  if (/\b(government purchase|purchase cards?|\bgpc\b)\b/i.test(text) || (/\bgovernment\b/i.test(text) && /\b(card|tax|buy)\b/i.test(text))) {
    return finish(
      "Yes. We're a Veteran-Owned Small Business with an active SAM registration. UEI SMYXDLJDJMZ4. CAGE 16LD9. We accept government purchase cards. Tax is 0% for government.",
      [],
      false,
    );
  }

  if (/\b(pay|payment|cards?|ach|check|net ?30|net ?15|credit|terms|invoice|po)\b/i.test(text)) {
    return finish(
      `Card, a government purchase card, ACH, and check are all fine. Card costs more to process than ACH, and a check has no fee. Don't send card or bank numbers in this chat. Net terms are only for approved customers. The credit application is here: [credit application](${CREDIT_APP_URL}). Sending it does not promise terms. Virginia sales tax is on the quote unless the order is tax-exempt, and a tax-exempt order needs a certificate.`,
      [],
      false,
    );
  }

  if (/\bconsign/i.test(text)) {
    return finish(
      `We can stock consumables like blades, bits, fasteners, and PPE on site, and you pay only for what you use. Here's the card: [consignment](${CONSIGNMENT_URL}). What kind of work do you do, and how big is the crew?`,
      [],
      false,
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
    return finish(blocks.join("\n\n"), matches.map((priced) => toQuoteItem(priced, priced.qty || qty)), true);
  }

  if (/\b(price|pricing|how much|quote|cost)\b/i.test(text)) {
    return finish(
      `Tell me the brand and model, and how many you need. I'll write the estimate. Free delivery from ${SERVICE_AREA}.`,
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

  if (!rebuilding && (history || []).some((entry) => entry.role === "assistant")) {
    return {
      reply: "Yes, we can help with that. What is the job, and do you have a brand in mind?",
      quote: { items: [], offerForm: false, hold: false, stage: "quote" },
    };
  }

  return finish(
    "I stick to tools, quotes, and delivery for Yorktown Tools. Tell me what you need on the job, or call or text (757) 940-5171.",
    [],
    false,
  );
}

export function confusedWhatReply(history) {
  const prior = [...(history || [])].reverse().find((entry) => entry.role === "assistant")?.content || "";
  if (/jack\s*hammer|demolition hammer/i.test(prior)) {
    return "Sorry, let me make it simpler. What kind of work is the jack hammer for: breaking concrete, tile, or something else?";
  }
  if (/let me make it simpler|which part should I answer/i.test(prior)) {
    return "Tell me the tool, or say delivery or payment, and I'll answer that part.";
  }
  return "Which part should I answer: the tool, delivery, or payment?";
}

export { BULK_LINE };
