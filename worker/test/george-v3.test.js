import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GREETING,
  LAST_NAME_LINE,
  LEAD_FAILURE_LINE,
  LEAD_SUCCESS_LINE,
  LINE_CARD_URL,
  LOCATION_LINE,
  PRICING_LINE,
} from "../../shared/copy.js";
import { localReply } from "../../shared/local-reply.js";
import { lastNameReply, readIdentity } from "../../shared/job.js";
import { clarifyingQuestion } from "../../shared/talk.js";
import { buildInstructions } from "../src/prompt.js";
import { GEORGE_V3 } from "../src/george-v3.js";
import { handleRequest, resetLimits, scrubPrices } from "../src/handler.js";
import {
  LEAD_SOURCE_FIELD,
  LEAD_SOURCE_LINE,
  LEAD_SUBJECT,
  buildLeadMail,
  leadFormspreeBody,
  submitLead,
  validateLead,
} from "../src/lead.js";
import { buildHandoffEmail, formspreeBody, handoffFormspreeBody } from "../src/email.js";
import catalog from "../../data/prices.json" with { type: "json" };

const origin = "http://localhost:8765";

function envBase(extra = {}) {
  return {
    MOCK_MODE: "true",
    ALLOWED_ORIGINS: origin,
    ...extra,
  };
}

async function chat(messages, env = envBase(), sessionId = "v3") {
  resetLimits();
  const response = await handleRequest(new Request("https://george.example/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ messages, sessionId }),
  }), env);
  return response.json();
}

function assertNoPrices(text, label = "reply") {
  assert.doesNotMatch(String(text || ""), /\$\s*\d/, `${label} must not contain a dollar amount: ${text}`);
  assert.doesNotMatch(String(text || ""), /out the door/i, `${label} must not quote an out-the-door total: ${text}`);
}

test("v3 prompt is loaded and includes the non-negotiable rules and submit_lead", () => {
  const verbatim = readFileSync(new URL("../../george-v3-verbatim.txt", import.meta.url), "utf8");
  assert.equal(GEORGE_V3, verbatim);
  const prompt = buildInstructions({ catalog, page: "https://yorktowntools.com/" });
  assert.equal(prompt.startsWith(verbatim), true);
  assert.match(prompt, /NON-NEGOTIABLE RULES/);
  assert.match(prompt, /Never give pricing of any kind/);
  assert.match(prompt, /submit_lead/);
  assert.match(prompt, /just go by George/);
  assert.doesNotMatch(prompt, /George Washington/);
  assert.match(GEORGE_V3, /12\. QUOTE REQUEST AND HANDOFF/);
  assert.equal(LEAD_SUCCESS_LINE, "You’re all set. A member of our Yorktown Tools team will review your request and follow up with pricing and availability. If you need help sooner, call or text 757-940-5171.");
  assert.equal(LEAD_FAILURE_LINE, "I wasn’t able to send your request to our team from here, and I don’t want it to get lost. Please text or email your list to 757-940-5171 or sales@yorktowntools.com and they’ll follow up with pricing and availability.");
  assert.ok(GEORGE_V3.includes(LEAD_SUCCESS_LINE));
  assert.ok(GEORGE_V3.includes(LEAD_FAILURE_LINE));
  assert.doesNotMatch(GEORGE_V3, /A Yorktown Tools specialist will reach out shortly/);
  assert.doesNotMatch(prompt, /A Yorktown Tools specialist will reach out shortly/);
});

test("pricing questions get the v3 line and no dollar amounts", () => {
  const local = localReply({ message: "How much is a Milwaukee M18 Fuel hammer drill?", catalog, discount: 0 });
  assert.match(local.reply, /We provide free quotes/i);
  assert.match(local.reply, /get the details to our team so they can put pricing together for you/i);
  assertNoPrices(local.reply);
});

test("a real-person question is answered honestly", async () => {
  const body = await chat([{ role: "user", content: "Am I talking to a real person?" }], envBase({
    callXai: async () => ({
      output_text: "I'm an AI assistant for Yorktown Tools. I can help pick tools and build your quote request, and our team handles pricing and final confirmation. Want to keep going?",
    }),
  }));
  assert.match(body.reply, /AI assistant for Yorktown Tools/i);
  assertNoPrices(body.reply);
});

test("last name is just George", () => {
  assert.equal(lastNameReply(), LAST_NAME_LINE);
  const local = localReply({ message: "What's your last name?", catalog, discount: 0 });
  assert.match(local.reply, /just go by George/i);
  assert.doesNotMatch(local.reply, /Washington/);
});

