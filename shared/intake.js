/** Quote-intake order: specific items, then quantity and brand, then name and contact. */

import { extractModelCodes } from "./models.js";

const CONTACT_ASK = /\b((?:what(?:'s| is)|share|give me|need|send)\b.{0,80}\b(name|phone|email|cell)\b|\bbest (?:phone|cell|email)\b|\bphone number or email\b|\bcell or email\b|\bget this (?:to the team|quote started)\b)/i;

const QUANTITY_ASK = /\b(how many|what quantity|quantit(?:y|ies)|how much of each)\b/i;

const BRAND_ASK = /\b(brand preference|preferred brand|any brand|brand in mind|which brand|a brand you (?:prefer|want|use)|brand or model)\b/i;

const LIST_CONFIRM = /^(?:yes|yeah|yep|yup|ok|okay|correct|right|looks good|looks right|that looks right|that'?s right|that'?s (?:it|all|fine|correct)|this is everything|just that|nothing else|sounds good)\.?$/i;

const NAME_DECLINE = /^(?:no|nope|nah|skip(?: it)?|none|no name|just (?:the )?(?:number|phone|email)|don'?t have (?:a |one )?name|prefer not|rather not)\.?$/i;

const GENERIC_ITEM = /^(?:just\s+(?:the\s+)?)?(?:some\s+)?(?:the\s+)?(?:hand\s+)?(?:power\s+)?tools?(?:\s+for\s+.+)?$|^(?:something|stuff|supplies|equipment|parts?|items?|a battery|the battery|battery(?:\s+replacement)?|not specified(?:\s+.*)?)$/i;

const SPECIFIC_TOOL = /\b(terminal(?:\s+pullers?|\s+brushes?)?|pullers?|wrenches?|sockets?|ratchets?|pliers?|screwdrivers?|brushes?|hammers?|drills?|drivers?|saws?|grinders?|grinding|kits?|chargers?|batteries|impact|lifts?|ladders?|blades?|bits?|discs?|wheels?|gloves?|sander|nailers?|compressor|fasteners?|ppe)\b/i;

const BRAND_OR_OPEN = /\b(dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid|skil|flex|hercules|kobalt|any brand|no preference|no particular brand|doesn'?t matter|don'?t care|do not care|whatever|you pick)\b/i;

function textOf(entry) {
  return String(entry?.content || "");
}

function usersAndAssistants(history, latest = "") {
  const entries = [...(history || [])];
  if (latest) entries.push({ role: "user", content: latest });
  return entries;
}

function itemText(item) {
  if (!item || typeof item !== "object") return String(item || "").trim();
  return [item.brand, item.product || item.name, item.model || item.sku].filter(Boolean).join(" ").trim();
}

function asked(history, pattern) {
  return usersAndAssistants(history).some((entry) => entry.role === "assistant" && pattern.test(textOf(entry)));
}

function userRepliedAfter(history, askPattern) {
  const entries = usersAndAssistants(history);
  let sawAsk = false;
  for (const entry of entries) {
    if (entry.role === "assistant" && askPattern.test(textOf(entry))) sawAsk = true;
    else if (sawAsk && entry.role === "user" && textOf(entry).trim()) return true;
  }
  return false;
}

function lastAssistant(history) {
  return [...usersAndAssistants(history)].reverse().find((entry) => entry.role === "assistant");
}

function userBlob(history, latest = "") {
  return usersAndAssistants(history, latest)
    .filter((entry) => entry.role === "user")
    .map((entry) => textOf(entry))
    .join("\n");
}

export function asksForContact(text) {
  return CONTACT_ASK.test(String(text || ""));
}

export function itemsAreSpecific(items = [], history = []) {
  const list = (items || []).filter((item) => itemText(item));
  const named = list.filter((item) => {
    const label = itemText(item).replace(/^not specified\s+/i, "").trim();
    if (!label) return false;
    if (item.model || item.sku) return true;
    if (GENERIC_ITEM.test(label)) return false;
    return SPECIFIC_TOOL.test(label) && !/^(?:hand\s+)?tools?\s+for\b/i.test(label);
  });
  if (named.length) return true;
  const lastUser = [...usersAndAssistants(history)].reverse().find((entry) => entry.role === "user");
  const latest = textOf(lastUser).trim();
  const spoken = userBlob(history).replace(/\bjust the hand tools\b/gi, " ");
  const source = `${latest}\n${spoken}`;
  if (SPECIFIC_TOOL.test(source) && !GENERIC_ITEM.test(latest)) {
    const withoutGeneric = source.replace(/\b(?:hand\s+)?tools?\b/gi, " ");
    return SPECIFIC_TOOL.test(withoutGeneric);
  }
  return false;
}

const STATED_QTY = /\b(?:qty|quantity)\s*[:=]?\s*\d+|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a pair|a set)\s*(?:of\s+each|each|x\b|×|pairs?|sets?|kits?|pcs|pieces)\b|\b(?:just\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?!inch(?:es)?\b|in\b|mm\b|cm\b|ft\b|volt|v\b|amp|ah\b|gallon|lb|pound|watt|w\b|hz\b|camaro)|\b(?:need|needs|want|order(?:ing)?)\s+(?:about\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+|\bsome\s+(?!tools?\b)/i;

export function quantitySettled(history = [], items = []) {
  if (userRepliedAfter(history, QUANTITY_ASK)) return true;
  if (STATED_QTY.test(userBlob(history))) return true;
  const entries = usersAndAssistants(history);
  let sawReadback = false;
  for (const entry of entries) {
    if (entry.role === "assistant" && /here'?s what i have|does that look right/i.test(textOf(entry))) {
      sawReadback = true;
    } else if (sawReadback && entry.role === "user" && LIST_CONFIRM.test(textOf(entry).trim())) {
      return true;
    }
  }
  return false;
}

export function brandSettled(history = [], items = []) {
  const list = (items || []).filter((item) => itemText(item));
  if (list.some((item) => item.brand || item.model || item.sku || /\b(dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid)\b/i.test(itemText(item)))) {
    return true;
  }
  if (BRAND_OR_OPEN.test(userBlob(history))) return true;
  if (extractModelCodes(userBlob(history)).length) return true;
  if (userRepliedAfter(history, BRAND_ASK)) return true;
  return false;
}

export function isSpecialIntake(history = [], reply = "") {
  const text = `${userBlob(history)}\n${reply}`;
  return /\b(gpc\b|government buyer|consignment|mini-store|shipped to|out of (?:the )?area|overpay and send extra|business address)\b/i.test(text);
}

export function intakeReadyForContact(history = [], items = []) {
  if (isSpecialIntake(history)) return true;
  return itemsAreSpecific(items, history) && quantitySettled(history, items) && brandSettled(history, items);
}

export function nameAskCount(history = []) {
  return usersAndAssistants(history).filter((entry) => (
    entry.role === "assistant" && /\byour name\b/i.test(textOf(entry))
  )).length;
}

export function customerDeclinedName(history = []) {
  const entries = usersAndAssistants(history);
  let askedName = false;
  for (const entry of entries) {
    if (entry.role === "assistant" && /\byour name\b/i.test(textOf(entry))) {
      askedName = true;
      continue;
    }
    if (!askedName || entry.role !== "user") continue;
    const line = textOf(entry).trim();
    if (!line) continue;
    if (NAME_DECLINE.test(line)) return true;
  }
  return false;
}

export function intakeReadyForSubmit(history = [], identity = {}, items = []) {
  if (!intakeReadyForContact(history, items)) return false;
  if (!(identity.phone || identity.email)) return false;
  if (identity.name) return true;
  return nameAskCount(history) >= 2 || (nameAskCount(history) >= 1 && customerDeclinedName(history));
}

export function nextIntakeQuestion(history = [], items = [], identity = {}) {
  const batteryJob = /\bbattery\b/i.test(userBlob(history));
  if (!itemsAreSpecific(items, history)) {
    return batteryJob
      ? "Which specific hand tools do you need to remove and install the battery? For example a terminal puller, wrench or socket sizes, or a terminal brush?"
      : "Which specific tools or products do you need?";
  }
  const needQty = !quantitySettled(history, items);
  const needBrand = !brandSettled(history, items);
  if (needQty && needBrand) {
    return "How many of each do you need, and do you have a brand preference, or is any brand fine?";
  }
  if (needQty) return "How many of each do you need?";
  if (needBrand) return "Do you have a brand preference, or is any brand fine?";
  if (!(identity.phone || identity.email) || !identity.name) {
    if (identity.phone || identity.email) {
      if (nameAskCount(history) >= 1 && !customerDeclinedName(history)) {
        return "And what's your name, and a company name if you have one?";
      }
      if (nameAskCount(history) >= 2 || customerDeclinedName(history)) return "";
    }
    return "What's your name, and a company name if you have one, plus the best phone number or email to reach you?";
  }
  return "";
}

function isPrematureBrandAsk(reply) {
  const text = String(reply || "").trim();
  if (!text) return false;
  if (/what are you (cutting|using|breaking)|bare tool|which model|blade size|kit with|corded or cordless|brand or model/i.test(text)) {
    return false;
  }
  return /\bdo you have a brand preference\b|\bwhat brand do you prefer\b|\bwhich brand do you (?:prefer|want|like)\b|\bis any brand fine\b|^what brand\b|^which brand\b/i.test(text)
    && !QUANTITY_ASK.test(text);
}

function replaceContactAsk(reply, next) {
  if (!next) return reply;
  const stripped = String(reply || "")
    .replace(/\s*(?:What'?s your (?:name|phone number or email)[\s\S]*|What'?s the best (?:cell|phone|email)[\s\S]*|could you give me your name[\s\S]*|I can send this to our team once I have[\s\S]*)$/i, "")
    .trim();
  if (stripped && stripped.length > 8 && stripped !== String(reply || "").trim()) {
    return `${stripped.replace(/[.?!]\s*$/, ".")} ${next}`;
  }
  return next;
}

export function applyIntakeGate(reply, history, items, identity) {
  if (isSpecialIntake(history, reply)) return reply;
  if (/i['’]ll note that he knows you/i.test(reply || "")) return reply;
  const next = nextIntakeQuestion(history, items, identity);
  if (!intakeReadyForContact(history, items)) {
    if (asksForContact(reply)) return replaceContactAsk(reply, next);
    if (isPrematureBrandAsk(reply) && next) return next;
    return reply;
  }
  if (asksForContact(reply) && next && /your name/i.test(next) && !/\byour name\b/i.test(reply || "")) {
    return replaceContactAsk(reply, next);
  }
  return reply;
}

export function intakeSubmitBlock(history = [], identity = {}, items = []) {
  if (isSpecialIntake(history)) {
    if ((identity.phone || identity.email) && (identity.name || nameAskCount(history) >= 2 || customerDeclinedName(history)) && (items || []).length) {
      return null;
    }
  }
  if (intakeReadyForSubmit(history, identity, items)) return null;
  const missing = [];
  if (!itemsAreSpecific(items, history)) missing.push("specific_items");
  if (!quantitySettled(history, items)) missing.push("quantity");
  if (!brandSettled(history, items)) missing.push("brand");
  if (!(identity.phone || identity.email)) missing.push("phone_or_email");
  if (!identity.name && nameAskCount(history) < 2 && !customerDeclinedName(history)) missing.push("name");
  return { ok: false, error: "missing_info", missing };
}
