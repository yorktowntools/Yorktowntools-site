/**
 * Adjustable business rules for George.
 * Server-side only. Do not import this file from george.js or anything the
 * browser loads. Do not quote these numbers, costs, or sourcing notes to a
 * customer. The chat and the customer email only get the safe sentences
 * produced by worker/src/policy.js.
 */

export const rules = {
  // Instant quotes match the local big-box shelf price.
  // 0 = match. A number above 0 would sit that percent under the shelf.
  // Anything that would land under minGrossMargin is not shown as a firm price.
  matchPercentBelow: 0,

  // Assumed product cost on big-box items, as a percent under that shelf price.
  // Used only to test the margin floor. Never shown.
  assumedCostBelowShelfPercent: 10,

  // Gross margin floor: (price - cost) / price.
  // At a 0% match and a 10% cost gap, margin is exactly 10%.
  // After a 3% card fee that is about 7% left. If a price would sit under this
  // floor, the customer sees "We'll confirm the price" instead.
  minGrossMargin: 0.10,

  // One-off price from some other local shop (not a national home-improvement
  // chain). 10 means 10% over that shop's price.
  // Shops that price like the national chains (source code C) use matchPercentBelow
  // and the cost assumption above, not this markup.
  otherLocalMarkupPercent: 10,

  // Fuel is baked into item prices when it is large next to the margin.
  // The customer still hears "free job-site delivery". No fuel line on the quote.
  mpg: 16,
  gasPricePerGallon: 3.10,
  // Add fuel when it is more than this share of order margin dollars.
  fuelShareOfMargin: 0.01,
  // Round trip added for a bulk sourcing run. Set this to the real drive.
  // Not a customer-facing location.
  bulkSourcingRoundTripMiles: 360,
  // Used only when the job site text does not match a known city. 0 skips fuel
  // until a city is recognized.
  defaultRoundTripMiles: 0,

  // Bulk is a judgment call. One case is not bulk. Several cases are.
  // One or two tools are not bulk. Five tools are.
  bulkToolQty: 5,
  bulkCaseQty: 2,

  // Virginia / Yorktown sales tax. Government and tax-exempt orders are 0
  // until a certificate is on file. The certificate rule is customer-facing.
  salesTaxRate: 0.07,
  exemptTaxRate: 0,

  // Shown on the quote. Card includes a government purchase card.
  // Fees apply to the merchandise plus tax. A check has no fee.
  cardFeeRate: 0.03,
  achFeeRate: 0.01,
  checkFeeRate: 0,

  timezone: "America/New_York",
  openHour: 8,
  closeHour: 17,
  // After hours, if they ask about hours, George says we'll get back to them by this time
  // the next business day.
  replyByHour: 9,

  // Lead tiers. Tier is internal. It goes on the sales email, not to the customer.
  // 1 = a company that looks like a bulk / ongoing / multi-site account.
  // 2 = another business or a government buyer.
  // 3 = a homeowner or a one-off.
  // A small order is still an instant quote, even from a big company.
  // A bulk order is never a locked price.
};
