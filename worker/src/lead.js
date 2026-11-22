import { filterCustomerText } from "./source-filter.js";
import { escapeHtml } from "../../shared/customer-text.js";
import { SALES_EMAIL, LEAD_SUCCESS_LINE, LEAD_FAILURE_LINE } from "../../shared/copy.js";

export { LEAD_SUCCESS_LINE, LEAD_FAILURE_LINE };

export const LEAD_SUBJECT = "New lead from George (yorktowntools.com chat)";
export const LEAD_SOURCE_LINE = "Source: George – website chat assistant";
export const LEAD_SOURCE_FIELD = "George – website chat assistant";

export const LEAD_REASONS = [
  "quote_request",
  "government",
  "consignment",
  "out_of_area",
  "scam_screen",
  "specialist",
  "update",
  "other",
];

export const SUBMIT_LEAD_TOOL = {
  type: "function",
  name: "submit_lead",
  description:
    "Send a quote request to the Yorktown Tools team. Call this only when you have the customer's name and a phone or email, plus the current product list. The lead is sent only if this tool returns ok: true.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Customer's name" },
      phone: { type: "string", description: "Phone or cell number, if given" },
      email: { type: "string", description: "Email address, if given" },
      city_state: { type: "string", description: "City and state, if given" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" },
            brand: { type: "string" },
            product: { type: "string" },
            model: { type: "string" },
            qty: { type: "number", description: "Omit when the customer did not give a quantity" },
            needs_verification: { type: "boolean" },
          },
        },
      },
      notes: { type: "string" },
      reason: { type: "string", enum: LEAD_REASONS },
      is_update: { type: "boolean" },
    },
    required: ["name", "items", "reason"],
  },
};

function clean(value, max = 400) {
  const text = filterCustomerText(value).text;
  return String(text || "").trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function asItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const item = {
    category: clean(raw.category, 80),
    brand: clean(raw.brand, 80),
    product: clean(raw.product || raw.name || raw.description, 200),
    model: clean(raw.model || raw.sku, 80),
    needs_verification: raw.needs_verification === true || raw.needsVerification === true,
  };
  if (raw.qty != null && raw.qty !== "") {
    const qty = Number(raw.qty);
    if (Number.isFinite(qty) && qty > 0) item.qty = qty;
  }
  if (!item.category) delete item.category;
  if (!item.brand) delete item.brand;
  if (!item.product) delete item.product;
  if (!item.model) delete item.model;
  if (!item.category && !item.brand && !item.product && !item.model) return null;
  return item;
}

function itemLabel(item) {
  const bits = [item.brand, item.product, item.model].filter(Boolean);
  const name = bits.join(" ").trim() || item.category || "Item";
  const qty = Object.prototype.hasOwnProperty.call(item, "qty") ? `${item.qty} × ` : "";
  const verify = item.needs_verification ? " (needs verification)" : "";
  return `${qty}${name}${verify}`;
}


function userTranscript(transcript) {
  return String(transcript || "")
    .split(/\n+/)
    .filter((line) => /^user:/i.test(line.trim()))
    .join("\n");
}

function emailFromUserText(text) {
  const match = String(text || "").match(/\b[\w.+-]+@[\w.-]+\.\w+\b/);
  return match ? match[0] : "";
}

function phoneFromUserText(text) {
  const match = String(text || "").match(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/);
  return match ? match[0] : "";
}

