/** Trade shorthand, slang, and misspellings. Maps the customer's words, never a different brand or model. */

const BRANDS = [
  { id: "dewalt", label: "DeWalt", aliases: ["dewalt", "duwalt", "dewault", "dewalts"] },
  { id: "milwaukee", label: "Milwaukee", aliases: ["milwaukee", "milwalkee", "milwakee"] },
  { id: "makita", label: "Makita", aliases: ["makita", "makitta"] },
  { id: "ridgid", label: "Ridgid", aliases: ["ridgid", "rigid"] },
  { id: "ryobi", label: "Ryobi", aliases: ["ryobi", "ryobe"] },
  { id: "bosch", label: "Bosch", aliases: ["bosch"] },
  { id: "skil", label: "Skil", aliases: ["skil"] },
  { id: "hilti", label: "Hilti", aliases: ["hilti"] },
  { id: "festool", label: "Festool", aliases: ["festool"] },
  { id: "metabo", label: "Metabo", aliases: ["metabo"] },
  { id: "hercules", label: "Hercules", aliases: ["hercules"] },
  { id: "kobalt", label: "Kobalt", aliases: ["kobalt"] },
];

const TOOLS = [
  { name: "Circular saw", aliases: ["circular saw", "circ saw", "skilsaw", "skil saw", "cirular saw", "sircular saw", "circularsaw"] },
  { name: "Reciprocating saw", aliases: ["reciprocating saw", "sawzall", "sawzaw", "sawsall", "recip saw", "recip"] },
  { name: "Impact driver", aliases: ["impact driver", "impack driver", "impactdriver"] },
  { name: "Impact wrench", aliases: ["impact wrench"] },
  { name: "Hammer drill", aliases: ["hammer drill", "hammerdril", "hammerdrill"] },
  { name: "Grinder", aliases: ["grinder", "grinderr", "angle grinder"] },
  { name: "Oscillating multi-tool", aliases: ["oscillating multi-tool", "multi-tool", "multitool", "oscillating tool", "oscillating", "ox"] },
  { name: "Miter saw", aliases: ["miter saw", "chop saw"] },
  { name: "Jackhammer", aliases: ["jackhammer", "jack hammer", "jakhammer", "demo hammer", "demolition hammer"] },
  { name: "Chainsaw", aliases: ["chainsaw", "chain saw"] },
  { name: "Safety glasses", aliases: ["safety glasses"] },
  { name: "Hi-vis", aliases: ["hi-vis", "hivis", "hi vis", "high vis"] },
  { name: "Gloves", aliases: ["gloves", "gloces", "glove"] },
  { name: "Respirator", aliases: ["respirator", "respirater"] },
  { name: "Ladder", aliases: ["ladder", "lader", "latter"] },
  { name: "PPE", aliases: ["ppe"] },
];

const MODELS = [
  { code: "DCS577", brand: "DeWalt", label: "DeWalt DCS577" },
  { code: "DCS577B", brand: "DeWalt", label: "DeWalt DCS577B" },
  { code: "DCS577X1", brand: "DeWalt", label: "DeWalt DCS577X1" },
  { code: "DCF887", brand: "DeWalt", label: "DeWalt DCF887" },
  { code: "DCF887B", brand: "DeWalt", label: "DeWalt DCF887B" },
  { code: "DCD996B", brand: "DeWalt", label: "DeWalt DCD996B" },
  { code: "DCD771C2", brand: "DeWalt", label: "DeWalt DCD771C2" },
  { code: "D25133K", brand: "DeWalt", label: "DeWalt D25133K" },
  { code: "5007FA", brand: "Makita", label: "Makita 5007FA" },
];

const SKIP = new Set(["need", "have", "with", "brake", "wood", "each", "just", "that", "this", "from", "your", "what", "when", "tool", "only", "bare", "volt", "inch", "want", "like", "does", "stock", "price", "quote", "about", "thanks", "thabks"]);

export function damerau(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[left.length][right.length];
}

function maxDistance(token) {
  if (token.length >= 8) return 2;
  if (token.length >= 5) return 1;
  return 0;
}

function bestMatch(token, entries, labelOf) {
  const needle = String(token || "").toLowerCase();
  if (!needle || SKIP.has(needle)) return { match: null, ambiguous: false };
  let best = null;
  let bestDist = 99;
  let tie = false;
  for (const entry of entries) {
    const names = entry.aliases || [entry.id];
    for (const name of names) {
      const dist = name === needle ? 0 : damerau(needle, name);
      const limit = name === needle ? 0 : maxDistance(needle);
      if (dist > limit && dist !== 0) continue;
      if (dist < bestDist) {
        best = entry;
        bestDist = dist;
        tie = false;
      } else if (dist === bestDist && labelOf(entry) !== labelOf(best)) {
        tie = true;
      }
    }
  }
  if (!best || tie) return { match: null, ambiguous: tie };
  return { match: best, ambiguous: false };
}

export function canonicalBrand(text) {
  const raw = String(text || "").toLowerCase();
  let found = "";
  const tokens = raw.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  for (const token of tokens) {
    if (/\d/.test(token)) continue;
    const hit = bestMatch(token, BRANDS, (entry) => entry.id);
    if (hit.match) found = hit.match.id;
  }
  return found;
}

export function brandLabel(id) {
  return BRANDS.find((entry) => entry.id === id)?.label || "";
}

