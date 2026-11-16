/**
 * Server-only cost loader. Do not import this from george.js or any file the
 * browser loads. Do not put real costs in this file. The live numbers belong
 * in the Worker secret PRIVATE_COSTS_JSON, or in KV binding
 * PRIVATE_COSTS_KV under the key "costs" when the JSON is too big
 * for a secret. KV wins when that key has text. The secret is the fallback.
 *
 * Shape, keyed by catalog sku:
 * { "EXAMPLE-SKU": { "privateCost": 1.23, "costSource": "example" } }
 * privateCost is what we pay. costSource is optional and defaults to "dealer".
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
    const costs = {};
    for (const [sku, row] of Object.entries(parsed)) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const privateCost = Number(row.privateCost);
      if (!Number.isFinite(privateCost) || privateCost <= 0) continue;
      costs[sku] = {
        privateCost,
        costSource: String(row.costSource || "dealer"),
      };
    }
    return costs;
  } catch {
    return {};
  }
}

export async function readPrivateCosts(env = {}) {
  let text = env?.PRIVATE_COSTS_JSON;
  const kv = env?.PRIVATE_COSTS_KV;
  if (kv && typeof kv.get === "function") {
    try {
      const stored = await kv.get("costs");
      if (stored != null && String(stored).trim()) text = stored;
    } catch {
      // The secret still prices the quote when KV is unreachable.
    }
  }
  return loadPrivateCosts(text);
}

export function privateCostFor(sku, costs) {
  const table = costs && typeof costs === "object" && !Array.isArray(costs) ? costs : {};
  const key = String(sku || "").trim().toUpperCase();
  if (!key) return null;
  const row = Object.entries(table).find(([name]) => String(name).toUpperCase() === key)?.[1];
  const cost = Number(row?.privateCost);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}
