/**
 * Server-only cost loader. Do not import this from george.js or any file the
 * browser loads. Do not put real costs in this file. The live numbers belong
 * in the Worker secret PRIVATE_COSTS_JSON.
 *
 * Shape, keyed by catalog sku:
 * { "EXAMPLE-SKU": { "privateCost": 1.23, "costSource": "example" } }
 * privateCost is what we pay. costSource is an internal label such as "example".
 * Neither is shown to the customer. 1.23 is a fake placeholder, not a real cost.
 *
 * If the secret is missing or is not valid JSON, pricing ignores private cost
 * and uses the shelf rules.
 */

export const EXAMPLE_PRIVATE_COSTS = {
  "EXAMPLE-SKU": {
    privateCost: 1.23,
    costSource: "example",
  },
};

export function loadPrivateCosts(jsonText) {
  if (jsonText == null || !String(jsonText).trim()) return {};
  try {
    const parsed = JSON.parse(String(jsonText));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function privateCostFor(sku, costs) {
  const table = costs && typeof costs === "object" && !Array.isArray(costs) ? costs : {};
  const key = String(sku || "").trim().toUpperCase();
  if (!key) return null;
  const row = Object.entries(table).find(([name]) => String(name).toUpperCase() === key)?.[1];
  const cost = Number(row?.privateCost);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}
