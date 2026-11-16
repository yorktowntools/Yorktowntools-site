import { CLOSING_LINE, HANDOFF_LINE, READY_LINE } from "./copy.js";
import { interpretLine, normalizeTrade } from "./trade.js";

const BRANDS = "dewalt|milwaukee|makita|bosch|hilti|festool|metabo|ridgid|skil|flex|hercules|kobalt";

function users(history, latest = "") {
  return [...(history || []).filter((entry) => entry.role === "user").map((entry) => entry.content || ""), latest]
    .filter(Boolean);
}

export function userBlob(history, latest = "") {
  return users(history, latest).join("\n");
}

export function eachQty(text) {
  const match = String(text || "").trim().match(/^(?:just\s+)?(\d+|one|a|an)\s+each\b/i);
  if (!match) return null;
  if (/^one|a|an$/i.test(match[1])) return 1;
  const qty = Number(match[1]);
  return qty > 0 ? qty : null;
}

export function productsInText(text) {
  return interpretLine(text).tools.map((tool) => tool.name);
}

export function cartFromThread(history, latest = "") {
  const items = [];
  for (const line of users(history, latest)) {
    const qty = eachQty(line);
    if (qty) {
      items.forEach((item) => { item.qty = qty; });
      continue;
    }
    for (const name of productsInText(line)) {
      if (!items.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        items.push({ name, qty: null, sku: "", source: "U" });
      }
    }
  }
  return items;
}

export function readIdentity(history, latest = "") {
  const identity = { name: "", first: "", company: "", phone: "", email: "", knowsZach: false, note: "" };
  for (const line of users(history, latest)) {
    const email = line.match(/\b[\w.+-]+@[\w.-]+\.\w+\b/);
    const phone = line.match(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/);
    if (email) identity.email = email[0];
    if (phone) identity.phone = phone[0];
    if (/\bzach knows me\b|\bknows zach\b/i.test(line)) {
      identity.knowsZach = true;
      identity.note = identity.note || "Zach knows me";
      const before = line.replace(/\bzach knows me\b|\bknows zach\b/ig, " ").replace(/\s+/g, " ").trim();
      if (before) identity.name = titleName(before);
    }
    const named = line.match(/\b(?:i'm|i am|my name is|this is)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i);
    const leading = line.match(/^([A-Za-z]+(?:\s+[A-Za-z]+)+)\b/);
    const picked = named?.[1] || (!identity.knowsZach ? leading?.[1] : "") || "";
    if (picked && !/yorktown|george|washington/i.test(picked)) {
      identity.name = titleName(picked.replace(/\s+(zach|and|at)$/i, "").trim());
    }
    const company = line.match(/\bat\s+([A-Za-z0-9&.' -]+?)(?:,|$)/i);
    if (company && !/zach/i.test(company[1])) identity.company = company[1].trim();
  }
  identity.first = identity.name.split(/\s+/)[0] || "";
  return identity;
}

export function askedForReach(history) {
  return (history || []).some((entry) => entry.role === "assistant" && /best cell or email/i.test(entry.content || ""));
}

function titleName(value) {
  return String(value || "").toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function washingtonReply() {
  return "Washington. Yorktown Tools is veteran-owned, inspired by the Battle of Yorktown and the Historic Triangle of Jamestown, Yorktown, and Williamsburg. I'm George Washington, and the mascot is George Washington running a saw.";
}

export function isLastNameAsk(text, history = []) {
  const raw = String(text || "").trim();
  if (/\blast name\b/i.test(raw)) return true;
  if (/\bmake it washington\b/i.test(raw)) return true;
  const prior = (history || []).some((entry) => entry.role === "assistant" && /George Washington running a saw/i.test(entry.content || ""));
  return prior && /^washington\b/i.test(raw);
}

export function sawAttributes(history, latest = "") {
  const blob = normalizeTrade(userBlob(history, latest));
  const size = blob.match(/(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)/);
  const voltage = /60\s*v|flexvolt/i.test(blob) ? "60V" : (/\b20\s*v\b/i.test(blob) ? "20V" : "");
  return {
    circular: /\b(?:circ(?:ular)?\s+saws?)\b/i.test(blob),
    brand: (blob.match(new RegExp(`\\b(${BRANDS})\\b`, "gi")) || []).pop()?.toLowerCase() || "",
    cordless: /\bcordless\b/i.test(blob) && !/\bcorded\b/i.test(blob),
    corded: /\bcorded\b/i.test(blob),
    voltage,
    size: size ? `${size[1]}-${size[2]}/${size[3]}` : "",
    brake: /\bbrake\b/i.test(blob),
    use: /\bwood\b/i.test(blob) ? "wood" : "",
    bare: /\bbare\b/i.test(String(latest || "")),
    kit: /\bkit\b/i.test(String(latest || "")),
  };
}

export function sawGuide(history, latest = "") {
  const attrs = sawAttributes(history, latest);
  if (!attrs.circular || attrs.brand !== "dewalt") return null;
  if (/\bDCS577/i.test(String(latest || ""))) return null;
  if (!attrs.size) {
    return "We can source a DeWalt circular saw. We don't keep a warehouse, so I'll confirm the lead time. What blade size do you want, and do you want a brake?";
  }
  if (!attrs.cordless && !attrs.corded) {
    return `DeWalt, ${attrs.size} in.${attrs.brake ? " with a brake" : ""}. Corded or cordless?`;
  }
  if (attrs.cordless && !attrs.voltage) {
    return "Cordless DeWalt. Do you want 20V MAX or 60V FLEXVOLT?";
  }
  if (attrs.voltage === "60V" && attrs.size === "8-1/4") {
    if (attrs.bare) return null;
    if (attrs.kit && !attrs.bare) {
      return "The kit in that family is the DeWalt DCS577X1. How many do you want?";
    }
    return "That's a DeWalt 60V MAX FLEXVOLT 8-1/4 in. cordless circular saw with a brake, in the DCS577 family. The DCS577B is the bare tool and the DCS577X1 is the kit. Which one do you want, and how many?";
  }
  const bits = [`DeWalt ${attrs.size} in.`, attrs.cordless ? "cordless" : "corded", attrs.brake ? "with a brake" : ""].filter(Boolean);
  return `${bits.join(" ")}. What are you cutting?`;
}

export function listReadback(items) {
  const names = (items || []).filter((item) => item?.name);
  if (!names.length) return "";
  const read = names.map((item) => `${item.qty || 1} × ${item.name}`).join(", ");
  const team = names.length > 1 ? "Those are for our team to price." : "That one's for our team to price.";
  return `I have ${read}. ${team} What's your name, company, and cell or email?`;
}

export function readyClose(identity, alreadyAsked) {
  if (identity.phone || identity.email) return READY_LINE;
  if (identity.knowsZach && !alreadyAsked) {
    const who = identity.first ? `Thanks, ${identity.first}. ` : "";
    return `${who}I'll note that he knows you. What's the best cell or email so we can reach you?\n\n${READY_LINE}`;
  }
  return `${HANDOFF_LINE} ${CLOSING_LINE}`;
}
