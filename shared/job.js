import { CLOSING_LINE, CONTACT_ASK_LINE, HANDOFF_LINE, LAST_NAME_LINE, READY_LINE } from "./copy.js";
import { intakeReadyForContact, nextIntakeQuestion } from "./intake.js";
import { interpretLine, normalizeTrade, canonicalBrand, brandLabel } from "./trade.js";
import { extractModelCodes, isGluedModelLabel } from "./models.js";

const BRANDS = "dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid|skil|flex|hercules|kobalt";

function users(history, latest = "") {
  return [...(history || []).filter((entry) => entry.role === "user").map((entry) => entry.content || ""), latest]
    .filter(Boolean);
}

export function userBlob(history, latest = "") {
  return users(history, latest).join("\n");
}

export function eachQty(text) {
  const match = String(text || "").trim().match(/^(?:just\s+)?(\d+|one|a|an)\s+each\b/i);
  if (!match) return null;
  if (/^one|a|an$/i.test(match[1])) return 1;
  const qty = Number(match[1]);
  return qty > 0 ? qty : null;
}

export function productsInText(text) {
  return interpretLine(text).tools.map((tool) => tool.name);
}

export function itemsFromModelsInThread(history, latest = "") {
  const entries = [...(history || [])];
  if (latest) entries.push({ role: "user", content: latest });
  const userText = entries.filter((entry) => entry.role === "user").map((entry) => entry.content || "").join("\n");
  const allText = entries.map((entry) => entry.content || "").join("\n");
  const found = extractModelCodes(userText);
  const brand = brandLabel(canonicalBrand(allText));
  return found.filter((code) => !isGluedModelLabel(code)).map((code) => ({
    name: brand ? `${brand} ${code}` : code,
    sku: code,
    model: code,
    brand,
    qty: null,
    source: "U",
  }));
}

export function cartFromThread(history, latest = "") {
  const items = itemsFromModelsInThread(history, latest);
  for (const line of users(history, latest)) {
    const qty = eachQty(line);
    if (qty) {
      items.forEach((item) => { item.qty = qty; });
      continue;
    }
    for (const name of productsInText(line)) {
      if (!items.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        items.push({ name, qty: null, sku: "", source: "U" });
      }
    }
  }
  return items;
}

const NON_NAME_WORDS = /^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|hi|hey|hello|thanks|thank you|please|call|text|email|phone|cell|i need|need|needs|how much|what|which|who|where|when|why|can you|do you|looking|just|bare|kit|both|all|tool|tools|saw|saws|drill|drills|grinder|hammer|driver|ladder|glove|gloves|blade|blades|bit|bits|battery|batteries|charger|wood|concrete|metal|steel|pvc|framing|cutting|drilling|dewalt|milwaukee|makita|bosch|cordless|corded|quote|pricing|delivery|pickup|everything|nothing|something|anything|correct|right|sure|good|great|fine|done|ready)\b/i;
const PHRASE_NON_NAME = /^(?:a|an|the|for|looking|trying|working|cutting|drilling|framing|building|ordering|needing|wanting|interested|comparing|just|only|doing|using|not|here|all|everything|nothing|something|anything|good|great|fine|okay|ok|ready|done|set|homeowner|contractor|sure|yes|yeah|yep|yup|no|nope|going|asking|wondering|checking|shopping|pricing|quoting)\b/i;
const TOOL_OR_TRADE_WORD = /\b(?:saw|saws|drill|drills|grinder|grinders|hammer|hammers|driver|drivers|ladder|ladders|glove|gloves|blade|blades|bit|bits|battery|batteries|charger|chargers|tool|tools|kit|bare|cordless|corded|wood|concrete|metal|steel|pvc|framing|cutting|drilling|dewalt|milwaukee|makita|bosch|flexvolt|brushless|fuel|quote|pricing|order|job|jobsite|crew|company|contractor|homeowner|delivery|warehouse)\b/i;