test("location line includes Virginia", () => {
  const local = localReply({ message: "Where are you located?", catalog, discount: 0 });
  assert.equal(local.reply, LOCATION_LINE);
  assert.match(local.reply, /Yorktown, Virginia/);
});

test("a brands question includes the line card link", async () => {
  const body = await chat([{ role: "user", content: "What brands do you carry?" }], envBase({
    callXai: async () => ({
      output_text: `Our core brands are DeWalt, Milwaukee, and Makita. Here's the line card: ${LINE_CARD_URL}`,
    }),
  }));
  assert.match(body.reply, /Yorktown-Tools-Line-Card-2026\.pdf/);
  assertNoPrices(body.reply);
});

test("the opening greeting matches v3", () => {
  const local = localReply({ message: "", catalog, discount: 0 });
  assert.equal(local.reply, GREETING);
  assert.match(GREETING, /What tools are you looking for/);
});

test("a drill follow-up does not repeat the first clarifying question", () => {
  const first = clarifyingQuestion("I need a drill");
  const second = clarifyingQuestion("It's made by dewalt", [
    { role: "user", content: "I need a drill" },
    { role: "assistant", content: first },
  ]);
  assert.ok(first);
  assert.notEqual(second, first);
});

test("a chainsaw follow-up does not re-ask the answered use and brand", () => {
  const history = [
    { role: "user", content: "1 chain saw 16 inch" },
    { role: "assistant", content: "Okay, what are you cutting, and do you have a brand or model in mind?" },
  ];
  const next = clarifyingQuestion("Trees and irrelevant brand", history);
  assert.ok(!next || !/what are you cutting/i.test(next) || /gas|electric|battery|cordless/i.test(next || ""));
  if (next) assert.notEqual(next, history[1].content);
});

test("mock and local replies never include a dollar amount", async () => {
  const cases = [
    "How much are the Victory gloves? Need 10 pairs.",
    "I need 1 Makita 5007FA circular saw",
    "How much is a DeWalt DCD996B?",
    "What's your last name?",
  ];
  for (const message of cases) {
    const local = localReply({ message, catalog, discount: 0 });
    assertNoPrices(local.reply, message);
  }
  const body = await chat([{ role: "user", content: "How much is a Milwaukee M18 Fuel hammer drill?" }]);
  assertNoPrices(body.reply);
  assert.match(body.reply, /free quotes/i);
});

test("scrubPrices strips leftover dollar amounts from model output", () => {
  const cleaned = scrubPrices("The shelf is $209.00 and out the door that's $230.34. Let's keep going.");
  assert.doesNotMatch(cleaned, /\$/);
  assert.doesNotMatch(cleaned, /230\.34/);
});

