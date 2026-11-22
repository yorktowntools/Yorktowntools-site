/**
 * What to offer with a tool, once, when the customer has settled on it.
 * Suggestions are names. Prices still come from the catalog and the private
 * cost rule. No costs live in this file.
 */

export const accessoryRules = [
  {
    id: "jackery",
    test: (text) => /jackery|home\s*power|\bexplorer\s+\d|\bhp\s*\d{3,4}|\be\s*\d{3,4}/i.test(text),
    prompt: "Need a solar panel, or a carrying case and an extra cable, with that?",
    suggestions: [
      { name: "200W Solar Panel", sku: "JACKERY-200W", qty: 1 },
      { name: "Jackery Upgraded Carrying Case (M)", sku: "JACKERY-UPGRADED-CARRYING-CASE-M", qty: 1 },
    ],
  },
  {
    id: "hammer-drill",
    test: (text) => /hammer drill|rotary hammer|\bsds\b/i.test(text),
    prompt: "Need SDS or masonry bits, or anchors, with that?",
    suggestions: [
      { name: "SDS masonry bits", qty: 1 },
      { name: "Concrete anchors", qty: 1 },
    ],
  },
  {
    id: "saw",
    test: (text) => /circular saw|5007|\bsaws?\b/i.test(text) && !/drill/i.test(text),
    prompt: "Need a blade or two with that saw?",
    suggestions: [{ name: "Circular saw blades", qty: 1 }],
  },
  {
    id: "grinder",
    test: (text) => /\bgrinders?\b/i.test(text),
    prompt: "Need discs or wheels with that grinder?",
    suggestions: [{ name: "Grinding discs", qty: 1 }],
  },
  {
    id: "nailer",
    test: (text) => /\bnailers?\b/i.test(text),
    prompt: "Need nails with that?",
    suggestions: [{ name: "Nails", qty: 1 }],
  },
  {
    id: "caulk",
    test: (text) => /\bcaulk\b/i.test(text) && !/gun/i.test(text),
    prompt: "Need a caulk gun with that?",
    suggestions: [{ name: "Caulk gun", qty: 1 }],
  },
  {
    id: "drill",
    test: (text) => /\bdrills?\b/i.test(text) && !/hammer drill|rotary hammer/i.test(text),
    prompt: "Need a bit set with that?",
    suggestions: [{ name: "Driver bits", qty: 1 }],
  },
  {
    id: "cordless",
    test: (text) => /\b(cordless|20v|18v|12v|m12|m18)\b/i.test(text) && !/\bcorded\b/i.test(text),
    prompt: "Need an extra battery or a charger?",
    suggestions: [
      { name: "Extra battery", qty: 1 },
      { name: "Charger", qty: 1 },
    ],
  },
  {
    id: "ladder",
    test: (text) => /\bladders?\b/i.test(text),
    prompt: "Need a stabilizer for the ladder, or are you set?",
    suggestions: [{ name: "Ladder stabilizer", qty: 1 }],
  },
  {
    id: "safety",
    test: (text) => /\b(safety|ppe|hard hat|safety glasses)\b/i.test(text) && !/\b(victory|gloves?)\b/i.test(text),
    prompt: "Need Victory Series gloves with that?",
    suggestions: [{ name: "Victory Series drivers gloves", sku: "VICTORY-GLOVE", qty: 1 }],
  },
];

export function accessoryOffer(text) {
  const raw = String(text || "");
  const hits = accessoryRules.filter((rule) => rule.test(raw));
  const suggestions = [];
  for (const rule of hits) {
    for (const item of rule.suggestions) {
      if (suggestions.length >= 3) break;
      if (!suggestions.some((existing) => existing.name === item.name)) suggestions.push({ ...item });
    }
  }
  if (!suggestions.length) return null;
  const prompt = hits.length === 1
    ? hits[0].prompt
    : `Need ${suggestions.map((item) => item.name.toLowerCase()).join(", ")} with that?`;
  return {
    line: prompt,
    suggestions,
  };
}

export function isAccessoryQuestion(text) {
  const value = String(text || "");
  return /need (a blade|sds or masonry|discs or wheels|nails with|a caulk gun|a bit set|an extra battery|a stabilizer|victory series gloves|a solar panel)/i.test(value)
    || /need .+ with that\?/i.test(value);
}

export function accessoryAsked(history) {
  return (history || []).some((entry) => entry.role === "assistant" && (isAccessoryQuestion(entry.content) || /which ones do you want/i.test(entry.content || "")));
}
