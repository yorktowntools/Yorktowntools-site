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
    "Send a quote request to the Yorktown Tools team. Call this only after you have a specific product list, quantities, and any brand preference, plus the customer's name (unless they declined after a second ask) and a phone or email. The lead is sent only if this tool returns ok: true.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Customer's name" },
      company: { type: "string", description: "Company name, if given" },
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

function isPlaceholder(value) {
  return !value || /^(not specified|n\/?a|none|unknown|unspecified|tbd|—|-|\.)+$/i.test(String(value).trim());
}

export function itemLabel(item) {
  if (!item || typeof item !== "object") return String(item || "Item").trim() || "Item";
  const bits = [item.brand, item.product || item.name, item.model || item.sku]
    .filter((value) => value && !isPlaceholder(value));
  const category = item.category && !isPlaceholder(item.category) ? item.category : "";
  const name = bits.join(" ").trim() || category || "Item (details not confirmed)";
  const qty = item.qty != null && item.qty !== "" ? `${item.qty} × ` : "";
  const verify = item.needs_verification ? " — details need confirmation" : "";
  return `${qty}${name}${verify}`;
}

const MAIL_WRAP = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#111;";

function dash(value) {
  const text = String(value || "").trim();
  return text || "—";
}

export function formatLeadTranscript(transcript) {
  const raw = String(transcript || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const pieces = raw
    .split(/\n+/)
    .flatMap((line) => line.split(/(?=\b(?:user|assistant|customer|george)\s*:)/i))
    .map((part) => part.trim())
    .filter(Boolean);
  const turns = [];
  for (const part of pieces) {
    const match = part.match(/^(user|assistant|customer|george)\s*:\s*([\s\S]*)$/i);
    if (match) {
      const role = /^(user|customer)$/i.test(match[1]) ? "Customer" : "George";
      const text = match[2].replace(/\s+/g, " ").trim();
      if (text) turns.push({ role, text });
    } else if (turns.length) {
      turns[turns.length - 1].text = `${turns[turns.length - 1].text} ${part.replace(/\s+/g, " ").trim()}`.trim();
    }
  }
  return turns;
}

export function htmlFromPlainText(text) {
  return `<div data-george-mail="1" style="${MAIL_WRAP}">${escapeHtml(text).replace(/\n/g, "<br>\n")}</div>`;
}

export function buildLeadBodies({ intro = [], fields = {}, itemLines = [], transcript = "" } = {}) {
  const fieldOrder = ["Name", "Company", "Phone", "Email", "City/state", "Reason"];
  const fieldLines = fieldOrder.map((key) => `${key}: ${dash(fields[key])}`);
  const extraFieldLines = fields.Notes ? [`Notes: ${fields.Notes}`] : [];
  const items = itemLines.length ? itemLines : ["- none listed"];
  const turns = formatLeadTranscript(transcript);
  const transcriptLines = turns.length
    ? turns.map((turn) => `${turn.role}: ${turn.text}`)
    : [dash(transcript)];

  const text = [
    ...intro.filter(Boolean),
    "",
    ...fieldLines,
    ...extraFieldLines,
    "",
    "Items:",
    ...items,
    "",
    "Transcript:",
    ...transcriptLines,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const html = [
    `<div data-george-mail="1" style="${MAIL_WRAP}">`,
    ...intro.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p>${[...fieldLines, ...extraFieldLines].map((line) => escapeHtml(line)).join("<br>\n")}</p>`,
    `<p><strong>Items:</strong></p>`,
    `<ul>${items.map((line) => `<li>${escapeHtml(String(line).replace(/^-\s*/, ""))}</li>`).join("")}</ul>`,
    `<p><strong>Transcript:</strong><br>\n${transcriptLines.map((line) => escapeHtml(line)).join("<br>\n")}</p>`,
    `</div>`,
  ].join("\n");

  return { text, html };
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

export function validateLead(input, { allowMissingName = false } = {}) {
  const data = input && typeof input === "object" ? input : {};
  const name = clean(data.name, 120);
  const company = clean(data.company, 160);
  const phone = clean(data.phone, 40);
  const email = clean(data.email, 160);
  const cityState = clean(data.city_state || data.cityState || data.jobsite, 160);
  const notes = clean(data.notes, 800);
  const reasonRaw = clean(data.reason || "quote_request", 40).toLowerCase().replace(/\s+/g, "_");
  const reason = LEAD_REASONS.includes(reasonRaw) ? reasonRaw : "other";
  const isUpdate = data.is_update === true || data.isUpdate === true;
  const items = Array.isArray(data.items) ? data.items.map(asItem).filter(Boolean).slice(0, 40) : [];
  const missing = [];
  if (!name && !allowMissingName) missing.push("name");
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
    company,
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
  const { text, html } = buildLeadBodies({
    intro: [
      LEAD_SOURCE_LINE,
      testMark ? "This is a TEST lead from George QA. It is not a real customer request." : "",
      update ? "This is an update to a lead already sent from the website chat." : "",
      why ? `Why: ${why}` : "",
    ],
    fields: {
      Name: lead?.name,
      Company: lead?.company,
      Phone: lead?.phone,
      Email: lead?.email,
      "City/state": lead?.city_state,
      Reason: lead?.reason,
      Notes: lead?.notes,
    },
    itemLines,
    transcript,
  });
  return { subject, html, text, source: LEAD_SOURCE_FIELD };
}

export function leadFormspreeBody(mail, lead = {}) {
  const body = {
    message: mail.text,
    source: LEAD_SOURCE_FIELD,
    _subject: mail.subject || LEAD_SUBJECT,
  };
  if (lead.name) body.name = lead.name;
  if (lead.email) body.email = lead.email;
  if (lead.phone) body.phone = lead.phone;
  if (lead.city_state) body.city_state = lead.city_state;
  return body;
}

export function decorateAlertMail(mail) {
  const subject = String(mail?.subject || "").trim();
  const alreadyTitled = /new lead from george/i.test(subject);
  const nextSubject = alreadyTitled ? subject : (subject ? `${LEAD_SUBJECT} — ${subject}` : LEAD_SUBJECT);
  let text = String(mail?.text || "").trim();
  let html = String(mail?.html || "").trim();
  if (!text.startsWith(LEAD_SOURCE_LINE)) text = `${LEAD_SOURCE_LINE}\n\n${text}`.trim();
  const structured = /data-george-mail="1"/.test(html);
  if (!structured) {
    html = htmlFromPlainText(text);
  } else if (!html.includes(escapeHtml(LEAD_SOURCE_LINE))) {
    html = html.replace(">", `><p>${escapeHtml(LEAD_SOURCE_LINE)}</p>`, 1);
  }
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

export async function postHandoff(url, init) {
  try {
    const response = await fetch(url, init);
    let bodyText = "";
    if (typeof response?.text === "function") {
      bodyText = await response.text().catch(() => "");
    } else if (typeof response?.json === "function") {
      const parsed = await response.json().catch(() => null);
      if (parsed != null) bodyText = JSON.stringify(parsed);
    }
    let data = null;
    if (bodyText) {
      try { data = JSON.parse(bodyText); } catch { data = null; }
    }
    const bodyOk = !data || (data.ok !== false && !data.error && !(Array.isArray(data.errors) && data.errors.length));
    const ok = Boolean(response?.ok) && bodyOk;
    return {
      ok,
      status: Number(response?.status || (ok ? 200 : 0)),
      body: bodyText.replace(/[\r\n]+/g, " ").slice(0, 300),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "error";
    console.error(`lead mail failed: ${msg}`);
    return { ok: false, status: 0, body: msg };
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
    const res = await postHandoff("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [sales],
        ...(lead?.email ? { reply_to: lead.email } : {}),
        subject: labeled.subject,
        html: labeled.html,
        text: labeled.text,
      }),
    });
    if (res.ok) return true;
    console.error(`lead mail failed: resend status=${res.status} body=${res.body}`);
  } else if (mock) {
    return env.failLeadSend ? false : true;
  } else {
    console.error("lead mail: RESEND_API_KEY is not set, using formspree");
  }
  if (mock) return env.failLeadSend ? false : true;
  const formspree = env?.FORMSPREE_URL || "https://formspree.io/f/xanlvyan";
  const res = await postHandoff(formspree, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(leadFormspreeBody(labeled, lead)),
  });
  const hint = /TEST/i.test(labeled.subject || "") ? "TEST — New lead from George (yorktowntools.com chat)" : "New lead from George (yorktowntools.com chat)";
  if (res.ok) console.log(`lead mail sent via formspree status=${res.status} body=${res.body || "ok"} fromGeorge=${/George/i.test(labeled.subject || "")} source=${labeled.source} subjectHint=${hint}`);
  else console.error(`lead mail failed: formspree status=${res.status} body=${res.body}`);
  return res.ok;
}

export async function submitLead(env, input, { transcript = "", test = false, why = "", fallbackIdentity = null, fallbackItems = null, allowMissingName = false } = {}) {
  const data = input && typeof input === "object" ? { ...input } : {};
  const fromUser = userTranscript(transcript);
  if (!String(data.name || "").trim() && fallbackIdentity?.name) {
    data.name = fallbackIdentity.name;
  }
  if (!String(data.company || "").trim() && fallbackIdentity?.company) {
    data.company = fallbackIdentity.company;
  }
  if (!String(data.email || "").trim()) {
    const found = emailFromUserText(fromUser) || fallbackIdentity?.email || "";
    if (found) data.email = found;
  }
  if (!String(data.phone || "").trim()) {
    const found = phoneFromUserText(fromUser) || fallbackIdentity?.phone || "";
    if (found) data.phone = found;
  }
  const hasValidItems = Array.isArray(data.items) && data.items.map(asItem).filter(Boolean).length > 0;
  if (!hasValidItems && Array.isArray(fallbackItems) && fallbackItems.length) {
    data.items = fallbackItems;
  }
  const checked = validateLead(data, { allowMissingName });
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
  let tail = text.slice(index);
  const quoteAfter = tail.search(/\n\s*QUOTE_JSON\s*:/i);
  if (quoteAfter >= 0) tail = tail.slice(0, quoteAfter);
  const jsonPart = tail.replace(/^[^\n{]*/, "");
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
