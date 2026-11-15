/**
 * Server-only costs. Do not import this from george.js, shared browser code,
 * or data/prices.json. The public catalog never carries these numbers.
 * privateCost is what we pay. costSource is who we pay. Neither word, nor the
 * source name, goes to the customer.
 *
 * Price rule, applied in worker/src/policy.js:
 * candidate = privateCost × privateMarkup (1.20).
 * If that candidate is at or below the shelf and the margin is at least 10%,
 * the quote is the lower of the shelf and the candidate.
 * If the cost is above the shelf, or the margin would be under 10%, ignore
 * this cost and use the shelf only when the usual 10% cost assumption still
 * clears 10% margin. Otherwise the customer hears "We'll confirm the price."
 */

export const privateCosts = {
  "DAP-ALEX-PLUS-12": {
    privateCost: 58.37,
    costSource: "ors",
    sourceSku: "802-18152",
  },
  // Catalog saw is the 5007FA. The supplier item we were given is the 5007F.
  "5007FA": {
    privateCost: 212.31,
    costSource: "ors",
    sourceSku: "5007F",
  },
  // Jackery dealer cost. Add privateCost when a model’s cost is known.
  // costSource stays here. It is not a customer-facing word.
  JACKERY: {
    privateCost: null,
    costSource: "dealer",
  },
};

export function privateCostFor(sku) {
  const key = String(sku || "").trim().toUpperCase();
  if (!key) return null;
  const row = Object.entries(privateCosts).find(([name]) => name.toUpperCase() === key)?.[1];
  const cost = Number(row?.privateCost);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}
