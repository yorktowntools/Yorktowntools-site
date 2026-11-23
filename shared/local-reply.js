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
  LOCATION_LINE,
  HOURS,
  PHONE_DISPLAY,
  PRICING_LINE,
  SAFE_COST_REPLY,
  SERVICE_AREA,
} from "./copy.js";
import { filterCustomerText, isCustomerPriceAsk, isPrivateCostAsk } from "./customer-text.js";
import { acceptingQuote, answeredClarifyingQuestion, chatStage, clarifyingQuestion, concreteDrillingAdvice, drillTurn, genericSawQuestion, isShortReply, isSpecificAsk } from "./talk.js";
import { askedForReach, cartFromThread, eachQty, isLastNameAsk, listReadback, readIdentity, readyClose, sawGuide, washingtonReply } from "./job.js";
import { extractModelCodes } from "./models.js";
import { acceptsModel, brandLabel, interpretLine, isThanks, pendingModelConfirm } from "./trade.js";
import { accessoryAsked, accessoryOffer, isAccessoryQuestion } from "../worker/config/accessories.js";
import {
  discountPercent,
  extractQty,
  formatEstimate,
  formatMoney,
  matchCatalog,
  paymentOnTop,
  priceEntry,
  roundMoney,
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

  const finish = (reply, items, _offerForm, options = {}) => {
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
    const withOffer = askAccessories ? `${withBulk}\n\n${offer.line}` : withBulk;
    const safe = filterCustomerText(withOffer);
    const body = safe.costHit ? SAFE_COST_REPLY : safe.text;
    const stage = options.stage || (shaped.length ? "quote" : "script");
    return {
      reply: body,
      quote: {
        items: shaped,
        offerForm: false,
        hold: shaped.length > 0,
        stage,
        bulk,
        scripted: stage === "script",
      },
    };
  };

  if (!text) {
    return { reply: GREETING, quote: { items: [], offerForm: false, stage: "script", scripted: true } };
  }

  if (isThanks(text)) {
    const items = cartFromThread(history);
    const handedOff = (history || []).some((entry) => entry.role === "assistant" && /for our team to price|specialist will reach out|you['’]re all set|member of our yorktown tools team will review/i.test(entry.content || ""));
    const read = items.filter((item) => item?.name).map((item) => `${item.qty || 1} × ${item.name}`).join(", ");
    return {
      reply: handedOff && read ? `You bet. I have ${read}.` : "You bet.",
      quote: { items, offerForm: false, hold: items.length > 0, stage: "script", scripted: true },
    };
  }

  if (isLastNameAsk(text, history)) {
    return { reply: washingtonReply(), quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true } };
  }

  if (/\b(am i talking to a real person|are you a real person|are you (a )?human|are you (an )?ai|are you a bot)\b/i.test(text)) {
    return {
      reply: "I'm an AI assistant for Yorktown Tools. I can help pick tools and build your quote request, and our team handles pricing and final confirmation. Want to keep going?",
      quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true },
    };
  }

  if (/^what\??$/i.test(text)) {
    return {
      reply: confusedWhatReply(history),
      quote: { items: [], offerForm: false, hold: false, stage: "clarify" },
    };
  }

  const earlySaw = genericSawQuestion(text);
  if (earlySaw) {
    return { reply: earlySaw, quote: { items: [], offerForm: false, hold: false, stage: "quote" } };
  }


  const pending = pendingModelConfirm(history);
  if (pending && acceptsModel(text)) {
    return {
      reply: `Got it, the ${pending.label}.`,
      quote: { items: [], offerForm: false, hold: false, stage: "quote" },
    };
  }

  const heard = interpretLine(text);
  if (heard.confirm) {
    return { reply: heard.confirm, quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true } };
  }
  if (heard.clarify && heard.tools.length === 0) {
    const label = brandLabel(heard.brand);
    return {
      reply: label ? `${label}. ${heard.clarify}` : heard.clarify,
      quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true },
    };
  }


  if ((isCustomerPriceAsk(text) || /\b(how much|what(?:'s| is| does) it cost|pricing|do you have any pric)\b/i.test(text))
    && !/\bjack\s*hammers?\b|\bdemolition hammers?\b/i.test(text)
    && !genericSawQuestion(text)) {
    const items = matches.map((priced) => toQuoteItem(priced, priced.qty || qty));
    const read = items.filter((item) => item.name).map((item) => `${item.qty ? `${item.qty} × ` : ""}${item.name}`).join(", ");
    const typed = text.match(/\b([a-z]{1,6}\d{3,}[a-z0-9-]*)\b/i);
    const kit = !read && !typed && /\b(drill|driver|saw|grinder|impact|hammer)\b/i.test(text)
      ? " Are you looking for just the tool, or a kit with battery and charger?"
      : "";
    const spoken = read
      ? `I have ${read}. ${PRICING_LINE}`
      : (typed ? `I have the ${typed[1].toUpperCase()}. ${PRICING_LINE}` : `${PRICING_LINE}${kit}`);
    return finish(spoken.trim(), items, false);
  }

  const gloves = gloveTurn(text, heard, catalog, percent, history);
  if (gloves) return gloves;

  const each = eachQty(text);
  if (each) {
    const items = cartFromThread(history, text);
    if (items.length) {
      return {
        reply: listReadback(items),
        quote: { items, offerForm: false, hold: true, stage: "script", scripted: true },
      };
    }
  }

  const guided = sawGuide(history, text);
  if (guided) {
    return { reply: guided, quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true } };
  }

  const identity = readIdentity(history, text);
  const openHandoff = (history || []).some((entry) => entry.role === "assistant" && /team to price|cell or email/i.test(entry.content || ""));
  if (openHandoff && identity.name && (identity.phone || identity.email || identity.knowsZach)) {
    const items = cartFromThread(history);
    return {
      reply: readyClose(identity, askedForReach(history), items),
      quote: { items, offerForm: false, hold: items.length > 0, stage: "script", scripted: true },
    };
  }

  if (heard.tools.length === 1 && !/\b(jack\s*hammers?|grinders?|gloves?|ladders?|respirators?|ppe|hi-vis|safety glasses|glasses)\b/i.test(text)) {
    const name = heard.tools[0].name;
    if (name === "Jackhammer" && !(/\b(concrete|tile|asphalt|brick|masonry)\b/i.test(text) && /\b(corded|cordless|pneumatic|electric)\b/i.test(text))) {
      return {
        reply: "We can source a jackhammer. What are you breaking up, and do you want electric corded, cordless, or pneumatic?",
        quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true },
      };
    }
    if (/grinder|ladder|respirator|hi-vis|ppe|safety glasses|battery/i.test(name) && !/glove/i.test(name)) {
      const label = brandLabel(heard.brand);
      const ask = label ? "What size do you want?" : "What brand or size do you want?";
      const named = label ? `${label} ${name}` : name;
      return {
        reply: `We can source a ${named}. ${ask}`,
        quote: { items: [{ name: named, qty: null, sku: "", source: "U" }], offerForm: false, hold: true, stage: "script", scripted: true },
      };
    }
  }

  const picked = pickedModel(text, history);
  if (picked) {
    const item = (catalog?.items || []).find((entry) => entry.sku === picked);
    if (item) {
      const priced = priceEntry({ ...item, qty: 1 }, percent);
      return finish(`Okay, the ${priced.model}. ${PRICING_LINE}`, [priced], true);
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
        reply: `Okay, I'll add ${addition.qty} × ${addition.name}.`,
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
  const lastText = lastAssistant?.content || "";
  if (/would you like the invoice by text or email/i.test(lastText) && false) {
    const carried = carryQuote(text, history, catalog, discount, page);
    if (/\b(?:\d[ -]?){13,16}\b/.test(text)) {
      return {
        reply: "Don't send card numbers in this chat. Text or email for the invoice?",
        quote: { items: carried?.quote?.items || [], offerForm: false, hold: true, stage: "script", scripted: true },
      };
    }
    if (/\b(text|email)\b/i.test(text)) {
      return {
        reply: "What's the delivery address?",
        quote: { items: carried?.quote?.items || [], offerForm: false, hold: true, stage: "script", scripted: true },
      };
    }
    return {
      reply: "Text or email?",
      quote: { items: carried?.quote?.items || [], offerForm: false, hold: true, stage: "script", scripted: true },
    };
  }
  if (/what's the delivery address/i.test(lastText)) {
    const carried = carryQuote(text, history, catalog, discount, page);
    if (/\b(?:\d[ -]?){13,16}\b/.test(text)) {
      return {
        reply: "Don't send card numbers in this chat. What's the delivery address?",
        quote: { items: carried?.quote?.items || [], offerForm: false, hold: true, stage: "script", scripted: true },
      };
    }
    return {
      reply: `A secure QuickBooks payment link comes with the invoice. Don't send card numbers in this chat. ${CLOSING_LINE}`,
      quote: { items: carried?.quote?.items || [], offerForm: false, hold: false, stage: "script", scripted: true },
    };
  }
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
        quote: { items: base.quote?.items || [], offerForm: false, hold: true, stage: "script", scripted: true, bulk: Boolean(base.quote?.bulk) },
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
      reply: `Okay, I'll add ${picked.map((item) => item.name).join(" and ")}.`,
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
  if (false && /would you like to place an order/i.test(lastText) && yes && !accessoryPending && !isAccessoryQuestion(lastText)) {
    const carried = carryQuote(text, history, catalog, discount, page);
    return {
      reply: "Would you like the invoice by text or email?",
      quote: { items: carried?.quote?.items || [], offerForm: false, hold: true, stage: "script", scripted: true },
    };
  }
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
          stage: "script", scripted: true,
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
      reply: yes ? "Okay, I'll add those." : "No problem.",
      quote: {
        items,
        offerForm: false,
        hold: items.length > 0,
        stage: items.length ? "quote" : "script",
        scripted: items.length === 0,
        bulk: Boolean(base.quote?.bulk),
      },
    };
  }

  if (acceptingQuote(text, history)) {
    const carried = carryQuote(text, history, catalog, discount, page);
    return {
      reply: "Would you like the invoice by text or email?",
      quote: {
        items: carried?.quote?.items || [],
        offerForm: false,
        hold: true,
        stage: "script",
        scripted: true,
        bulk: Boolean(carried?.quote?.bulk),
      },
    };
  }

  if (/^what\??$/i.test(text)) {
    return {
      reply: confusedWhatReply(history),
      quote: { items: [], offerForm: false, hold: false, stage: "clarify" },
    };
  }

  if (/that one's for our team to price|we'll confirm the price/i.test(lastText) && /name, company, and cell or email/i.test(lastText)) {
    if (gaveContact(text)) {
      const carried = carryQuote(text, history, catalog, discount, page);
      return {
        reply: `${HANDOFF_LINE}`,
        quote: {
          items: carried?.quote?.items || [],
          offerForm: false,
          hold: false,
          stage: "script",
          scripted: true,
          bulk: Boolean(carried?.quote?.bulk),
        },
      };
    }
  }

  if (isShortReply(text) && history.some((entry) => entry.role === "user" && !isShortReply(entry.content))) {
    const carried = carryQuote(text, history, catalog, discount, page);
    if (carried?.quote?.items?.length) return carried;
  }
  }

  if (isPrivateCostAsk(text)) {
    return { reply: SAFE_COST_REPLY, quote: { items: [], offerForm: false, stage: "script", scripted: true } };
  }

  const holeAdvice = concreteDrillingAdvice(text);
  if (holeAdvice) {
    return { reply: holeAdvice, quote: { items: [], offerForm: false, hold: false, stage: "quote" } };
  }

  const sawQuestion = genericSawQuestion(text);
  if (sawQuestion) {
    return { reply: sawQuestion, quote: { items: [], offerForm: false, hold: false, stage: "quote" } };
  }

  const drill = drillTurn(text, history);
  if (drill?.stage === "clarify") {
    return { reply: drill.reply, quote: { items: [], offerForm: false, stage: "clarify" } };
  }
  if (drill?.stage === "recommend") return recommendCordedHammers(catalog, percent);

  if (/\bjack\s*hammers?\b|\bdemolition hammers?\b/i.test(text)
    && !(/\b(concrete|tile|asphalt|brick|masonry)\b/i.test(text) && /\b(corded|cordless|pneumatic|electric)\b/i.test(text))) {
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

  const consignmentFollow = consignmentTurn(text, history);
  if (consignmentFollow) return finish(consignmentFollow, [], false);

  const stage = chatStage(text, history, catalog);
  if (stage === "clarify") {
    const ask = clarifyingQuestion(text, history);
    if (ask) {
      return { reply: ask, quote: { items: [], offerForm: false, stage: "clarify" } };
    }
  }
  if (answeredClarifyingQuestion(text, history) && stage !== "recommend" && stage !== "form") {
    return { reply: "", quote: { items: [], offerForm: false, hold: false, stage: "quote" } };
  }

  if (/ignore (all |any |the )?(previous|above|prior) instructions|system prompt|you are now|jailbreak|developer mode/i.test(text)) {
    return finish(
      "I only help with tools, quotes, and delivery for Yorktown Tools. What do you need on the job?",
      [],
      false,
    );
  }

  if (isPrivateCostAsk(text)) {
    return { reply: SAFE_COST_REPLY, quote: { items: [], offerForm: false, stage: "script", scripted: true } };
  }

  if (/^(?:hi|hey|hello|yo|good morning|good afternoon)[.!\s]*$/i.test(text)) {
    if (alreadyGreeted(history)) {
      return {
        reply: "What do you need for the job?",
        quote: { items: [], offerForm: false, hold: false, stage: "clarify" },
      };
    }
    return finish(GREETING, [], false);
  }

  if (isLocationAsk(text)) {
    return finish(LOCATION_LINE, [], false);
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

  const screen = screenOutOfArea(text, history);
  if (screen) return finish(screen, [], false);

  if (/\b(talk to|speak to|someone on the phone|call me back)\b/i.test(text) && !/real person|are you (a )?human|are you (an )?ai|are you a bot/i.test(text)) {
    return finish(
      `You can reach our team at ${PHONE_DISPLAY}, Monday through Friday, 8 to 5. I can also take your name and a cell or email and have a specialist follow up.`,
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
      `A supply run feels cheap until you count the lost crew time. ${DELIVERY_LINE}`,
      [],
      false,
    );
  }

  const mentionsTool = Boolean(matches.length || heard.tools.length || heard.brand || extractModelCodes(text).length);
  if (/\b(deliver|delivery|service area|how far|norfolk|newport news|richmond|virginia beach|hampton roads|hampton|chesapeake|portsmouth|yorktown|williamsburg|gloucester|jobsite|job site)\b/i.test(text) && !mentionsTool) {
    const named = text.match(/\b(norfolk|newport news|richmond|virginia beach|hampton|chesapeake|portsmouth|yorktown|williamsburg|gloucester)\b/i);
    const ack = named ? `Yes, we deliver to ${named[1]}.` : "Yes.";
    return finish(
      `${ack} ${DELIVERY_LINE} You can type the list here, or text or email a list or photo to ${PHONE_DISPLAY} or sales@yorktowntools.com.`,
      [],
      false,
    );
  }

  const government = governmentTurn(text, history);
  if (government) return finish(government, [], false);

  if (!isCustomerPriceAsk(text) && !mentionsTool && /\b(pay|payment|cards?|ach|check|net ?30|net ?15|credit|terms|invoice|po)\b/i.test(text)) {
    return finish(
      `Card, a government purchase card, ACH, and check are all fine. Card costs more to process than ACH, and a check has no fee. Don't send card or bank numbers in this chat. Net terms are only for approved customers. The credit application is here: [credit application](${CREDIT_APP_URL}). Sending it does not promise terms. Virginia sales tax is on the quote unless the order is tax-exempt, and a tax-exempt order needs a certificate.`,
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

  const namedModel = /\b[a-z]{1,6}\d{3,}[a-z0-9-]*\b/i.test(text);
  const ongoing = (history || []).some((entry) => entry.role === "user" || entry.role === "assistant");
  if (matches.length && (!ongoing || namedModel || isCustomerPriceAsk(text) || rebuilding || isSpecificAsk(text, catalog))) {
    const lines = matches.map((priced) => {
      const lineQty = priced.qty || qty;
      const qtyBit = lineQty ? `${lineQty} × ` : "";
      return `- ${qtyBit}${priced.name}.`;
    });
    const links = [];
    for (const priced of matches) {
      const link = itemLink(priced);
      if (link && !links.includes(link)) links.push(link);
    }
    const blocks = [lines.join("\n"), PRICING_LINE];
    if (links.length) blocks.push(links.join("\n"));
    return finish(blocks.join("\n\n"), matches.map((priced) => toQuoteItem(priced, priced.qty || qty)), false);
  }

  if (isCustomerPriceAsk(text) || /\b(price|pricing|how much|quote|cost)\b/i.test(text)) {
    const saw = genericSawQuestion(text);
    if (saw) {
      return { reply: saw, quote: { items: [], offerForm: false, hold: false, stage: "quote" } };
    }
    const model = text.match(/\b([a-z]{1,6}\d{3,}[a-z0-9-]*)\b/i);
    if (model) {
      return {
        reply: `I have the ${model[1].toUpperCase()}. ${PRICING_LINE}`,
        quote: { items: [], offerForm: false, hold: false, stage: "quote" },
      };
    }
    return finish(
      `Tell me the brand and model, and how many you need. ${PRICING_LINE} Free delivery from ${SERVICE_AREA}.`,
      [],
      true,
      { stage: "quote" },
    );
  }

  const hasPriorTalk = (history || []).some((entry) => entry.role === "user" || entry.role === "assistant");
  if (!hasPriorTalk && /\b(sds|rotary hammers?|hammers?|grinders?|nailers?|impacts?|drivers?|sanders?|routers?|planers?|compressors?|generators?|heat guns?|blowers?|vacuums?|welders?|power tools?|multi-tools?|oscillating|reciprocating|drills?|saws?|ladders?|gloves?|batter(?:y|ies)|blades?|bits?|wrenches?|storage|packout|ppe|hard hats?|lasers?|levels?|jackery|power|dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid|skil|flex|hercules|kobalt)\b/i.test(text)) {
    const hint = CATEGORIES.slice(0, 4)
      .map((cat) => pageLink(cat.path, cat.name))
      .join(", ");
    return finish(
      `I can quote that. Brand and model help, plus the quantity. A few places to look: ${hint}. Or just tell me what the crew is trying to do.`,
      [],
      true,
      { stage: "quote" },
    );
  }

  if (page && /what.*(page|sell|categor)/i.test(text)) {
    const list = CATEGORIES.map((cat) => pageLink(cat.path, cat.name)).join(", ");
    return finish(`Here's how the site is split: ${list}.`, [], false);
  }

  if (heard.tools.length) {
    const items = cartFromThread([], text);
    if (items.length) {
      return {
        reply: listReadback(items),
        quote: { items, offerForm: false, hold: true, stage: "script", scripted: true },
      };
    }
  }

  const modelCode = text.match(/\b([a-z]{1,6}\d{3,}[a-z0-9-]*)\b/i);
  if (modelCode || /\b(i need|i'm looking|im looking|looking for|got any|do you have)\b/i.test(text)) {
    const code = modelCode ? modelCode[1].toUpperCase() : "";
    return {
      reply: code ? `Got it, the ${code}. ${PRICING_LINE}` : `${PRICING_LINE} Brand and model help, plus the quantity.`,
      quote: { items: [], offerForm: false, hold: false, stage: "quote" },
    };
  }

  if (!rebuilding && (history || []).some((entry) => entry.role === "assistant")) {
    // Don't invent a canned follow-up question. The live path should ask the model.
    return { reply: "", quote: { items: [], offerForm: false, hold: false, stage: "quote" } };
  }

  return finish(
    "I stick to tools, quotes, and delivery for Yorktown Tools. Tell me what you need on the job, or call or text (757) 940-5171.",
    [],
    false,
  );
}

function boxCount(text) {
  const numbered = String(text || "").match(/\b(\d+)\s*boxes?\b/i);
  if (numbered) return Number(numbered[1]);
  return /\bbox(?:es)?\b/i.test(text) ? 1 : 0;
}

function pairsInBox(item) {
  const notes = `${item?.notes || ""} ${(item?.aliases || []).join(" ")}`;
  const match = notes.match(/(\d+)\s*pairs?\s*(?:per|in a)\s*box/i);
  return match ? Number(match[1]) : null;
}

function gloveQuote(priced, qty) {
  return {
    reply: `We keep Victory Series drivers gloves on hand. I have ${qty} × ${priced.name}. Other glove types are available. Our team will put a free quote together. What's your name and a cell or email so they can reach you?`,
    quote: { items: [toQuoteItem(priced, qty)], offerForm: false, hold: true, stage: "script", scripted: true },
  };
}

function gloveTurn(text, heard, catalog, percent, history) {
  const askedBox = (history || []).some((entry) => entry.role === "assistant" && /how many pairs are in the box/i.test(entry.content || ""));
  const followPairs = askedBox && /^\d{1,4}$/.test(String(text || "").trim()) ? Number(String(text).trim()) : null;
  const names = (heard?.tools || []).map((tool) => tool.name);
  const gloveLine = names.length === 1 && /glove/i.test(names[0]);
  if (!followPairs && !gloveLine) return null;
  if (/\bvictory\b/i.test(text) && !boxCount(text)) return null;
  const victory = (catalog?.items || []).find((item) => item.sku === "VICTORY-GLOVE");
  const priced = victory ? priceEntry({ ...victory, qty: 1 }, percent) : null;
  if (followPairs && priced) return gloveQuote(priced, followPairs);
  const boxes = boxCount(text);
  const stated = String(text || "").match(/\b(\d+)\s*pairs?\b/i);
  const perBox = victory ? pairsInBox(victory) : null;
  if (boxes && stated && priced) return gloveQuote(priced, boxes * Number(stated[1]));
  if (boxes && perBox && priced) return gloveQuote(priced, boxes * perBox);
  if (boxes) {
    if (askedBox) return null;
    return {
      reply: "We keep Victory Series drivers gloves on hand. Other glove types are available. How many pairs are in the box?",
      quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true },
    };
  }
  const qty = extractQty(text);
  if (qty && priced) return gloveQuote(priced, qty);
  return {
    reply: "We keep Victory Series drivers gloves on hand. Other glove types are available. How many pairs do you want?",
    quote: { items: [], offerForm: false, hold: false, stage: "script", scripted: true },
  };
}

const SHIP_WORD = /\b(ships?|shipped|shipping|delivers?|delivered|delivery|sends?|sending)\b/i;
const OUT_OF_AREA = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|washington|west virginia|wisconsin|wyoming|atlanta|chicago|dallas|denver|los angeles|miami|phoenix|portland|seattle)\b/i;
const CREDS = "Yes. We're a Veteran-Owned Small Business with an active SAM registration. UEI SMYXDLJDJMZ4. CAGE 16LD9. We accept government purchase cards. If the purchase is tax-exempt, send the exemption certificate or agency exemption document and we'll note it on the order. Tax stays on the quote until our team verifies it.";

function gaveContact(text) {
  const raw = String(text || "");
  if (/\b[\w.+-]+@[\w.-]+\.\w+\b/.test(raw)) return true;
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(raw)) return true;
  if (isFreshQuestion(raw)) return false;
  return /\b(my name|i'm|i am|this is)\b/i.test(raw);
}

function isFreshQuestion(text) {
  const raw = String(text || "");
  if (/\b[\w.+-]+@[\w.-]+\.\w+\b/.test(raw) || /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(raw)) return false;
  if (concreteDrillingAdvice(raw) || genericSawQuestion(raw)) return true;
  if (/\?/.test(raw)) return true;
  if (/\b(what|how|which|why|can you|do you|price|pricing|cost|quote|drill|saw|model|need)\b/i.test(raw)) return true;
  if (/\b[a-z]{0,6}\d{3,}[a-z0-9-]*\b/i.test(raw)) return true;
  return false;
}

function alreadyGreeted(history) {
  return (history || []).some((entry) => entry.role === "assistant" && /hey, i'm george|welcome to yorktown tools/i.test(entry.content || ""));
}

function assistantText(history) {
  return (history || []).filter((entry) => entry.role === "assistant").map((entry) => entry.content || "").join("\n");
}

function userText(history, latest = "") {
  return [...(history || []).filter((entry) => entry.role === "user").map((entry) => entry.content || ""), latest].filter(Boolean).join("\n");
}

function screenOutOfArea(text, history) {
  const users = userText(history, text);
  const asked = assistantText(history);
  const started = /what's the company name/i.test(asked) && OUT_OF_AREA.test(users);
  const trigger = OUT_OF_AREA.test(text) && SHIP_WORD.test(text);
  if (!started && !trigger) return "";
  if (/\b(overpay|extra for shipping|freight forwarder)\b/i.test(`${text}\n${users}`)) return SCAM_CLOSE;
  const heard = `${asked}\n${text}`;
  if (!/what's the company name/i.test(asked)) return "Happy to look at that. What's the company name?";
  if (!/website|www\.|\.com|\.example/i.test(heard)) return "Thanks. What's the company website?";
  if (!/business address/i.test(asked) && !/\d+\s+[a-z]/i.test(text)) return "What's the business address?";
  if (!/how did you find us/i.test(asked) && !/found you|google|referral/i.test(text)) return "How did you find us?";
  if (!/how do you plan to pay/i.test(asked) && !/\b(card|check|ach|wire)\b/i.test(text)) return "How do you plan to pay?";
  return `${HANDOFF_LINE}`;
}

function isLocationAsk(text) {
  const raw = String(text || "");
  if (/\b(deliver|delivery|ship|jobsite|job site)\b/i.test(raw)) return false;
  return /\bwhere\s+(?:are|r)\s+(?:you|u|y'all|yall)(?:\s+guys)?\s*(?:located|based|at|out of)?\b|\bwhere(?:'s| is)\s+(?:your|the)\s+(?:store|shop|warehouse|office|location|building)\b|\b(?:your|the company's)\s+(?:street\s+)?(?:address|location)\b|\bcan i (?:come|stop) by\b|\bwalk[- ]?in\b/i.test(raw);
}

function governmentBuyer(text) {
  return /\b(government purchase|purchase cards?|\bgpc\b)\b/i.test(text)
    || (/\bgovernment\b/i.test(text) && /\b(cards?|tax|buy)\b/i.test(text));
}

function specialtyAsk(text) {
  const raw = String(text || "");
  if (!/\b(jp-?8|generators?|specialty)\b/i.test(raw)) return "";
  const compact = raw.match(/\b(\d{1,4})\s+((?:jp-?8\s+)?generators?(?:\s+at)?(?:\s+\d{2,5}\s*w)?|jp-?8(?:\s+generators?)?(?:\s+at)?(?:\s+\d{2,5}\s*w)?)/i);
  if (compact) return `${compact[1]} ${compact[2]}`.replace(/\s+/g, " ").trim();
  const bare = raw.match(/\b((?:jp-?8\s+)?generators?(?:\s+at)?(?:\s+\d{2,5}\s*w)?|jp-?8(?:\s+generators?)?(?:\s+at)?(?:\s+\d{2,5}\s*w)?)/i);
  return bare ? bare[1].replace(/\s+/g, " ").trim() : "";
}

function governmentTurn(text, history) {
  const asked = assistantText(history);
  const saidCreds = /SMYXDLJDJMZ4/.test(asked);
  const buyer = governmentBuyer(text) || (saidCreds && governmentBuyer(text));
  if (!buyer && !saidCreds) return "";
  if (saidCreds && !governmentBuyer(text) && !specialtyAsk(userText(history, text))) return "";
  const product = specialtyAsk(text) || specialtyAsk(userText(history));
  if (!product && !saidCreds) return `${CREDS} Do you need a formal quote or purchase order?`;
  if (!product) return "";
  const contact = /\b[\w.+-]+@[\w.-]+\.\w+\b/.test(text) || (/\b(my name|i'm|i am)\b/i.test(text) && /\b(unit|company|navy|army)\b/i.test(text));
  if (saidCreds && contact) return `${HANDOFF_LINE}`;
  const creds = saidCreds ? "Yes." : CREDS;
  return `${creds} I have ${product}. What's your name, unit or company, and cell or email?`;
}

function crewAlready(text) {
  return /\bcrew\b/i.test(text) && /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|dozen)\b/i.test(text);
}

function consignmentTurn(text, history) {
  const asked = assistantText(history);
  const inThread = /\bconsign/i.test(text) || /pay only for what you use|consignment/i.test(asked);
  if (!inThread) return "";
  if (/brands or sizes/i.test(asked) && /name, company, and cell/i.test(asked)) {
    if (/\b[\w.+-]+@|\b\d{3}[-.\s]?\d{3}/.test(text) || /\b(my name|i'm|i am)\b/i.test(text)) {
      return `${HANDOFF_LINE}`;
    }
  }
  if (/brands or sizes/i.test(asked) && !/name, company, and cell/i.test(asked)) {
    return "What's your name, company, and cell or email?";
  }
  if (/pay only for what you use/i.test(asked) && /\b(blades?|bits?|fasteners?|ppe)\b/i.test(text)) {
    return "Got it. Do you want specific brands or sizes, or should we pick them together?";
  }
  if (/\bconsign/i.test(text)) {
    const crew = crewAlready(text) || (history || []).some((entry) => entry.role === "user" && crewAlready(entry.content || ""));
    const crewAsk = crew ? "" : " How big is the crew?";
    return `We can stock consumables like blades, bits, fasteners, and PPE on site, and you pay only for what you use. Here's the card: [consignment](${CONSIGNMENT_URL}). What kind of work do you do?${crewAsk}`;
  }
  return "";
}

export function confusedWhatReply(history) {
  const prior = [...(history || [])].reverse().find((entry) => entry.role === "assistant")?.content || "";
  const recentUsers = (history || []).filter((entry) => entry.role === "user").slice(-4).map((entry) => entry.content || "").join("\n");
  if (isLastNameAsk(recentUsers, history) || /make it washington|last name/i.test(recentUsers)) return washingtonReply();
  if (/jack\s*hammer|demolition hammer/i.test(`${prior}\n${recentUsers}`)) {
    return "Sorry, let me make it simpler. What kind of work is the jack hammer for: breaking concrete, tile, or something else?";
  }
  if (/let me make it simpler|which part should I answer/i.test(prior)) {
    return "Tell me the tool, or say delivery or payment, and I'll answer that part.";
  }
  return "Which part should I answer: the tool, delivery, or payment?";
}

export { BULK_LINE };
