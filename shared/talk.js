import { matchCatalog } from "./pricing.js";

const GENERIC = new Set(["drill", "drills", "saw", "saws", "ladder", "ladders", "glove", "gloves", "tool", "tools", "bit", "bits", "blade", "blades"]);

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 3);
}

export function isSpecificAsk(text, catalog) {
  const raw = String(text || "");
  const norm = raw.toLowerCase();
  if (/\bvictory\b/.test(norm) && /\bgloves?\b/.test(norm)) return true;
  const hits = matchCatalog(catalog, raw);
  if (!hits.length) return false;
  const queryTokens = tokens(raw);
  return hits.some((item) => {
    const sku = String(item.sku || "").toLowerCase();
    const model = String(item.model || "").toLowerCase();
    if (sku && norm.includes(sku)) return true;
    if (model && model.length > 8 && norm.includes(model)) return true;
    const overlap = tokens(item.name).filter((word) => queryTokens.includes(word));
    const distinctive = overlap.filter((word) => !GENERIC.has(word));
    return distinctive.length >= 1 && overlap.length >= 2;
  });
}

function userBlob(message, history) {
  const prior = (history || []).filter((entry) => entry.role === "user").map((entry) => entry.content || "");
  return [...prior, message].filter(Boolean).join("\n");
}

function lastAssistant(history) {
  return [...(history || [])].reverse().find((entry) => entry.role === "assistant");
}

export function isShortReply(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 48) return false;
  return /^(yes|yeah|yep|sure|no|nope|nah|ok|okay|please|just one|one|two|three|white|a case|a pair|\d{1,4})$/i.test(value);
}

export function acceptingQuote(message, history) {
  const value = String(message || "").trim();
  const agrees = /^(yes|yeah|yep|sure|ok|okay|do it|sounds good)\b/i.test(value) || /^please[.!]?$/i.test(value);
  return agrees && /quote together/i.test(lastAssistant(history)?.content || "");
}

export function concreteDrillingAdvice(text) {
  const raw = String(text || "");
  const drilling = /\b(drill|drilling|bore|boring|core)\b/i.test(raw);
  const concrete = /\bconcrete\b/i.test(raw);
  const sized = /\brebar\b/i.test(raw)
    || /1\s*[- ]\s*1\/2|1\.5/i.test(raw)
    || /\b\d+\s*(?:["”]|in(?:ch(?:es)?)?)\b/i.test(raw);
  if (!drilling || !concrete || !sized) return "";
  return "For a 1-1/2 inch hole through 9 inches of concrete with rebar, use an SDS-Max rotary hammer (a DeWalt D25614K-class tool) or a core drill. Use a 1-1/2 inch SDS-Max bit at least 13 inches long, and a rebar cutter bit if you hit rebar. Do you already have an SDS-Max hammer?";
}

export function genericSawQuestion(text) {
  const raw = String(text || "");
  if (/\b[a-z]{1,6}\d{3,}[a-z0-9-]*\b/i.test(raw)) return "";
  if (!/\b(sawzalls?|sawzaws?|reciprocating(?:\s+saws?)?)\b/i.test(raw)) return "";
  return "Which model do you want, or do you want it cordless or corded?";
}

export function drillTurn(message, history) {
  const latest = String(message || "");
  if (concreteDrillingAdvice(latest)) return null;
  const blob = userBlob(latest, history);
  if (!/\bdrills?\b|\bhammer drill\b/i.test(blob)) return null;
  if (/\b[a-z]{0,6}\d{3,}[a-z0-9-]*/i.test(latest)) return null;
  const use = /\b(concrete|masonry|wood|steel|metal|anchor|tapcon|drywall|deck|brick)\b/i.test(blob);
  const power = /\b(corded|cordless|plug-?in|battery)\b/i.test(blob);
  const brand = /\b(dewalt|milwaukee|makita|bosch|ridgid|don't care|dont care|do not care|no preference|any brand)\b/i.test(blob);
  const voltage = /\b(12v|18v|20v|36v|40v|m12|m18|flexvolt)\b/i.test(blob);
  const cordless = /\b(cordless|battery)\b/i.test(blob) && !/\bcorded\b/i.test(blob);
  if (!use) return { stage: "clarify", reply: "Okay, what are you using the drill for?" };
  if (!power || !brand) {
    return {
      stage: "clarify",
      reply: "Okay, are you looking for corded or cordless? And do you have a specific brand or model in mind, or should I suggest a few?",
    };
  }
  if (cordless && !voltage) {
    return { stage: "clarify", reply: "Okay, what voltage or battery platform are you on?" };
  }
  return { stage: "recommend" };
}

export function clarifyingQuestion(message, history) {
  const drill = drillTurn(message, history);
  if (drill?.stage === "clarify") return drill.reply;
  const text = String(message || "");
  if (/\bgloves?\b/i.test(text) && !/\bvictory\b/i.test(text)) {
    return "Okay, are these for driving, cold weather, or cut protection? And how many pairs?";
  }
  if (/\bsaws?\b/i.test(text) && !/\bcircular\b/i.test(text)) {
    return "Okay, what are you cutting, and do you have a brand or model in mind?";
  }
  if (/\bladders?\b/i.test(text) && !/\b(foot|ft|type ia|type i)\b/i.test(text)) {
    return "Okay, what height and duty rating do you need?";
  }
  if (/\b(jackery|power station)\b/i.test(text) && !/\d/.test(text)) {
    return "Okay, what capacity do you need, and is this for tools on the job or just charging batteries?";
  }
  return "Okay, what are you using it for, and do you have a brand or model in mind?";
}

const VAGUE_TOOL = /\b(drills?|saws?|ladders?|gloves?|batter(?:y|ies)|blades?|bits?|wrenches?|grinders?|nailers?)\b/i;
const NAMED_POWER = /\b(dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid|skil|flex|hercules|kobalt|sds|rotary hammers?|angle grinders?|heat guns?|impact drivers?)\b/i;

export function chatStage(message, history, catalog) {
  const latest = String(message || "").trim();
  if (acceptingQuote(latest, history)) return "form";
  if (concreteDrillingAdvice(latest)) return "quote";
  const drill = drillTurn(latest, history);
  if (drill?.stage === "clarify") return "clarify";
  if (drill?.stage === "recommend") return "recommend";
  const blob = userBlob(latest, history);
  if (isSpecificAsk(latest, catalog) || isSpecificAsk(blob, catalog)) return "quote";
  if ((VAGUE_TOOL.test(latest) || VAGUE_TOOL.test(blob)) && !NAMED_POWER.test(latest)) return "clarify";
  return "chat";
}