test("validateLead requires name, a phone or email, and items, and omits unknown qty", () => {
  const missing = validateLead({ items: [{ product: "Drill" }] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "missing_info");
  assert.ok(missing.missing.includes("name"));
  assert.ok(missing.missing.includes("phone_or_email"));

  const ok = validateLead({
    name: "Test Lead – George v3 QA",
    email: "sales@yorktowntools.com",
    items: [
      { brand: "DeWalt", model: "DCD996B", product: "drill", qty: 2 },
      { product: "5 inch grinding wheels" },
    ],
    reason: "quote_request",
    notes: "TEST lead",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.lead.items[0].qty, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(ok.lead.items[1], "qty"), false);
});


test("submit_lead fills an email from the user transcript when the tool omits it", async () => {
  const result = await submitLead({ MOCK_MODE: "true" }, {
    name: "Test Lead - George v3 QA",
    items: [{ brand: "DeWalt", model: "DCD996B", qty: 2 }],
    reason: "quote_request",
    notes: "TEST",
  }, {
    transcript: "user: My name is Test Lead - George v3 QA, email sales@yorktowntools.com\\nassistant: I still need an email.",
  });
  assert.equal(result.ok, true);
});

test("submit_lead success, missing_info, and failure paths, and the alert is from George", async () => {
  const successEnv = envBase({ handoffOutbox: [] });
  const sent = await submitLead(successEnv, {
    name: "Test Lead – George v3 QA",
    email: "sales@yorktowntools.com",
    items: [
      { brand: "DeWalt", product: "drill", model: "DCD996B", qty: 2 },
      { product: "5 inch grinding wheels" },
    ],
    reason: "quote_request",
    notes: "TEST — George v3 QA. This is not a real customer request.",
  }, { transcript: "user: I need 2 DeWalt DCD996B drills and some 5 inch grinding wheels", test: true });
  assert.deepEqual(sent, { ok: true });
  assert.equal(successEnv.handoffOutbox.length, 1);
  const mail = successEnv.handoffOutbox[0];
  assert.match(mail.subject, /New lead from George \(yorktowntools\.com chat\)/);
  assert.match(mail.subject, /TEST/);
  assert.ok(mail.text.startsWith(LEAD_SOURCE_LINE));
  assert.equal(mail.source, LEAD_SOURCE_FIELD);
  assert.match(mail.text, /5 inch grinding wheels/);
  assert.doesNotMatch(mail.text, /2 × 5 inch grinding wheels/);

  const missing = await submitLead(envBase({ handoffOutbox: [] }), { name: "Alex", items: [{ product: "Drill" }], reason: "quote_request" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "missing_info");
  assert.ok(missing.missing.includes("phone_or_email"));

  const failed = await submitLead(envBase({ handoffOutbox: [], failLeadSend: true }), {
    name: "Test Lead – George v3 QA",
    email: "sales@yorktowntools.com",
    items: [{ product: "drill", model: "DCD996B" }],
    reason: "quote_request",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "send_failed");
});

test("a model LEAD_JSON success uses the success line only after a real send", async () => {
  const env = envBase({
    handoffOutbox: [],
    callXai: async () => ({
      output_text: `I have your list ready.\nLEAD_JSON: ${JSON.stringify({
        name: "Test Lead – George v3 QA",
        email: "sales@yorktowntools.com",
        items: [
          { brand: "DeWalt", product: "drill", model: "DCD996B", qty: 2 },
          { product: "5 inch grinding wheels" },
        ],
        reason: "quote_request",
        notes: "TEST — George v3 QA",
      })}`,
    }),
  });
  const body = await chat([
    { role: "user", content: "I need 2 DeWalt DCD996B drills and some 5 inch grinding wheels. I'm Test Lead – George v3 QA, sales@yorktowntools.com." },
  ], env, "lead-success");
  assert.match(body.reply, /you['’]re all set/i);
  assert.equal(body.reply.includes(LEAD_SUCCESS_LINE), true);
  assert.equal((body.reply.match(/you['’]re all set/gi) || []).length, 1);
  assert.doesNotMatch(body.reply, /LEAD_JSON/);
  assertNoPrices(body.reply);
  assert.equal(env.handoffOutbox.length, 1);
  assert.match(env.handoffOutbox[0].subject, /New lead from George/);
  assert.ok(env.handoffOutbox[0].text.startsWith(LEAD_SOURCE_LINE));
});

test("a failed lead send uses the failure line and never says you're all set", async () => {
  const env = envBase({
    handoffOutbox: [],
    failLeadSend: true,
    callXai: async () => ({
      output_text: `You're all set. A Yorktown Tools specialist will reach out shortly.\nLEAD_JSON: ${JSON.stringify({
        name: "Test Lead – George v3 QA",
        email: "sales@yorktowntools.com",
        items: [{ product: "drill", model: "DCD996B", qty: 2 }],
        reason: "quote_request",
      })}`,
    }),
  });
  const body = await chat([{ role: "user", content: "Please send this to the team. Test Lead, sales@yorktowntools.com." }], env, "lead-fail");
  assert.ok(body.reply.startsWith(LEAD_FAILURE_LINE));
  assert.match(body.reply, /DCD996B/);
  assert.doesNotMatch(body.reply, /you['’]re all set/i);
  assert.doesNotMatch(body.reply, /reach out shortly/i);
});

test("handoff and form alerts are labeled as coming from George", () => {
  const handoff = buildHandoffEmail({
    identity: { name: "Alex", email: "alex@example.com" },
    items: [{ name: "DeWalt drill", qty: 1 }],
    why: "quote request",
    transcript: "user: I need a drill",
  });
  assert.match(handoff.subject, /New lead from George \(yorktowntools\.com chat\)/);
  assert.ok(handoff.text.startsWith(LEAD_SOURCE_LINE));
  const form = handoffFormspreeBody(handoff);
  assert.equal(form._subject, handoff.subject);
  assert.equal(form.source, LEAD_SOURCE_FIELD);
  const formLead = formspreeBody({ name: "Alex", email: "alex@example.com", phone: "7575550100", jobsite: "Yorktown, VA", notes: "" }, [{ name: "Drill", qty: 1 }], { tier: 3 });
  assert.equal(formLead.source, LEAD_SOURCE_FIELD);
  assert.match(formLead._subject, /New lead from George/);
  const built = buildLeadMail({
    name: "Alex",
    email: "alex@example.com",
    items: [{ product: "grinding wheels" }],
    reason: "quote_request",
  });
  assert.equal(built.subject, LEAD_SUBJECT);
  assert.ok(built.text.startsWith(LEAD_SOURCE_LINE));
});

test("a claimed success without a send is replaced by the failure line", async () => {
  const env = envBase({
    callXai: async () => ({ output_text: "You're all set. A Yorktown Tools specialist will reach out shortly." }),
  });
  const body = await chat([{ role: "user", content: "Please send the quote." }], env, "false-success");
  assert.ok(body.reply.startsWith(LEAD_FAILURE_LINE));
  assert.doesNotMatch(body.reply, /you['’]re all set/i);
  assert.doesNotMatch(body.reply, /reach out shortly/i);
});

test("server submits the lead itself when model emits success text without submit_lead, and omits empty email from Formspree", async () => {
  resetLimits();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || "{}") });
    return new Response(JSON.stringify({ ok: true, next: "/thanks" }), { status: 200 });
  };
  try {
    const env = {
      MOCK_MODE: "false",
      ALLOWED_ORIGINS: "http://localhost:8765",
      XAI_API_KEY: "test-key",
      handoffOutbox: [],
      callXai: async () => ({
        output_text: "You're all set. A member of our Yorktown Tools team will review your request and follow up with pricing and availability. If you need help sooner, call or text 757-940-5171.",
      }),
    };
    const history = [
      { role: "user", content: "I need a Milwaukee M18 Fuel hammer drill" },
      { role: "assistant", content: "Are you looking for just the bare tool, or a kit?" },
      { role: "user", content: "Yes" },
      { role: "assistant", content: "Got it. To get you a free quote, could you give me your name and a phone number or email?" },
      { role: "user", content: "Alex Smith, 7575550101" },
    ];
    const body = await chat(history, env, "auto-submit-01");
    assert.equal(body.reply, LEAD_SUCCESS_LINE);
    assert.equal(body.lead?.ok, true);
    assert.equal(env.handoffOutbox.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://formspree.io/f/xanlvyan");
    assert.equal(calls[0].body.name, "Alex Smith");
    assert.equal(calls[0].body.phone, "7575550101");
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, "email"), false);
    assert.equal(calls[0].body.source, LEAD_SOURCE_FIELD);

    // Follow-up Thanks must not send a duplicate lead or repeat the success line
    const thanksEnv = {
      ...env,
      handoffOutbox: [],
      callXai: async () => ({ output_text: "You bet." }),
    };
    const thanks = await chat([
      ...history,
      { role: "assistant", content: body.reply },
      { role: "user", content: "Thanks" },
    ], thanksEnv, "auto-submit-01");
    assert.match(thanks.reply, /^You bet\./);
    assert.doesNotMatch(thanks.reply, /you['’]re all set/i);
    assert.equal(calls.length, 1);
    assert.equal(thanksEnv.handoffOutbox.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server submits the lead when contact and items are known even if model omits both tool call and success line, and fails closed if Formspree returns ok: false", async () => {
  resetLimits();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "rejected" }), { status: 200 });
  try {
    const env = {
      MOCK_MODE: "false",
      ALLOWED_ORIGINS: "http://localhost:8765",
      XAI_API_KEY: "test-key",
      handoffOutbox: [],
      callXai: async () => ({ output_text: "Got it, thanks!" }),
    };
    const body = await chat([
      { role: "user", content: "I need 5 inch grinding wheels" },
      { role: "assistant", content: "What's your name and phone or email?" },
      { role: "user", content: "Alex, 7575550101" },
    ], env, "fail-closed-01");
    assert.ok(body.reply.startsWith(LEAD_FAILURE_LINE));
    assert.match(body.reply, /grinding wheels/i);
    assert.doesNotMatch(body.reply, /you['’]re all set/i);
    assert.equal(body.lead?.ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readIdentity ignores tool requests and captures single-word name before phone, and leadFormspreeBody omits blank email", () => {
  const onlyToolAndPhone = readIdentity([
    { role: "user", content: "I need a Milwaukee drill" },
    { role: "user", content: "7575550101" },
  ]);
  assert.equal(onlyToolAndPhone.name, "");
  assert.equal(onlyToolAndPhone.phone, "7575550101");

  const oneWordName = readIdentity([{ role: "user", content: "Alex, (757) 555-0101" }]);
  assert.equal(oneWordName.name, "Alex");
  assert.equal(oneWordName.phone, "(757) 555-0101");

  const mail = buildLeadMail({
    name: "Alex",
    phone: "7575550101",
    items: [{ product: "grinding wheels" }],
    reason: "quote_request",
  });
  const form = leadFormspreeBody(mail, { name: "Alex", phone: "7575550101", email: "", city_state: "" });
  assert.equal(form.name, "Alex");
  assert.equal(form.phone, "7575550101");
  assert.equal(Object.prototype.hasOwnProperty.call(form, "email"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(form, "city_state"), false);
});