export function readIdentity(history, latest = "") {
  const identity = { name: "", first: "", company: "", phone: "", email: "", knowsZach: false, note: "" };
  const entries = [...(history || [])];
  if (latest) entries.push({ role: "user", content: latest });
  let prevAssistant = "";
  for (const entry of entries) {
    if (entry?.role === "assistant") {
      prevAssistant = String(entry.content || "");
      continue;
    }
    if (entry?.role !== "user") continue;
    const line = String(entry.content || "");
    if (!line.trim()) continue;
    const email = line.match(/\b[\w.+-]+@[\w.-]+\.\w+\b/);
    const phone = line.match(/(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/);
    if (email) identity.email = email[0];
    if (phone) identity.phone = phone[0];
    if (/\bzach knows me\b|\bknows zach\b/i.test(line)) {
      identity.knowsZach = true;
      identity.note = identity.note || "Zach knows me";
      const before = line.replace(/\bzach knows me\b|\bknows zach\b/ig, " ").replace(/\s+/g, " ").trim();
      if (before) identity.name = titleName(before);
    }
    const explicitNamed = line.match(/\b(?:my name is|name\s*:)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})/i);
    const introNamed = line.match(/\b(?:i['’]?m|i am|this is)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})/i);
    const introCandidate = introNamed?.[1] || "";
    const introValid = introCandidate
      && !PHRASE_NON_NAME.test(introCandidate)
      && !TOOL_OR_TRADE_WORD.test(introCandidate);
    const namedValue = explicitNamed?.[1] || (introValid ? introCandidate : "");
    const hasContact = Boolean(email || phone);
    const beforeContact = hasContact
      ? line.match(/^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,4})\s*(?:[,;|\-]|\s+(?=(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}|[\w.+-]+@)))/)
      : null;
    const askedForName = /\b(?:what['’]?s|what is|share|give me|need)\s+your\s+name\b|\bname\s+and\s+(?:a\s+)?(?:phone|cell|email)\b/i.test(prevAssistant);
    const bareName = askedForName && !hasContact && !/[?\d]/.test(line) && line.trim().split(/\s+/).length <= 3
      ? line.trim().match(/^([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2})$/)
      : null;
    const candidate = namedValue || (!identity.knowsZach ? (beforeContact?.[1] || bareName?.[1]) : "") || "";
    const picked = candidate.replace(/\s+(zach|and|at|phone|cell|email)$/i, "").trim();
    if (picked && !/yorktown|george|washington/i.test(picked) && !NON_NAME_WORDS.test(picked) && !TOOL_OR_TRADE_WORD.test(picked)) {
      identity.name = titleName(picked);
    }
    const company = line.match(/\bat\s+([A-Za-z][A-Za-z0-9&.' -]+?)(?:,|$)/i);
    if (company && !/zach/i.test(company[1]) && !/^\d[-\d\s().]+$/.test(company[1].trim())) identity.company = company[1].trim();
  }
  identity.first = identity.name.split(/\s+/)[0] || "";
  return identity;
}

export function fallbackItemsFromThread(history, latest = "") {
  const list = cartFromThread(history, latest);
  if (list.length) return list;
  const skip = /^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|hi|hey|hello|thanks|thank you|correct|looks good|looks right|that looks right|that.?s right|nothing else|that.?s all|this is everything|just that|no accessories|bare tool|please send(?: the quote| it)?|send it)\.?$/i;
  const candidates = [];
  for (const raw of users(history, latest)) {
    const stripped = raw
      .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, " ")
      .replace(/(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\b\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, " ")
      .replace(/\b(?:i['’]?m|i am|my name is|this is)\s+[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,2}/gi, " ")
      .replace(/\bzach knows me\b|\bknows zach\b/gi, " ")
      .replace(/^[,;\s-]+|[,;\s-]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped || stripped.length < 3 || skip.test(stripped)) continue;
    // Skip lines that look purely like a person name (no tool/number words, right with contact)
    if (stripped !== raw.trim() && stripped.split(/\s+/).length <= 3 && !/\d|drill|saw|grinder|hammer|wheel|blade|bit|glove|ladder|battery|kit|tool|lift|jack/i.test(stripped)) continue;
    candidates.push(stripped);
  }
  if (!candidates.length) return [];
  const label = candidates.join("; ").slice(0, 140);
  return [{ name: label, qty: null, sku: "", source: "U", needs_verification: true }];
}

export function askedForReach(history) {
  return (history || []).some((entry) => entry.role === "assistant" && /best cell or email/i.test(entry.content || ""));
}

function titleName(value) {
  return String(value || "").toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function lastNameReply() {
  return LAST_NAME_LINE;
}

export function washingtonReply() {
  return lastNameReply();
}

export function isLastNameAsk(text, history = []) {
  const raw = String(text || "").trim();
  if (/\blast name\b/i.test(raw)) return true;
  if (/\bwhat(?:'s| is) your name\b/i.test(raw) && /last/i.test(raw)) return true;
  const prior = (history || []).some((entry) => entry.role === "assistant" && /just go by George/i.test(entry.content || ""));
  return prior && /^(washington|just george)\b/i.test(raw);
}

function parseBladeSize(blob) {
  const frac = blob.match(/(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)/);
  if (frac) return `${frac[1]}-${frac[2]}/${frac[3]}`;
  const dec = blob.match(/\b(6\.5|7\.25|10\.25|5\.5|6|7|8|10)\s*(?:"|in(?:ch(?:es)?)?\b)?/i);
  if (!dec) return "";
  const map = { "6.5": "6-1/2", "7.25": "7-1/4", "10.25": "10-1/4", "5.5": "5-1/2" };
  return map[dec[1]] || dec[1];
}

export function sawAttributes(history, latest = "") {
  const blob = normalizeTrade(userBlob(history, latest));
  const voltage = /60\s*v|flexvolt/i.test(blob) ? "60V" : (/\b20\s*v\b/i.test(blob) ? "20V" : "");
  const noBrake = /\b(?:no|without)\s+(?:a\s+)?brake\b/i.test(blob);
  const cordless = /\bcordless\b|\b20\s*v\b|\b60\s*v\b|flexvolt|\bbare\b|\bkit\b/i.test(blob) && !/\bcorded\b/i.test(blob);
  return {
    circular: /\b(?:circ(?:ular)?\s+saws?)\b/i.test(blob),
    brand: (blob.match(new RegExp(`\\b(${BRANDS})\\b`, "gi")) || []).pop()?.toLowerCase() || "",
    cordless,
    corded: /\bcorded\b/i.test(blob),
    voltage,
    size: parseBladeSize(blob),
    brake: /\bbrake\b/i.test(blob) && !noBrake,
    use: /\b(wood|framing|plywood|lumber|metal|steel|concrete|masonry)\b/i.test(blob) ? blob.match(/\b(wood|framing|plywood|lumber|metal|steel|concrete|masonry)\b/i)[1].toLowerCase() : "",
    bare: /\bbare\b/i.test(String(latest || "")),
    kit: /\bkit\b/i.test(String(latest || "")),
  };
}

export function sawGuide(history, latest = "") {
  const attrs = sawAttributes(history, latest);
  if (!attrs.circular || attrs.brand !== "dewalt") return null;
  if (/\bDCS577/i.test(String(latest || ""))) return null;
  const askedBefore = (pattern) => (history || []).some((entry) => entry.role === "assistant" && pattern.test(entry.content || ""));
  let next = "";
  if (!attrs.size) {
    if (askedBefore(/what blade size do you want/i)) return null;
    next = "We can source a DeWalt circular saw, and our team confirms sourcing and lead time. What blade size do you want, and do you want a brake?";
  } else if (!attrs.cordless && !attrs.corded) {
    if (askedBefore(/corded or cordless\?/i)) return null;
    next = `DeWalt, ${attrs.size} in.${attrs.brake ? " with a brake" : ""}. Corded or cordless?`;
  } else if (attrs.cordless && !attrs.voltage) {
    if (askedBefore(/20V MAX or 60V FLEXVOLT/i)) return null;
    next = "Cordless DeWalt. Do you want 20V MAX or 60V FLEXVOLT?";
  } else if (attrs.voltage === "60V" && attrs.size === "8-1/4") {
    if (attrs.bare) return null;
    if (attrs.kit && !attrs.bare) {
      if (askedBefore(/The kit in that family/i)) return null;
      next = "The kit in that family is the DeWalt DCS577X1. How many do you want?";
    } else if (!askedBefore(/DCS577 family/i)) {
      next = "That's a DeWalt 60V MAX FLEXVOLT 8-1/4 in. cordless circular saw with a brake, in the DCS577 family. The DCS577B is the bare tool and the DCS577X1 is the kit. Which one do you want, and how many?";
    } else if (attrs.use && !askedBefore(/bare tool \(DCS577B\)/i)) {
      next = "Got it, for cutting that with the DeWalt 60V 8-1/4 in. saw, do you want the bare tool (DCS577B) or the kit (DCS577X1), and how many?";
    }
  } else if (!attrs.use && !askedBefore(/what are you cutting\?/i)) {
    const bits = [`DeWalt ${attrs.size} in.`, attrs.cordless ? "cordless" : "corded", attrs.brake ? "with a brake" : ""].filter(Boolean);
    next = `${bits.join(" ")}. What are you cutting?`;
  }
  return next || null;
}

export function listReadback(items, history = []) {
  const names = (items || []).filter((item) => item?.name);
  if (!names.length) return "";
  const read = names.map((item) => `${item.qty || 1} × ${item.name}`).join(", ");
  const team = names.length > 1 ? "Those are for our team to price." : "That one's for our team to price.";
  const next = intakeReadyForContact(history, items)
    ? CONTACT_ASK_LINE
    : (nextIntakeQuestion(history, items) || CONTACT_ASK_LINE);
  return `I have ${read}. ${team} ${next}`;
}

function itemRead(items) {
  const named = (items || []).filter((item) => item?.name);
  if (!named.length) return "";
  return named.map((item) => `${item.qty || 1} × ${item.name}`).join(", ");
}

export function readyClose(identity, alreadyAsked, items = [], history = []) {
  const read = itemRead(items);
  const list = read ? ` I have ${read}.` : "";
  if (identity.knowsZach) {
    const who = identity.first ? `Thanks, ${identity.first}. ` : "";
    if (identity.phone || identity.email) {
      return read ? `I have ${read}. I'll note that he knows you. I can send this to our team.` : "I'll note that he knows you. I can send this to our team.";
    }
    return `${who}I'll note that he knows you.${list} What's the best cell or email so we can reach you?`;
  }
  if (!intakeReadyForContact(history, items)) {
    const next = nextIntakeQuestion(history, items, identity);
    return `${read ? `I have ${read}. ` : ""}${next || HANDOFF_LINE}`;
  }
  if (identity.phone || identity.email) {
    const next = nextIntakeQuestion(history, items, identity);
    if (next) return `${read ? `I have ${read}. ` : ""}${next}`;
    return read ? `I have ${read}. I can send this to our team.` : "I can send this to our team.";
  }
  return `${read ? `I have ${read}. ` : ""}${CONTACT_ASK_LINE}`;
}
