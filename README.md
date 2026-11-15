# George — Yorktown Tools chat assistant

George is the chat button on [yorktowntools.com](https://yorktowntools.com). He answers in a plain voice, gives an **estimate** (never a promise of stock), and sends a quote to the customer and to sales@yorktowntools.com.

He is built for a small volume of chats. The target is a few dollars a month, not a call center.

This file is the setup guide. The short click-through list is in [george/TEST-PLAN.md](george/TEST-PLAN.md).

You do **not** put passwords in the website files. The site on GitHub never sees the xAI key or the email key. Those live as secrets on Cloudflare.

## What you have to create

1. An [xAI](https://console.x.ai) account and an API key (this is the Grok account).
2. A free [Cloudflare](https://dash.cloudflare.com) account. This runs the small program that holds the keys.
3. A free [Resend](https://resend.com) account, so quote emails can be sent from a **subdomain**. The Zoho mail for sales@yorktowntools.com stays as it is.
4. Node.js on the computer you deploy from (the website itself does not need Node). Install the Current or LTS version from [nodejs.org](https://nodejs.org).

Nothing here is merged or deployed for you. After you review the change, you publish the site the same way you already do. Then you deploy the Worker yourself with the steps below.

## What it costs

Checked against xAI’s public prices in November 2026. Confirm them on [docs.x.ai](https://docs.x.ai/developers/pricing) before you rely on them.

| Piece | Plan | Assumption |
| --- | --- | --- |
| GitHub Pages | $0 | The site you already have |
| Cloudflare Worker | $0 | Free tier. A quiet site stays under the daily request cap |
| Resend | $0 | Free tier is 3,000 emails/month and 100/day |
| Grok tokens | about $1–$3 | `grok-4.3` at $1.25 per million input tokens and $2.50 per million output tokens |
| Web search | about $0.25–$1 | $5 per 1,000 searches. George only searches when the price list has no firm number, and at most 2 searches per chat |

**A quiet month (about 150 messages, about 80 of them needing one search):** roughly **$1 to $3**.

**A busier month (about 1,000 messages and 400 searches):** roughly **$10 to $15**.

If you change `XAI_MODEL` to `grok-4.7`, token prices are higher ($2 input / $6 output per million). Leave the default unless you have a reason. No-search replies use `grok-4.3` with reasoning turned off (`reasoning.effort` `none`). Search replies stay on the same model with reasoning `low`.

The Worker also caps abuse: 20 chats an hour and 60 a day per network address, 8 quote emails a day, 2 web searches per chat, 15 searches a day per address, and only the last 8 messages are sent. Set a monthly spending limit in the xAI console if you see that setting, and glance at usage the first few weeks. The caps live in memory on the Worker, so they reset if Cloudflare moves the program. The xAI spending limit is the real ceiling.

## How a price is built

Homeowners and one-off orders should be able to finish on their own. Contractors and government buyers are the accounts to grow.

- A small order matches the shelf price. `matchPercentBelow` in `worker/config/rules.js` is **0**. Fuel is folded into the item price when the drive is long enough. The quote still says delivery is free.
- If a price would sit under the margin floor, George does not show it. He says we'll confirm the price.
- A bulk order is not a locked price. George gives a starting estimate, says bulk pricing usually comes in better, and the customer email says we'll send the bulk pricing. The customer never hears the founder's name.
- Gloves and shirts marked `fixedPrice` stay at the price printed on the site. Virginia sales tax is 7% unless the buyer is government or tax-exempt, and a tax-exempt order needs a certificate.
- Card and a government purchase card, ACH, and check are shown on the quote with their fees. Net terms stay approval-only.
- He never tells a customer your cost, your margin, a supplier, or where an item was picked up. He never names other retailers. Change the numbers only in `worker/config/rules.js`.
- Private product costs are not in the website or in git. Set the Worker secret `PRIVATE_COSTS_JSON`, keyed by catalog sku: `{"SKU":{"privateCost":1.23,"costSource":"example"}}`. `1.23` is a fake example. A quote uses cost × 1.20 only when that result is at or below the shelf and the margin is at least 10%. Otherwise it uses the shelf, or says we'll confirm the price. If the secret is missing, George just uses the shelf. The customer never sees the cost or who it came from.
- Every email to sales@ includes the tier. A company that looks like a bulk or ongoing account is **TIER 1 / PRIORITY**. A small order is still an instant quote, even from a big company. Homeowners are tier 3.

## 1. Preview George on your computer

No accounts needed.

1. Open a terminal in this project folder.
2. Run:

```bash
python3 -m http.server 8765
```

3. In a browser, open `http://127.0.0.1:8765/?george=mock`.
4. Click **Ask George**. Follow [george/TEST-PLAN.md](george/TEST-PLAN.md).

On your own computer the quote button does **not** email anyone. On the real site, if the Worker is not up yet, the quote still goes to the existing Formspree form so a lead is not lost.

Check the filters from the terminal:

```bash
node --test worker/test/george.test.js
```

## 2. Create the xAI key

1. Sign in at [console.x.ai](https://console.x.ai).
2. Create an API key.
3. Copy it somewhere safe (a password note, not a website file). You only see the full key once.
4. If the console offers a monthly spending cap, set one. Ten dollars is plenty while you are testing.

## 3. Put the Worker on Cloudflare

The Worker is the program in the `worker` folder. Wrangler is Cloudflare’s upload tool. You do not install it by hand. `npx` downloads it for the command, then you can close the terminal.

1. Create a free Cloudflare account.
2. In the project folder run:

```bash
npx wrangler login
```

A browser window opens. Approve it.

3. Send the two secrets. Paste each value when asked. They are not saved in the project.

```bash
npx wrangler secret put XAI_API_KEY
npx wrangler secret put RESEND_API_KEY
```

You can deploy before Resend exists. Skip the Resend secret until step 5, then run that one command and deploy again. Until then, quotes fall back to Formspree.

4. From the `worker` folder, upload:

```bash
cd worker
npx wrangler deploy
```

The last lines print a URL that looks like `https://yorktown-george.<your-account>.workers.dev`.

5. Check it. This address is the workers.dev one from the deploy output:

```bash
curl https://yorktown-george.<your-account>.workers.dev/api/health
```

You want `"ok": true` and `"mode": "live"`. `"mode": "mock"` means the xAI key is missing.

## 4. Optional later: point george.yorktowntools.com at the Worker

The chat button currently calls the workers.dev address:

`https://yorktown-george.yorktowntools.workers.dev`

That is set in `george/george.js` (`window.GEORGE_API` overrides it). A custom domain is optional and does not replace the website or touch email. When you want it:

1. In the Cloudflare dashboard, open the Worker **yorktown-george** → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.
2. Enter `george.yorktowntools.com`.
3. Cloudflare shows DNS records. Your domain is at GoDaddy, so copy the records into GoDaddy yourself. Do not turn on Cloudflare’s proxy (the orange cloud) for a record they tell you to add as DNS-only.
4. In GoDaddy: **My Products** → **yorktowntools.com** → **DNS** → **Add**.
5. Add only what Cloudflare shows. It is usually a **CNAME**:
   - Type: `CNAME`
   - Name: `george`
   - Value: the target Cloudflare shows
   - TTL: default
6. Leave these alone:
   - The A records and `www` CNAME that point the website at GitHub Pages
   - Every **MX** record (those are Zoho, for sales@yorktowntools.com)
   - Any TXT record you already use for Zoho or the website

Wait a few minutes, then open `https://george.yorktowntools.com/api/health`.

When that works, change the fallback in `george/george.js` from the workers.dev URL to `https://george.yorktowntools.com` and publish the site. Until then, leave the workers.dev address in place.

## 5. Send quote email from a subdomain

Resend sends the branded quote. Use a subdomain so Zoho’s MX records stay on `@`.

1. Create a free Resend account.
2. Add the domain `quotes.yorktowntools.com`. Do not add the root `yorktowntools.com`.
3. Open the records Resend shows. Copy them exactly. Resend has used either TXT + MX, or CNAMEs, depending on when the domain was added. **Use the records on your screen if they differ from this example.**

Example, when Resend shows the older TXT and MX pair. In GoDaddy the name is the part **before** `yorktowntools.com`.

| Type | Name | Value | Priority |
| --- | --- | --- | --- |
| MX | `send.quotes` | `feedback-smtp.us-east-1.amazonses.com` | 10 |
| TXT | `send.quotes` | `v=spf1 include:amazonses.com ~all` | |
| TXT | `resend._domainkey.quotes` | the long value Resend shows | |

If your Resend region is not `us-east-1`, the MX host will name that region instead. Copy theirs.

4. Do **not** add an MX record on `@`. Do **not** edit the existing Zoho MX records. The new MX is only for `send.quotes`, which is `send.quotes.yorktowntools.com`.
5. Click verify in Resend. DNS can take a few minutes and sometimes a few hours.
6. Create an API key in Resend and run:

```bash
npx wrangler secret put RESEND_API_KEY
```

7. The From address in `worker/wrangler.toml` is `Yorktown Tools <quotes@quotes.yorktowntools.com>`. Replies go to sales@yorktowntools.com. Deploy again:

```bash
cd worker
npx wrangler deploy
```

Send yourself a quote from the site. You should get the branded email, and sales@ should get the same message as a blind copy.

If Resend fails, the Worker posts the same lead to the existing Formspree form (`https://formspree.io/f/xanlvyan`). The customer may not get the pretty email in that case. The lead still reaches you.

## 6. Update the price list

Edit `data/prices.json`.

- `shelfPrice` is the shelf price George matches for a small order. The knobs (match percent, tax, fees, fuel) are in `worker/config/rules.js`.
- `fixedPrice: true` means “use `price` as printed on our site” (the gloves and the shirts).
- A `shelfLow` / `shelfHigh` pair with no `shelfPrice` is only a range. George will say he needs to confirm it. Replace it with one `shelfPrice` when you have checked the number.
- Do not type a retailer name, your cost, or a supplier name in this file.

The numbers are copied into the Worker when you deploy. After every edit:

```bash
cd worker
npx wrangler deploy
```

Publish the website too, so the no-key fallback in the browser sees the same file.

To change the match, the tax, the fees, or the fuel numbers, edit `worker/config/rules.js` and deploy the Worker again. Do not put those notes in a customer reply.

## 7. Publish the website

The chat button, the privacy page, the company field, and the extra manufacturer links are ordinary files in this repository. Publish them the way you already publish yorktowntools.com (GitHub Pages). You do not publish them with Wrangler.

Until `https://yorktown-george.yorktowntools.workers.dev/api/health` returns `"mode": "live"`, George still answers from the on-site price list and the quote form uses Formspree. The same check applies after you switch the button to `george.yorktowntools.com`.

## Useful files

| File | What it is |
| --- | --- |
| `george/george.js` | The button and the panel |
| `george/george.css` | The panel’s look |
| `privacy.html` | Privacy page, linked from the chat and the footer |
| `data/prices.json` | The short price list |
| `worker/` | The Cloudflare program |
| `george/TEST-PLAN.md` | What to click |

## If something breaks

- **Health says mock.** The xAI secret is empty. Run `npx wrangler secret put XAI_API_KEY` and deploy again.
- **The button never reaches the Worker.** Open `https://yorktown-george.yorktowntools.workers.dev/api/health`. You want `"mode": "live"`. If you already switched the button to `george.yorktowntools.com` and that health check fails, the GoDaddy CNAME for `george` is wrong or still propagating. The website’s own A records should be unchanged.
- **Mail to sales@ stops arriving.** You edited an `@` MX record. Put the Zoho MX records back. George’s mail records belong on `send.quotes` and `resend._domainkey.quotes` only.
- **Resend will not verify.** Compare every character with the Resend screen, including the region name in the MX or CNAME. Do not proxy those records.
- **A customer got a retailer name.** That is a bug. Do not keep chatting. Call them. Then check `worker/test/george.test.js` still passes.
- **The bill looks high.** In `worker/wrangler.toml`, lower `RATE_LIMIT_CHAT_PER_DAY` and `MAX_SEARCHES_PER_IP_DAY`, and set the xAI spending cap. Deploy again.
