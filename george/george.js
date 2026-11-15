import { BULK_LINE, PHONE_DISPLAY, PHONE_TEL } from "../shared/copy.js";
import { filterCustomerText, renderSafeHtml } from "../shared/customer-text.js";
import { localReply } from "../shared/local-reply.js";
import { formatEstimate } from "../shared/pricing.js";

// Live Worker for now. window.GEORGE_API overrides this.
// Later, a custom domain can replace it: https://george.yorktowntools.com
const API = window.GEORGE_API || "https://yorktown-george.yorktowntools.workers.dev";
const FORMSPREE = "https://formspree.io/f/xanlvyan";
const params = new URLSearchParams(location.search);
const localHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const preview = params.get("george") === "mock" || (localHost && params.get("george") !== "live");

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./george.css", import.meta.url).href;
document.head.appendChild(css);

let catalog = { items: [], discountPercent: 1 };
let mode = params.get("george") === "mock" ? "local" : "unknown";
let sessionId = "";
let draft = { items: [], open: false };
let busy = false;

try {
  sessionId = sessionStorage.getItem("george-session") || "";
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem("george-session", sessionId);
  }
} catch {
  sessionId = `web${Date.now()}`;
}

const catalogReady = fetch(new URL("../data/prices.json", import.meta.url))
  .then((response) => response.json())
  .then((data) => {
    catalog = data;
  })
  .catch(() => {});

const root = document.createElement("div");
root.innerHTML = `
  <button type="button" class="george-launcher" aria-expanded="false" aria-controls="george-panel">
    <img src="/george-mascot.PNG" alt="" width="44" height="44">
    <span>Ask George</span>
  </button>
  <section id="george-panel" class="george-panel" role="dialog" aria-modal="true" aria-labelledby="george-title" hidden>
    <header class="george-head">
      <img src="/george-mascot.PNG" alt="" width="44" height="44">
      <div class="george-head-text">
        <h2 id="george-title">George</h2>
        <p>Yorktown Tools</p>
      </div>
      <div class="george-actions">
        <a href="tel:${PHONE_TEL}">Call</a>
        <a href="sms:${PHONE_TEL}">Text</a>
        <button type="button" class="george-close" aria-label="Close chat">Close</button>
      </div>
    </header>
    <div class="george-log" role="log" aria-live="polite"></div>
    <button type="button" class="george-review" hidden>Review &amp; send quote</button>
    <form class="george-quote" hidden>
      <h3>Quote for Yorktown Tools</h3>
      <p class="george-bulk"></p>
      <div class="george-items"></div>
      <button type="button" class="george-add">Add an item</button>
      <div class="george-fields">
        <label class="george-wide">Name <input name="name" autocomplete="name" required></label>
        <label class="george-wide">Company, if this is for a business <input name="company" autocomplete="organization"></label>
        <label>Phone <input name="phone" type="tel" autocomplete="tel" required></label>
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label class="george-wide">Job-site address <input name="jobsite" autocomplete="street-address" required></label>
        <label>Needed by <input name="neededBy" type="date" required></label>
        <label class="george-wide"><input name="taxExempt" type="checkbox"> Government or tax-exempt. A certificate is required.</label>
        <label class="george-wide">Notes <textarea name="notes" rows="2" placeholder="For a company account: how often you order"></textarea></label>
      </div>
      <p class="george-error" role="alert"></p>
      <button type="submit" class="george-submit">Send quote</button>
    </form>
    <form class="george-compose">
      <textarea aria-label="Message to George" rows="2" maxlength="1200" placeholder="Brand, model, quantity"></textarea>
      <button type="submit" class="george-send">Send</button>
    </form>
    <div class="george-foot">
      <a href="/privacy.html">Privacy</a>
      <span>Estimates only. ${PHONE_DISPLAY}</span>
    </div>
  </section>
`;
document.body.appendChild(root);

const launcher = root.querySelector(".george-launcher");
const panel = root.querySelector(".george-panel");
const log = root.querySelector(".george-log");
const quoteForm = root.querySelector(".george-quote");
const reviewButton = root.querySelector(".george-review");
const itemsEl = root.querySelector(".george-items");
const compose = root.querySelector(".george-compose");
const textarea = compose.querySelector("textarea");
const errorEl = root.querySelector(".george-error");
const bulkNote = root.querySelector(".george-bulk");

const messages = [];