export function normalizeTrade(text) {
  let raw = String(text || "").toLowerCase();
  raw = raw.replace(/\bw\/\s*/g, "with ");
  raw = raw.replace(/\beight and a quarter\b/g, "8-1/4");
  raw = raw.replace(/\bseven and a quarter\b/g, "7-1/4");
  raw = raw.replace(/\bfour and a half\b/g, "4-1/2");
  raw = raw.replace(/\btool only\b/g, "bare");
  raw = raw.replace(/\bflex\s*volts?\b|\bflexvolt\b/g, "60v flexvolt");
  if (/\b(?:circular saw|saw|drill|grinder)\b/.test(raw) && /\bflex\b/.test(raw)) {
    raw = raw.replace(/\bflex\b/g, "60v flexvolt");
  }
  raw = raw.replace(/\b20\s*-?\s*volts?\b/g, "20v");
  raw = raw.replace(/\b60\s*-?\s*volts?\b/g, "60v");
  raw = raw.replace(/\b5\s*ah\s*batts?\b/g, "5ah battery");
  raw = raw.replace(/\bthabks\b|\bthanx\b|\bthx\b/g, "thanks");
  const phrases = TOOLS.flatMap((tool) => tool.aliases.map((alias) => ({ alias, name: tool.name.toLowerCase() })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const phrase of phrases) {
    raw = raw.replace(new RegExp(`\\b${phrase.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), phrase.name);
  }
  raw = raw.replace(/(?<!circuit\s)\bbreakers?\b/g, "jackhammer");
  const tokens = raw.split(/([^a-z0-9]+)/);
  const rewritten = tokens.map((token) => {
    if (!/^[a-z]{5,}$/.test(token) || SKIP.has(token)) return token;
    const brand = bestMatch(token, BRANDS, (entry) => entry.id);
    if (brand.match && !brand.ambiguous) return brand.match.id;
    const tool = bestMatch(token, TOOLS, (entry) => entry.name);
    if (tool.match && !tool.ambiguous) return tool.match.name.toLowerCase();
    return token;
  });
  return rewritten.join("").replace(/[ \t]+/g, " ").trim();
}

export function modelCandidates(token) {
  const code = String(token || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 5 || !/\d{3,}/.test(code)) return [];
  const exact = MODELS.filter((model) => model.code === code);
  if (exact.length) return exact.map((model) => ({ ...model, distance: 0 }));
  return MODELS.map((model) => ({ ...model, distance: damerau(code, model.code) }))
    .filter((model) => model.distance > 0 && model.distance <= (code.length >= 7 ? 2 : 1))
    .sort((a, b) => a.distance - b.distance);
}

export function interpretLine(text) {
  const normalized = normalizeTrade(text);
  const tools = [];
  const seen = new Set();
  for (const tool of TOOLS) {
    const name = tool.name.toLowerCase();
    const boundary = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
    if (!boundary.test(normalized) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const sized = tool.name === "Grinder" && /4-1\/2/.test(normalized) ? "4-1/2 in. grinder" : tool.name;
    tools.push({ name: sized });
  }
  if (/\b(?:boom|man)\s+lifts?\b|\b\d+(?:\.\d+)?\s*(?:ft|foot|feet)\s+lifts?\b/.test(normalized)) {
    const lift = normalized.match(/(\d+(?:\.\d+)?)\s*(?:ft|foot|feet)\s+(?:boom\s+|man\s+)?lifts?/);
    const name = lift?.[1] ? `${lift[1]} ft lift` : "Lift";
    if (!tools.some((tool) => /lift/i.test(tool.name))) tools.push({ name });
  }
  if (/\b5ah battery\b/.test(normalized) && !tools.some((tool) => /battery/i.test(tool.name))) {
    tools.push({ name: "5Ah battery" });
  }
  let clarify = "";
  if (/\bimpact\b/.test(normalized) && !/impact driver|impact wrench/.test(normalized)) {
    clarify = "Impact driver or impact wrench?";
  } else if (/^flex$/.test(normalized) || (/\bflex\b/.test(String(text || "").toLowerCase()) && !/flexvolt|60v|circular saw|saw/.test(normalized))) {
    if (!/flexvolt|60v/.test(normalized)) clarify = clarify || "Do you mean FlexVolt, or the Flex brand?";
  }
  const codes = String(text || "").toUpperCase().match(/\b[A-Z]{0,6}\d{3,}[A-Z0-9]*\b/g) || [];
  let confirm = "";
  let model = null;
  for (const code of codes) {
    const candidates = modelCandidates(code);
    if (!candidates.length) continue;
    if (candidates[0].distance === 0 && candidates.length === 1) {
      model = candidates[0];
      continue;
    }
    const closest = candidates.filter((item) => item.distance === candidates[0].distance);
    if (closest.length === 1) confirm = `Did you mean the ${closest[0].label}?`;
    else confirm = `Did you mean the ${closest.map((item) => item.label).join(" or the ")}?`;
    model = closest[0];
    break;
  }
  return { normalized, tools, clarify, confirm, model, brand: canonicalBrand(normalized) };
}

export function pendingModelConfirm(history) {
  const prior = [...(history || [])].reverse().find((entry) => entry.role === "assistant")?.content || "";
  const match = prior.match(/Did you mean the ([A-Za-z]+)\s+([A-Z0-9]+)\?/i);
  if (!match) return null;
  return { brand: match[1], code: match[2].toUpperCase(), label: `${match[1]} ${match[2].toUpperCase()}` };
}

export function acceptsModel(text) {
  return /^(yes|yeah|yep|yup|that one|that's the one|thats the one|correct)\b/i.test(String(text || "").trim());
}

export function isThanks(text) {
  return /^(thanks|thank you|thabks|thanx|thx|ty)[.!]?$/i.test(String(text || "").trim());
}
