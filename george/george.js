import { BULK_LINE, GREETING, LEAD_FAILURE_LINE, LEAD_SUCCESS_LINE, PHONE_DISPLAY, PHONE_TEL } from "../shared/copy.js";
import { filterCustomerText, renderSafeHtml } from "../shared/customer-text.js";
import { localReply } from "../shared/local-reply.js";
import { isGluedModelLabel } from "../shared/models.js";

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
let draft = { items: [], open: false, sent: false };
let busy = false;

try {
  sessionStorage.removeItem("george-lead-sent");
  sessionStorage.removeItem("george-session");
  sessionId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `web${Date.now()}`;
} catch {
  sessionId = `web${Date.now()}`;
}

const mascotPng = new URL("./george-mascot.png", import.meta.url).href;
function mascotPicture(className, width, height) {
  return `<img class="${className}" src="${mascotPng}" alt="" width="${width}" height="${height}">`;
}

const catalogReady = fetch(new URL("../data/prices.json", import.meta.url))
  .then((response) => response.json())
  .then((data) => {
    catalog = data;
  })
  .catch(() => {});

const root = document.createElement("div");
root.innerHTML = `
  <div class="george-backdrop" hidden></div>
  <button type="button" class="george-launcher" aria-label="Chat with George for a free quote" aria-expanded="false" aria-controls="george-panel">
    ${mascotPicture("george-launcher-mascot", 72, 68)}
    <span class="george-launcher-copy">
      <strong>Chat with George</strong>
      <small>Free quotes from our team</small>
    </span>
  </button>
  <section id="george-panel" class="george-panel" role="dialog" aria-modal="true" aria-labelledby="george-title" hidden>
    <header class="george-head">
      ${mascotPicture("george-head-avatar", 44, 42)}
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
    <p class="george-done" hidden>Request sent ✓</p>
    <button type="button" class="george-review" hidden>Optional: review request</button>
    <form class="george-quote" hidden>
      <div class="george-quote-bar">
        <h3>Optional request form</h3>
        <button type="button" class="george-quote-close">Close</button>
      </div>
      <p class="george-bulk"></p>
      <div class="george-items"></div>
      <button type="button" class="george-add">Add an item</button>
      <div class="george-fields">
        <label class="george-wide">Name <input name="name" autocomplete="name" required></label>
        <label class="george-wide">Company, if this is for a business <input name="company" autocomplete="organization"></label>
        <label>Phone <input name="phone" type="tel" autocomplete="tel"></label>
        <label>Email <input name="email" type="email" autocomplete="email"></label>
        <label class="george-wide">City and state <input name="jobsite" autocomplete="address-level2" placeholder="City, ST"></label>
        <label>Needed by <input name="neededBy" type="date"></label>
        <label class="george-wide"><input name="taxExempt" type="checkbox"> Government or tax-exempt. A certificate is required.</label>
        <label class="george-wide">Notes <textarea name="notes" rows="2" placeholder="For a company account: how often you order"></textarea></label>
      </div>
      <p class="george-error" role="alert"></p>
      <button type="submit" class="george-submit">Send my request</button>
    </form>
    <form class="george-compose">
      <textarea aria-label="Message to George" rows="2" maxlength="1200" placeholder="Brand, model, quantity"></textarea>
      <button type="submit" class="george-send">Send</button>
    </form>
    <div class="george-foot">
      <a href="/privacy.html">Privacy</a>
      <span>Free quotes. ${PHONE_DISPLAY}</span>
    </div>
  </section>
`;
document.body.appendChild(root);

const launcher = root.querySelector(".george-launcher");
const backdrop = root.querySelector(".george-backdrop");
const panel = root.querySelector(".george-panel");
const log = root.querySelector(".george-log");
const quoteForm = root.querySelector(".george-quote");
const reviewButton = root.querySelector(".george-review");
const doneEl = root.querySelector(".george-done");
const itemsEl = root.querySelector(".george-items");
const compose = root.querySelector(".george-compose");
const textarea = compose.querySelector("textarea");
const errorEl = root.querySelector(".george-error");
const bulkNote = root.querySelector(".george-bulk");

const messages = [];

function addMessage(role, text) {
  const safe = role === "user"
    ? String(text || "")
    : (filterCustomerText(text).text || "Call or text (757) 940-5171 and we'll take it from here.");
  messages.push({ role, content: safe });
  const bubble = document.createElement("div");
  bubble.className = `george-msg george-msg-${role === "user" ? "user" : "bot"}`;
  if (role === "user") bubble.textContent = safe;
  else bubble.innerHTML = renderSafeHtml(safe);
  log.appendChild(bubble);
  pinLog();
}