function addMessage(role, text) {
  const safe = role === "user"
    ? String(text || "")
    : (filterCustomerText(text).text || "Call or text (757) 940-5171 and Zachary will take it from here.");
  messages.push({ role, content: safe });
  const bubble = document.createElement("div");
  bubble.className = `george-msg george-msg-${role === "user" ? "user" : "bot"}`;
  if (role === "user") bubble.textContent = safe;
  else bubble.innerHTML = renderSafeHtml(safe);
  log.appendChild(bubble);
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}

function showBanner(text) {
  const note = document.createElement("p");
  note.className = "george-banner";
  note.textContent = text;
  log.prepend(note);
}

function chips() {
  const row = document.createElement("div");
  row.className = "george-chips";
  const options = [
    ["Delivery", "Where do you deliver?"],
    ["Payment", "How do I pay, and do you offer terms?"],
    ["Quote", null],
  ];
  for (const [label, prompt] of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!prompt) {
        openQuote();
        return;
      }
      textarea.value = prompt;
      compose.requestSubmit();
    });
    row.appendChild(button);
  }
  log.appendChild(row);
}

function addBlankItem() {
  draft.items.push({
    name: "",
    sku: "",
    qty: null,
    estimate: null,
    estimateHigh: null,
    confidence: "unsure",
    kind: "unsure",
    manufacturerUrl: "",
    categoryPage: "",
    touched: false,
  });
}

function renderItems() {
  itemsEl.innerHTML = "";
  draft.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "george-item";
    const name = document.createElement("input");
    name.ariaLabel = `Item ${index + 1}`;
    name.placeholder = "Item";
    name.value = item.name || "";
    name.required = true;
    name.addEventListener("input", () => {
      item.name = name.value;
      item.touched = true;
    });
    const qty = document.createElement("input");
    qty.type = "number";
    qty.min = "1";
    qty.max = "9999";
    qty.placeholder = "Qty";
    qty.ariaLabel = `Quantity for item ${index + 1}`;
    qty.required = true;
    qty.value = item.qty || "";
    qty.addEventListener("input", () => {
      item.qty = Number(qty.value) || null;
      item.touched = true;
    });
    const price = document.createElement("p");
    price.className = "george-price";
    const amount = formatEstimate(item);
    if (item.ballpark && amount) price.textContent = `Starting estimate ${amount}. Bulk pricing usually comes in better.`;
    else if (item.confirm || !amount) price.textContent = "Zachary will confirm the price.";
    else price.textContent = `${amount} estimate. Free delivery is included. Not a promise of stock.`;
    row.append(name, qty, price);
    itemsEl.appendChild(row);
  });
  bulkNote.textContent = draft.bulk ? BULK_LINE : "Free job-site delivery. Virginia sales tax is added unless the order is tax-exempt.";
  quoteForm.querySelector(".george-submit").textContent = draft.bulk ? "Send details to Zachary" : "Send quote";
  const hasItems = draft.items.some((item) => item.name);
  reviewButton.hidden = !hasItems;
  reviewButton.textContent = draft.open ? "Hide quote form" : "Review & send quote";
  quoteForm.hidden = !draft.open;
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
}

function openQuote() {
  draft.open = !draft.open;
  if (draft.open && !draft.items.length) addBlankItem();
  renderItems();
  if (draft.open) quoteForm.querySelector("input[name=name]")?.focus();
}

function absorbQuote(quote) {
  if (!quote) return;
  for (const item of quote.items || []) {
    const key = (item.sku || item.name || "").toLowerCase();
    if (!key) continue;
    const existing = draft.items.find((row) => (row.sku || row.name || "").toLowerCase() === key);
    if (existing) {
      existing.estimate = item.estimate;
      existing.estimateHigh = item.estimateHigh;
      existing.confidence = item.confidence;
      existing.kind = item.kind;
      existing.manufacturerUrl = item.manufacturerUrl;
      existing.categoryPage = item.categoryPage;
      if (item.qty && !existing.touched) existing.qty = item.qty;
    } else {
      draft.items.push({ ...item, touched: false });
    }
  }
  if (quote.bulk) draft.bulk = true;
  renderItems();
}

async function detect() {
  if (mode !== "unknown") return mode;
  if (preview) {
    mode = "local";
    return mode;
  }
  if (params.get("george") === "live") {
    mode = "live";
    return mode;
  }
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) });
    const data = await response.json();
    mode = response.ok && data.mode === "live" ? "live" : "local";
  } catch {
    mode = "local";
  }
  return mode;
}

