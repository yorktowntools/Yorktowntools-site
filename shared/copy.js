/** Customer-facing lines. Do not mention retailers, cost, or margin here. */

export const PHONE_DISPLAY = "(757) 940-5171";
export const PHONE_TEL = "+17579405171";
export const SALES_EMAIL = "sales@yorktowntools.com";
export const HOURS = "Monday–Friday, 8:00 AM – 5:00 PM Eastern";
export const SERVICE_AREA = "Richmond to Virginia Beach, including Hampton Roads and the military bases";

export const GREETING = "Hey, I’m George. Welcome to Yorktown Tools. What tools are you looking for?";

export const DELIVERY_LINE =
  "Delivery is free with no minimum, to jobsites, shops, and warehouses, on and off military installations. Free local delivery covers Richmond to Virginia Beach.";

export const LINE_CARD_URL = "https://yorktowntools.com/Yorktown-Tools-Line-Card-2026.pdf";

export const HANDOFF_LINE = "I can send this to our team once I have your name and a cell or email.";

export const CONTACT_ASK_LINE =
  "What's your name, and a company name if you have one, plus the best phone number or email to reach you?";

export const SCAM_CLOSE = "We're only able to serve local customers right now.";

export const CLOSING_LINE = "Tools Worth Fighting For!";

export const LAST_NAME_LINE = "I’m an AI assistant, so I just go by George.";

export const PRICING_LINE =
  "We provide free quotes. I’ll get the details to our team so they can put pricing together for you.";

export const LEAD_SUCCESS_LINE =
  "You’re all set. A member of our Yorktown Tools team will review your request and follow up with pricing and availability. If you need help sooner, call or text 757-940-5171.";

export const LEAD_FAILURE_LINE =
  "I wasn’t able to send your request to our team from here, and I don’t want it to get lost. Please text or email your list to 757-940-5171 or sales@yorktowntools.com and they’ll follow up with pricing and availability.";

export const READY_LINE = LEAD_SUCCESS_LINE;


export function hasLeadSuccess(text) {
  return /you['’]re all set/i.test(String(text || ""))
    && /member of our yorktown tools team will review/i.test(String(text || ""));
}

export function stripLeadSuccess(text) {
  return String(text || "")
    .replace(/you['’]re all set\.\s*a member of our yorktown tools team will review your request and follow up with pricing and availability\.\s*if you need help sooner, call or text 757-940-5171\.?/gi, "")
    .replace(/you['’]re all set\.\s*a yorktown tools specialist will reach out shortly\.?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ensureSingleSuccess(text) {
  const stripped = stripLeadSuccess(text);
  const has = /you['’]re all set/i.test(String(text || ""));
  if (!has && !stripped) return String(text || "").trim();
  if (!has) return String(text || "").trim();
  return stripped ? `${stripped}\n\n${LEAD_SUCCESS_LINE}` : LEAD_SUCCESS_LINE;
}

export function productListText(items = []) {
  return (items || [])
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const name = [item.brand, item.product || item.name, item.model || item.sku].filter(Boolean).join(" ").trim()
        || item.name || item.product || "";
      if (!name) return "";
      const qty = Object.prototype.hasOwnProperty.call(item, "qty") && item.qty != null && item.qty !== ""
        ? `${item.qty} × `
        : "";
      return `${qty}${name}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

export function leadFailureReply(items = []) {
  const list = productListText(items);
  return list ? `${LEAD_FAILURE_LINE}\n\n${list}` : LEAD_FAILURE_LINE;
}


export const LOCATION_LINE = "We are a B2B company based out of Yorktown, Virginia.";

export const BULK_LINE =
  "For a larger list, our team will put together a free quote. Bulk pricing is handled by the team.";

export const CONFIRM_PRICE = "Our team will put a free quote together for you.";

export const AFTER_HOURS_LINE =
  "It's outside business hours. We'll get back to you by 9 a.m. the next business day.";

export const SAFE_COST_REPLY =
  "I don't get into what we pay or how a price is built. " + PRICING_LINE;

export const SAFE_RETAILER_REPLY =
  "I can help you build a list for a free Yorktown Tools quote. Tell me the brand, model, and quantity, and we'll take it from there. Delivery to the job site is free.";

export const ESTIMATE_NOTE = "";

export const CREDIT_APP_URL =
  "https://yorktowntools.com/yorktown%20tools%20credit%20application.pdf";

export const CONSIGNMENT_URL = "https://yorktowntools.com/Consignment-Card.pdf";

export const CATEGORIES = [
  { name: "Precision hand tools", path: "/precision-hand-tools.html" },
  { name: "Power tools", path: "/Power-tools.html" },
  { name: "Portable power (Jackery)", path: "/portable-power.html" },
  { name: "Measuring and layout", path: "/Measuring%20tools.html" },
  { name: "Bits, blades, and abrasives", path: "/Bits-blades.html" },
  { name: "Storage and organization", path: "/Storage-organization.html" },
  { name: "Safety and PPE", path: "/Safety-PPE.html" },
  { name: "Ladders (Werner)", path: "/Ladders.html" },
  { name: "Victory Series gloves", path: "/victory-gloves.html" },
  { name: "Swag", path: "/swag.html" },
  { name: "Contact and service area", path: "/contact.html" },
  { name: "About", path: "/about.html" },
];
