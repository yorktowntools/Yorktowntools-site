import { CREDIT_APP_URL, DELIVERY_LINE, HOURS, PHONE_DISPLAY, PHONE_TEL } from "../../shared/copy.js";
import { escapeHtml, filterCustomerText, isAllowedCustomerUrl } from "../../shared/customer-text.js";
import { formatMoney } from "../../shared/pricing.js";
import { BULK_EMAIL, feeSentence } from "./policy.js";

function clean(value, fallback = "") {
  const text = filterCustomerText(value).text;
  return text || fallback;
}

function link(url, label) {
  if (!isAllowedCustomerUrl(url)) return "";
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function tierLabel(tier) {
  return `Tier ${tier}`;
}

export function buildQuoteEmail({ lead, items, totals, leadInfo, notes = [] }) {
  const name = clean(lead.name, "there");
  const company = clean(lead.company);
  const bulk = Boolean(leadInfo?.bulk);
  const rows = items.map((item) => {
    const label = clean(item.name, "Item");
    const price = bulk || item.confirm || item.estimate == null
      ? (bulk ? "We'll price this" : "We'll confirm the price")
      : `${formatMoney(item.estimate)} estimate`;
    const own = /yorktowntools\.com/i.test(item.manufacturerUrl || "");
    const links = (own
      ? [link(item.categoryPage || item.manufacturerUrl, "Our page"), link(item.warrantyUrl, "Warranty")]
      : [link(item.manufacturerUrl, "Maker page"), link(item.warrantyUrl, "Warranty"), link(item.categoryPage, "Our page")]
    ).filter(Boolean).join(" · ");
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e6e6e6;">${escapeHtml(label)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6e6e6;text-align:center;">${escapeHtml(String(item.qty || ""))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6e6e6;">${escapeHtml(price)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e6e6e6;">${links}</td>
    </tr>`;
  }).join("");

  const taxBlock = bulk
    ? `<p style="margin:12px 0;">${escapeHtml(BULK_EMAIL)} This is not a final quote.</p>`
    : (totals
      ? `<p style="margin:12px 0;"><strong>Subtotal:</strong> ${formatMoney(totals.subtotal)}<br>
       <strong>${escapeHtml(totals.taxLabel)}:</strong> ${formatMoney(totals.tax)}<br>
       <strong>Total before payment fee:</strong> ${formatMoney(totals.total)}</p>
       <p style="margin:0 0 12px;">${escapeHtml(feeSentence(totals))}</p>`
      : "");

  const subject = bulk
    ? "Yorktown Tools got your list — we'll send your bulk pricing"
    : `Your Yorktown Tools estimate${company ? ` — ${company}` : ""}`;

  const intro = bulk
    ? `${BULK_EMAIL} We have the items, quantities, and job site.`
    : "Here is the estimate from George at Yorktown Tools. Free delivery is included.";

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1c1c1c;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0b1e3f;color:#ffffff;padding:22px 24px;">
          <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#f0d48a;">Yorktown Tools</div>
          <div style="font-size:22px;font-weight:700;margin-top:6px;">Tools Worth Fighting For</div>
          <div style="margin-top:8px;font-size:15px;">You build the project. We deliver the tools.</div>
        </td></tr>
        <tr><td style="padding:22px 24px;font-size:16px;line-height:1.5;">
          <p style="margin:0 0 12px;">Hi ${escapeHtml(name)},</p>
          <p style="margin:0 0 12px;">${escapeHtml(intro)}</p>
          <p style="margin:0 0 12px;"><strong>Company:</strong> ${escapeHtml(company || "—")}<br>
          <strong>Phone:</strong> ${escapeHtml(clean(lead.phone))}<br>
          <strong>Job site:</strong> ${escapeHtml(clean(lead.jobsite))}<br>
          <strong>Needed by:</strong> ${escapeHtml(clean(lead.neededBy))}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
            <tr style="background:#f8f9fa;">
              <th align="left" style="padding:8px;">Item</th>
              <th align="center" style="padding:8px;">Qty</th>
              <th align="left" style="padding:8px;">Estimate</th>
              <th align="left" style="padding:8px;">Links</th>
            </tr>
            ${rows || `<tr><td colspan="4" style="padding:10px 8px;">We'll price the list you sent.</td></tr>`}
          </table>
          ${taxBlock}
          <p style="margin:0 0 12px;"><strong>Delivery:</strong> ${escapeHtml(DELIVERY_LINE)}</p>
          <p style="margin:0 0 12px;">Returns and warranty go through the manufacturer. Net terms are only for approved customers. <a href="${CREDIT_APP_URL}">Credit application</a>. Sending it does not promise terms.</p>
          ${notes.map((note) => `<p style="margin:0 0 12px;">${escapeHtml(clean(note))}</p>`).join("")}
          ${lead.notes ? `<p style="margin:0 0 12px;"><strong>Notes:</strong> ${escapeHtml(clean(lead.notes))}</p>` : ""}
          <p style="margin:0 0 12px;">Questions: call or text <a href="tel:${PHONE_TEL}">${PHONE_DISPLAY}</a> or email <a href="mailto:sales@yorktowntools.com">sales@yorktowntools.com</a>. ${escapeHtml(HOURS)}.</p>
          <p style="margin:0;">— Yorktown Tools<br>Yorktown, Virginia · Veteran-owned</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `Hi ${name},`,
    "",
    intro,
    `Company: ${company || "—"}`,
    `Phone: ${clean(lead.phone)}`,
    `Job site: ${clean(lead.jobsite)}`,
    `Needed by: ${clean(lead.neededBy)}`,
    "",
    ...items.map((item) => {
      const price = bulk || item.confirm || item.estimate == null
        ? (bulk ? "We'll price this" : "We'll confirm the price")
        : `${formatMoney(item.estimate)} estimate`;
      return `- ${clean(item.name, "Item")} × ${item.qty || "?"} — ${price}`;
    }),
    "",
    bulk ? BULK_EMAIL : `Subtotal ${formatMoney(totals?.subtotal)} · ${totals?.taxLabel} ${formatMoney(totals?.tax)} · Total before payment fee ${formatMoney(totals?.total)}`,
    bulk ? "This is not a final quote." : feeSentence(totals),
    DELIVERY_LINE,
    "Warranty is through the manufacturer. Net terms only if approved.",
    `Credit application: ${CREDIT_APP_URL}`,
    ...notes.map((note) => clean(note)),
    `Call or text ${PHONE_DISPLAY}. sales@yorktowntools.com. ${HOURS}.`,
  ].join("\n");

  return { subject: clean(subject, "Your Yorktown Tools estimate"), html, text };
}

function paymentFee(totals, method) {
  const fees = totals?.fees || [];
  const pick = /ach/i.test(method || "")
    ? /ACH/
    : (/check/i.test(method || "") ? /Check/ : /Card/);
  return fees.find((fee) => pick.test(fee.method))?.amount || 0;
}

function invoiceFlag(lead, items, totals, leadInfo) {
  const reasons = [];
  if (lead.scamFlags) reasons.push(`possible scam: ${clean(lead.scamFlags)}`);
  if (lead.humanRequested) reasons.push("human requested");
  if (lead.consignment) reasons.push("consignment");
  if (leadInfo?.bulk) reasons.push("bulk or contract pricing");
  const addon = Number(lead.deliveryAddon) || 0;
  const fee = paymentFee(totals, lead.paymentMethod);
  const otd = totals?.total == null ? null : (Number(totals.total) || 0) + fee + addon;
  if (otd != null && otd > 500) reasons.push("over $500");
  if ((items || []).some((item) => item.confirm || item.estimate == null)) reasons.push("uncertain price or stock");
  if (reasons.length) return `NEEDS YOU: ${reasons.join(" / ")}`;
  if (otd != null && otd <= 500) return "READY TO INVOICE (<= $500)";
  return "NEEDS YOU: uncertain price or stock";
}

export function buildSalesEmail({ lead, items, leadInfo, totals }) {
  const tier = leadInfo?.tier || 3;
  const bulk = Boolean(leadInfo?.bulk);
  const company = clean(lead.company) || "no company given";
  const flag = tier === 1 ? "TIER 1 / PRIORITY" : (bulk ? `TIER ${tier} / BULK` : `TIER ${tier}`);
  const ready = invoiceFlag(lead, items, totals, leadInfo);
  const subject = `${flag} — George lead — ${company}`;
  const callLine = tier === 1
    ? "PRIORITY. Call this lead. They look like a bulk, ongoing, or multi-site account. Ask about typical order volume and how often they buy if that is not in the notes."
    : (bulk
      ? "Bulk order. Do not treat George's note as a locked price. Price it through your own sources and send the number."
      : "Small or one-off order. George already sent an instant estimate. Little follow-up unless something needs confirming.");
  const zacharyLine = "Zachary, this note is for you. The customer was not given your name.";
  const government = Boolean(lead.government || lead.taxExempt);
  const method = clean(lead.paymentMethod) || "not chosen";
  const fee = paymentFee(totals, lead.paymentMethod);
  const addon = Number(lead.deliveryAddon) || 0;
  const otd = totals?.total == null ? null : (Number(totals.total) || 0) + fee + addon;
  const lines = items.map((item) => {
    const price = item.estimate == null ? "confirm" : formatMoney(item.estimate);
    const brand = clean(item.manufacturer || item.brand);
    return `- ${brand ? `${brand} ` : ""}${clean(item.name, "Item")} × ${item.qty || "?"} — unit ${bulk ? "not locked" : price}`;
  });
  const text = [
    ready,
    flag,
    tierLabel(tier),
    zacharyLine,
    callLine,
    "",
    `Name: ${clean(lead.name)}`,
    `Company: ${company}`,
    `Phone: ${clean(lead.phone)}`,
    `Email: ${lead.email || ""}`,
    `Invoice by: ${clean(lead.invoiceVia) || "not chosen"}`,
    `Billing address: ${clean(lead.billingAddress) || "—"}`,
    `Delivery address: ${clean(lead.jobsite) || "—"}`,
    `Government or tax-exempt: ${government ? "yes" : "no"}`,
    `PO number: ${clean(lead.poNumber) || "—"}`,
    `Payment method: ${method}`,
    `Needed by: ${clean(lead.neededBy) || "—"}`,
    "",
    ...lines,
    "",
    `Subtotal: ${totals ? formatMoney(totals.subtotal) : "confirm"}`,
    `Tax: ${totals ? formatMoney(totals.tax) : "confirm"}`,
    `Payment fee: ${totals ? formatMoney(fee) : "confirm"}`,
    `Delivery add-on: ${formatMoney(addon) || "$0.00"}`,
    `OTD total: ${otd == null ? "confirm" : formatMoney(otd)}`,
    lead.notes ? `Notes: ${clean(lead.notes)}` : "",
  ].filter(Boolean).join("\n");

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1c1c1c;">
    <p style="font-size:18px;font-weight:700;color:#0b1e3f;">${escapeHtml(ready)}</p>
    <p style="font-size:16px;font-weight:700;">${escapeHtml(flag)}</p>
    <p>${escapeHtml(zacharyLine)}</p>
    <p>${escapeHtml(tierLabel(tier))}. ${escapeHtml(callLine)}</p>
    <p><strong>Name:</strong> ${escapeHtml(clean(lead.name))}<br>
    <strong>Company:</strong> ${escapeHtml(company)}<br>
    <strong>Phone:</strong> ${escapeHtml(clean(lead.phone))}<br>
    <strong>Email:</strong> ${escapeHtml(lead.email || "")}<br>
    <strong>Invoice by:</strong> ${escapeHtml(clean(lead.invoiceVia) || "not chosen")}<br>
    <strong>Billing address:</strong> ${escapeHtml(clean(lead.billingAddress) || "—")}<br>
    <strong>Delivery address:</strong> ${escapeHtml(clean(lead.jobsite) || "—")}<br>
    <strong>Government or tax-exempt:</strong> ${government ? "yes" : "no"}<br>
    <strong>PO number:</strong> ${escapeHtml(clean(lead.poNumber) || "—")}<br>
    <strong>Payment method:</strong> ${escapeHtml(method)}<br>
    <strong>Needed by:</strong> ${escapeHtml(clean(lead.neededBy) || "—")}</p>
    <pre style="font-family:Arial,Helvetica,sans-serif;">${escapeHtml(lines.join("\n"))}</pre>
    <p>Subtotal ${escapeHtml(totals ? formatMoney(totals.subtotal) : "confirm")}<br>
    Tax ${escapeHtml(totals ? formatMoney(totals.tax) : "confirm")}<br>
    Payment fee ${escapeHtml(totals ? formatMoney(fee) : "confirm")}<br>
    Delivery add-on ${escapeHtml(formatMoney(addon) || "$0.00")}<br>
    <strong>OTD total ${escapeHtml(otd == null ? "confirm" : formatMoney(otd))}</strong></p>
  </div>`;

  return { subject, html, text };
}

export function buildHandoffEmail({ identity, items, why, transcript, update = false }) {
  const name = identity?.name || "No name yet";
  const missing = !identity?.phone && !identity?.email;
  const subject = `${update ? "UPDATE — " : ""}HANDOFF — George — ${name}${missing ? " — missing phone or email" : ""}`;
  const lines = (items || []).map((item) => `- ${item.qty || 1} × ${item.name || "Item"}${item.sku ? ` (${item.sku})` : ""}`);
  const text = [
    update ? "Update on a handoff already sent." : "George handed this chat to the team.",
    `Why: ${why || "handoff"}`,
    missing ? "MISSING PHONE OR EMAIL. The note below is enough to start, but we still need a way to reach them." : "",
    "",
    `Name: ${name}`,
    `Company: ${identity?.company || "—"}`,
    `Phone: ${identity?.phone || "—"}`,
    `Email: ${identity?.email || "—"}`,
    identity?.note ? `Note: ${identity.note}` : "",
    "",
    "Items:",
    ...(lines.length ? lines : ["- none listed"]),
    "",
    "Transcript:",
    transcript || "—",
  ].filter(Boolean).join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;white-space:pre-wrap;">${escapeHtml(text)}</div>`;
  return { subject, html, text };
}

export function handoffFormspreeBody(mail) {
  const text = String(mail?.text || "");
  const pick = (label) => {
    const match = text.match(new RegExp(`^${label}: (.+)$`, "m"));
    const value = match?.[1]?.trim() || "";
    return value === "—" ? "" : value;
  };
  return {
    name: pick("Name"),
    company: pick("Company"),
    email: pick("Email"),
    phone: pick("Phone"),
    message: text,
    _subject: mail?.subject || "HANDOFF — George",
  };
}

export function formspreeBody(lead, items, leadInfo) {
  const tier = leadInfo?.tier || 3;
  const bulk = Boolean(leadInfo?.bulk);
  const flag = tier === 1 ? "TIER 1 / PRIORITY" : `TIER ${tier}${bulk ? " / BULK" : ""}`;
  const summary = items.map((item) => `${item.qty || "?"} × ${clean(item.name, "Item")}`).join("\n");
  return {
    name: clean(lead.name),
    company: clean(lead.company),
    email: lead.email,
    phone: clean(lead.phone),
    delivery: clean(lead.jobsite),
    needed_by: clean(lead.neededBy),
    message: `${flag}\n${bulk ? BULK_EMAIL : "Instant estimate sent if email is connected."}\n${summary}\n${clean(lead.notes || "")}`.trim(),
    _subject: `${flag} — George lead`,
  };
}