function pinLog() {
  log.scrollTop = log.scrollHeight;
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
    qty.required = false;
    qty.value = item.qty || "";
    qty.addEventListener("input", () => {
      item.qty = Number(qty.value) || null;
      item.touched = true;
    });
    row.append(name, qty);

    itemsEl.appendChild(row);
  });
  bulkNote.textContent = draft.sent
    ? "Your request is already with our team."
    : (draft.bulk ? BULK_LINE : "This form is optional. George can send your request from the chat. Use this only if you want to review or add something.");
  quoteForm.querySelector(".george-submit").textContent = "Send my request";
  const hasItems = draft.items.some((item) => item.name);
  if (draft.sent) {
    reviewButton.hidden = true;
    quoteForm.hidden = true;
    draft.open = false;
    doneEl.hidden = false;
  } else {
    doneEl.hidden = true;
    reviewButton.hidden = !hasItems;
    reviewButton.textContent = draft.open ? "Hide optional form" : "Optional: review request";
    quoteForm.hidden = !draft.open;
  }
  pinLog();
  requestAnimationFrame(() => {
    if (quoteForm.hidden) return;
    const last = itemsEl.lastElementChild;
    if (!last) {
      quoteForm.scrollTop = 0;
      return;
    }
    const formRect = quoteForm.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const overflow = lastRect.bottom - (formRect.top + quoteForm.clientHeight);
    if (overflow > 0) quoteForm.scrollTop += overflow + 8;
  });
}

function openQuote() {
  draft.open = !draft.open;
  if (draft.open && !draft.items.length) addBlankItem();
  renderItems();
}

function cleanCartItem(item) {
  if (!item || !item.name) return null;
  if (isGluedModelLabel(item.name) || isGluedModelLabel(item.sku)) return null;
  return item;
}

function absorbQuote(quote) {
  if (!quote) return;
  const incoming = (quote.items || []).map(cleanCartItem).filter(Boolean);
  if (quote.hold && !quote.offerForm && !incoming.length) {
    draft.pendingBulk = Boolean(quote.bulk) || draft.pendingBulk;
    return;
  }
  if (quote.hold && !quote.offerForm) {
    draft.pending = incoming;
    draft.pendingBulk = Boolean(quote.bulk);
    if (!draft.sent) mergeCart(incoming);
    if (quote.bulk || draft.pendingBulk) draft.bulk = true;
    renderItems();
    return;
  }
  const rows = incoming.length ? incoming : (draft.pending || []);
  mergeCart(rows);
  if (quote.bulk || draft.pendingBulk) draft.bulk = true;
  if (quote.offerForm && !draft.sent) draft.open = true;
  draft.saidConfirm = false;
  renderItems();
}

function mergeCart(incoming) {
  for (const item of incoming || []) {
    const clean = cleanCartItem(item);
    if (!clean) continue;
    const key = (clean.sku || clean.model || clean.name || "").toLowerCase();
    if (!key) continue;
    const existing = draft.items.find((row) => (row.sku || row.model || row.name || "").toLowerCase() === key);
    if (existing) {
      existing.name = clean.name || existing.name;
      existing.sku = clean.sku || existing.sku;
      existing.model = clean.model || existing.model;
      if (clean.qty && !existing.touched) existing.qty = clean.qty;
    } else {
      draft.items.push({ ...clean, touched: false });
    }
  }
}

function fillIdentity(identity) {
  if (!identity) return;
  const set = (name, value) => {
    if (!value) return;
    const field = quoteForm.querySelector(`[name="${name}"]`);
    if (field && !field.value) field.value = value;
  };
  set("name", identity.name);
  set("phone", identity.phone);
  set("email", identity.email);
  set("company", identity.company);
}

function markRequestSent() {
  draft.sent = true;
  draft.open = false;
  renderItems();
}

function applyServerState(result) {
  if (!result) return;
  if (result.identity) fillIdentity(result.identity);
  if (Array.isArray(result.cart) && result.cart.length) mergeCart(result.cart);
  if (result.leadSent || result.lead?.ok) {
    markRequestSent();
    return;
  }
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
      history: messages.slice(0, -1),
      catalog,
      discount: catalog.discountPercent,
      page: location.pathname,
    });
  }
  const history = messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-24);
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
  pending.className = "george-msg george-msg-bot george-typing";
  pending.setAttribute("aria-label", "George is typing");
  pending.innerHTML = "<span></span><span></span><span></span>";
  log.appendChild(pending);
  try {
    const result = await ask(text);
    pending.remove();
    addMessage("assistant", result.reply);
    absorbQuote(result.quote);
    applyServerState(result);
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
    applyServerState(fallback);
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
    items: draft.items.map((item) => {
      const row = { name: item.name, sku: item.sku };
      const qty = Number(item.qty);
      if (Number.isFinite(qty) && qty > 0) row.qty = qty;
      return row;
    }),
  };
}