export function validateLead(input) {
  const data = input && typeof input === "object" ? input : {};
  const name = clean(data.name, 120);
  const phone = clean(data.phone, 40);
  const email = clean(data.email, 160);
  const cityState = clean(data.city_state || data.cityState || data.jobsite, 160);
  const notes = clean(data.notes, 800);
  const reasonRaw = clean(data.reason || "quote_request", 40).toLowerCase().replace(/\s+/g, "_");
  const reason = LEAD_REASONS.includes(reasonRaw) ? reasonRaw : "other";
  const isUpdate = data.is_update === true || data.isUpdate === true;
  const items = Array.isArray(data.items) ? data.items.map(asItem).filter(Boolean).slice(0, 40) : [];
  const missing = [];
  if (!name) missing.push("name");
  const phoneOk = phone && validPhone(phone);
  const emailOk = email && validEmail(email);
  if (!phoneOk && !emailOk) {
    if (phone && !phoneOk) missing.push("phone");
    if (email && !emailOk) missing.push("email");
    if (!phone && !email) missing.push("phone_or_email");
  }
  if (!items.length) missing.push("items");
  if (missing.length) return { ok: false, error: "missing_info", missing };
  const lead = {
    name,
    phone: phoneOk ? phone : "",
    email: emailOk ? email : "",
    city_state: cityState,
    items,
    notes,
    reason,
    is_update: isUpdate,
  };
  return { ok: true, lead };
}

export function buildLeadMail(lead, { transcript = "", test = false, why = "" } = {}) {
  const update = Boolean(lead?.is_update);
  const testMark = test || /test lead|george v3 qa|\btest\b/i.test(`${lead?.name || ""} ${lead?.notes || ""}`);
  const subjectParts = [testMark ? "TEST — " : "", update ? "UPDATE — " : "", LEAD_SUBJECT];
  const subject = subjectParts.join("");
  const itemLines = (lead?.items || []).map((item) => `- ${itemLabel(item)}`);
  const text = [
    LEAD_SOURCE_LINE,
    testMark ? "This is a TEST lead from George QA. It is not a real customer request." : "",
    update ? "This is an update to a lead already sent from the website chat." : "",
    why ? `Why: ${why}` : "",
    lead?.reason ? `Reason: ${lead.reason}` : "",
    "",
    `Name: ${lead?.name || "—"}`,
    `Phone: ${lead?.phone || "—"}`,
    `Email: ${lead?.email || "—"}`,
    `City/state: ${lead?.city_state || "—"}`,
    lead?.notes ? `Notes: ${lead.notes}` : "",
    "",
    "Items:",
    ...(itemLines.length ? itemLines : ["- none listed"]),
    "",
    "Transcript:",
    transcript || "—",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trim();
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;white-space:pre-wrap;">${escapeHtml(text)}</div>`;
  return { subject, html, text, source: LEAD_SOURCE_FIELD };
}

export function leadFormspreeBody(mail, lead = {}) {
  return {
    name: lead.name || "",
    email: lead.email || "",
    phone: lead.phone || "",
    city_state: lead.city_state || "",
    message: mail.text,
    source: LEAD_SOURCE_FIELD,
    _subject: mail.subject || LEAD_SUBJECT,
  };
}

export function decorateAlertMail(mail) {
  const subject = String(mail?.subject || "").trim();
  const alreadyTitled = /new lead from george/i.test(subject);
  const nextSubject = alreadyTitled ? subject : (subject ? `${LEAD_SUBJECT} — ${subject}` : LEAD_SUBJECT);
  let text = String(mail?.text || "").trim();
  if (!text.startsWith(LEAD_SOURCE_LINE)) text = `${LEAD_SOURCE_LINE}\n\n${text}`.trim();
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;white-space:pre-wrap;">${escapeHtml(text)}</div>`;
  return {
    ...mail,
    subject: nextSubject,
    text,
    html,
    source: LEAD_SOURCE_FIELD,
  };
}

export function formspreeFields(mail, extras = {}) {
  return {
    name: extras.name || "",
    email: extras.email || "",
    phone: extras.phone || "",
    company: extras.company || "",
    message: mail.text,
    source: LEAD_SOURCE_FIELD,
    _subject: mail.subject || LEAD_SUBJECT,
  };
}

async function postHandoff(url, init) {
  try {
    const response = await fetch(url, init);
    return Boolean(response?.ok);
  } catch (error) {
    console.error(`lead mail failed: ${error instanceof Error ? error.message : "error"}`);
    return false;
  }
}

export async function sendLeadMail(env, mail, lead = {}) {
  const labeled = decorateAlertMail(mail);
  if (Array.isArray(env?.handoffOutbox)) {
    env.handoffOutbox.push({
      subject: labeled.subject,
      text: labeled.text,
      html: labeled.html,
      source: labeled.source,
    });
  }
  const mock = env?.MOCK_MODE === "true";
  if (env?.RESEND_API_KEY) {
    const from = env.FROM_EMAIL || "Yorktown Tools <quotes@quotes.yorktowntools.com>";
    const sales = env.SALES_EMAIL || SALES_EMAIL;
    const sent = await postHandoff("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [sales],
        subject: labeled.subject,
        html: labeled.html,
        text: labeled.text,
      }),
    });
    if (sent) return true;
    console.error("lead mail failed: resend");
  } else if (mock) {
    return env.failLeadSend ? false : true;
  } else {
    console.error("lead mail: RESEND_API_KEY is not set, using formspree");
  }
  if (mock) return env.failLeadSend ? false : true;
  const formspree = env?.FORMSPREE_URL || "https://formspree.io/f/xanlvyan";
  const sent = await postHandoff(formspree, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(leadFormspreeBody(labeled, lead)),
  });
  if (sent) console.log(`lead mail sent via formspree fromGeorge=${/George/i.test(mail.subject || "")} source=${mail.source} subjectHint=${/TEST/i.test(mail.subject || "") ? "TEST — New lead from George (yorktowntools.com chat)" : "New lead from George (yorktowntools.com chat)"}`);
  else console.error("lead mail failed: formspree");
  return sent;
}