async function ask(text) {
  await catalogReady;
  await detect();
  if (mode !== "live") {
    return localReply({
      message: text,
      catalog,
      discount: catalog.discountPercent,
      page: location.pathname,
    });
  }
  const history = messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-8);
  const response = await fetch(`${API}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ messages: history, page: location.href, sessionId }),
  });
  if (!response.ok) throw new Error("chat");
  return response.json();
}

async function onSend(event) {
  event.preventDefault();
  const text = textarea.value.trim();
  if (!text || busy) return;
  busy = true;
  textarea.value = "";
  addMessage("user", text);
  const pending = document.createElement("div");
  pending.className = "george-msg george-msg-bot";
  pending.textContent = "One second.";
  log.appendChild(pending);
  try {
    const result = await ask(text);
    pending.remove();
    addMessage("assistant", result.reply);
    absorbQuote(result.quote);
  } catch {
    pending.remove();
    const fallback = localReply({
      message: text,
      catalog,
      discount: catalog.discountPercent,
      page: location.pathname,
    });
    addMessage("assistant", fallback.reply);
    absorbQuote(fallback.quote);
    mode = "local";
  } finally {
    busy = false;
    textarea.focus();
  }
}

function formData() {
  const data = new FormData(quoteForm);
  return {
    name: String(data.get("name") || "").trim(),
    company: String(data.get("company") || "").trim(),
    phone: String(data.get("phone") || "").trim(),
    email: String(data.get("email") || "").trim(),
    jobsite: String(data.get("jobsite") || "").trim(),
    neededBy: String(data.get("neededBy") || "").trim(),
    notes: String(data.get("notes") || "").trim(),
    taxExempt: data.get("taxExempt") === "on",
    items: draft.items.map((item) => ({
      name: item.name,
      sku: item.sku,
      qty: Number(item.qty),
      estimate: item.estimate,
      estimateHigh: item.estimateHigh,
      confidence: item.confidence,
      kind: item.kind,
      manufacturerUrl: item.manufacturerUrl,
      categoryPage: item.categoryPage,
    })),
  };
}

async function onQuote(event) {
  event.preventDefault();
  errorEl.textContent = "";
  const lead = formData();
  if (lead.items.some((item) => !item.name || !item.qty)) {
    errorEl.textContent = "Each item needs a name and a quantity.";
    return;
  }
  if (!quoteForm.reportValidity()) return;
  const button = quoteForm.querySelector(".george-submit");
  button.disabled = true;
  try {
    if (preview && mode !== "live") {
      addMessage("assistant", "Preview only. Nothing was sent. On the live site this quote goes to Yorktown Tools.");
      return;
    }
    await detect();
    if (mode === "live") {
      const response = await fetch(`${API}/api/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lead),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        addMessage("assistant", data.message || "Yorktown Tools has the quote.");
        return;
      }
    }
    const response = await fetch(FORMSPREE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name: lead.name,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        delivery: lead.jobsite,
        needed_by: lead.neededBy,
        message: lead.items.map((item) => `${item.qty} x ${item.name}`).join("\n"),
        _subject: "George chat quote",
      }),
    });
    if (!response.ok) throw new Error("form");
    addMessage("assistant", "Yorktown Tools has the quote. If you don't see an email, call or text (757) 940-5171.");
  } catch {
    errorEl.textContent = "That didn't send. Call or text (757) 940-5171 and we'll take it from there.";
  } finally {
    button.disabled = false;
  }
}

function openPanel() {
  panel.hidden = false;
  launcher.setAttribute("aria-expanded", "true");
  if (!log.childElementCount) {
    if (preview) showBanner("Preview on this computer. Quotes are not emailed from here.");
    addMessage("assistant", "Hey, I'm George with Yorktown Tools. You build the project. We deliver the tools. What do you need on the job?");
    chips();
    detect();
  }
  textarea.focus();
}

function closePanel() {
  panel.hidden = true;
  launcher.setAttribute("aria-expanded", "false");
  launcher.focus();
}

launcher.addEventListener("click", openPanel);
root.querySelector(".george-close").addEventListener("click", closePanel);
compose.addEventListener("submit", onSend);
quoteForm.addEventListener("submit", onQuote);
root.querySelector(".george-add").addEventListener("click", () => {
  addBlankItem();
  draft.open = true;
  renderItems();
});
reviewButton.addEventListener("click", openQuote);

document.addEventListener("keydown", (event) => {
  if (panel.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePanel();
  }
});

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    compose.requestSubmit();
  }
});