async function onQuote(event) {
  event.preventDefault();
  errorEl.textContent = "";
  const lead = formData();
  if (lead.items.some((item) => !item.name)) {
    errorEl.textContent = "Each item needs a name.";
    return;
  }
  if (!lead.phone && !lead.email) {
    errorEl.textContent = "Add a phone number or an email so we can reach you.";
    return;
  }
  if (!quoteForm.reportValidity()) return;
  const button = quoteForm.querySelector(".george-submit");
  button.disabled = true;
  try {
    if (preview && mode !== "live") {
      addMessage("assistant", "Preview only. Nothing was sent. On the live site this request goes to Yorktown Tools.");
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
        addMessage("assistant", data.message || LEAD_SUCCESS_LINE);
        markRequestSent();
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
        message: `Source: George – website chat assistant\n\n${lead.items.map((item) => `${item.qty || ""} ${item.name}`.trim()).join("\n")}`,
        source: "George – website chat assistant",
        _subject: "New lead from George (yorktowntools.com chat)",
      }),
    });
    if (!response.ok) throw new Error("form");
    addMessage("assistant", LEAD_SUCCESS_LINE);
    markRequestSent();
  } catch {
    errorEl.textContent = "I wasn’t able to send your request to our team from here, and I don’t want it to get lost. Please text or email your list to 757-940-5171 or sales@yorktowntools.com and they’ll follow up with pricing and availability.";
  } finally {
    button.disabled = false;
  }
}

let lockedScrollY = 0;
let pageLocked = false;

function setPageInert(on) {
  for (const node of document.body.children) {
    if (node === root) continue;
    if (on) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }
}

function lockPage() {
  if (pageLocked) return;
  lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.position = "fixed";
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
  pageLocked = true;
  setPageInert(true);
}

function unlockPage() {
  if (!pageLocked) return;
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  pageLocked = false;
  setPageInert(false);
  window.scrollTo(0, lockedScrollY);
}

function fitToKeyboard() {
  const viewport = window.visualViewport;
  if (!viewport || panel.hidden) return;
  if (!window.matchMedia("(max-width: 640px)").matches) {
    panel.style.top = "";
    panel.style.height = "";
    return;
  }
  panel.style.top = `${viewport.offsetTop}px`;
  panel.style.height = `${viewport.height}px`;
}

function focusableInPanel() {
  return [...panel.querySelectorAll("a[href], button, input, textarea, select")].filter((node) => {
    if (node.disabled || node.getAttribute("aria-hidden") === "true") return false;
    return node.closest("[hidden]") == null;
  });
}

function openPanel() {
  panel.hidden = false;
  backdrop.hidden = false;
  launcher.hidden = true;
  launcher.setAttribute("aria-expanded", "true");
  lockPage();
  fitToKeyboard();
  if (!log.childElementCount) {
    if (preview) showBanner("Preview on this computer. Quotes are not emailed from here.");
    addMessage("assistant", GREETING);
    detect();
  }
  textarea.focus();
}

function closePanel() {
  panel.hidden = true;
  backdrop.hidden = true;
  panel.style.top = "";
  panel.style.height = "";
  launcher.hidden = false;
  launcher.setAttribute("aria-expanded", "false");
  unlockPage();
  launcher.focus();
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  try {
    if (!sessionStorage.getItem("george-launcher-nudge")) {
      window.setTimeout(() => {
        if (launcher.hidden || launcher.getAttribute("aria-expanded") === "true") return;
        launcher.classList.add("george-launcher-nudge");
        sessionStorage.setItem("george-launcher-nudge", "1");
      }, 3000);
    }
  } catch {}
  launcher.addEventListener("animationend", () => launcher.classList.remove("george-launcher-nudge"));
}

launcher.addEventListener("click", openPanel);
backdrop.addEventListener("click", closePanel);
root.querySelector(".george-close").addEventListener("click", closePanel);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fitToKeyboard);
  window.visualViewport.addEventListener("scroll", fitToKeyboard);
}
compose.addEventListener("submit", onSend);
quoteForm.addEventListener("submit", onQuote);
root.querySelector(".george-add").addEventListener("click", () => {
  addBlankItem();
  draft.open = true;
  renderItems();
});
reviewButton.addEventListener("click", openQuote);
root.querySelector(".george-quote-close").addEventListener("click", () => {
  if (draft.open) openQuote();
});

document.addEventListener("keydown", (event) => {
  if (panel.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePanel();
    return;
  }
  if (event.key !== "Tab") return;
  const items = focusableInPanel();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

textarea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    compose.requestSubmit();
  }
});