export async function submitLead(env, input, { transcript = "", test = false, why = "" } = {}) {
  const data = input && typeof input === "object" ? { ...input } : {};
  const fromUser = userTranscript(transcript);
  if (!String(data.email || "").trim()) {
    const found = emailFromUserText(fromUser);
    if (found) data.email = found;
  }
  if (!String(data.phone || "").trim()) {
    const found = phoneFromUserText(fromUser);
    if (found) data.phone = found;
  }
  const checked = validateLead(data);
  if (!checked.ok) return { ok: false, error: checked.error, missing: checked.missing };
  const mail = buildLeadMail(checked.lead, { transcript, test, why });
  const sent = await sendLeadMail(env, mail, checked.lead);
  if (!sent) return { ok: false, error: "send_failed" };
  return { ok: true };
}

export function parseLeadJson(raw) {
  const text = String(raw || "");
  const index = text.search(/LEAD_JSON\s*:/i);
  if (index < 0) return { reply: text.trim(), lead: null };
  const reply = text.slice(0, index).trim();
  const jsonPart = text.slice(index).replace(/^[^\n{]*/, "");
  const start = jsonPart.indexOf("{");
  const end = jsonPart.lastIndexOf("}");
  if (start < 0 || end <= start) return { reply, lead: null };
  try {
    return { reply, lead: JSON.parse(jsonPart.slice(start, end + 1)) };
  } catch {
    return { reply, lead: null };
  }
}

export function functionCalls(data) {
  const calls = [];
  for (const item of data?.output || []) {
    const type = String(item?.type || "");
    const name = item?.name || item?.function?.name;
    if (name !== "submit_lead") continue;
    if (!type.includes("function") && !item?.arguments && !item?.function?.arguments) continue;
    const args = item.arguments || item.function?.arguments || "{}";
    let parsed = args;
    if (typeof args === "string") {
      try {
        parsed = JSON.parse(args);
      } catch {
        parsed = {};
      }
    }
    calls.push({
      name: "submit_lead",
      call_id: item.call_id || item.id || `call_${calls.length + 1}`,
      arguments: parsed,
      raw: item,
    });
  }
  return calls;
}

export function scrubPrices(value) {
  let text = String(value || "");
  text = text.replace(/\$\s*-?\d[\d,]*(?:\.\d{1,2})?/g, "");
  text = text.replace(/\b(?:usd|dollars?)\b/gi, "");
  text = text.replace(/out the door[^.?!]*/gi, "");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/ +\./g, ".");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function claimedLeadSuccess(text) {
  return /you['’]?re all set|team (was |has been )?notified|quote (was |has been )?(submitted|sent)|i(?:'?ve| have) sent (that|it|your request)/i.test(String(text || ""));
}
