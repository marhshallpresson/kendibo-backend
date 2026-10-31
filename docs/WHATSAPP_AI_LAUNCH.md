# WhatsApp AI assistant: what to connect, and pricing recommendations

## 1. What to connect (in order)

| # | Account / service | What you get | Where it goes |
|---|---|---|---|
| 1 | **Fix the API deployment on Pxxl.** As of 30 Oct 2026, `api-kendibo.pxxlspace.cv` says "Domain not connected". | Everything below depends on this. | Pxxl dashboard → project → domains |
| 2 | **Meta Business Manager**: verified business, WhatsApp Business Account, a Nigerian phone number | `WHATSAPP_PHONE_NUMBER_ID`, a System User token in `WHATSAPP_ACCESS_TOKEN`, the App Secret in `WHATSAPP_APP_SECRET` | Webhook `<API>/webhooks/whatsapp`, subscribed to `messages`. Register the business account in Nigeria (authentication messages cost about 5× more otherwise). |
| 3 | **WhatsApp utility templates**: job offer for vendors (1 variable + Accept/Decline quick replies) and "vendor accepted + pay" (vendor, amount, link) | Messages outside the 24-hour customer-service window. Until they are approved and named in `WHATSAPP_TEMPLATE_JOB_OFFER` / `WHATSAPP_TEMPLATE_VENDOR_ACCEPTED`, those messages go by SMS through Sling. | WhatsApp Manager → Message templates |
| 4 | **Anthropic API** (console.anthropic.com), optional | `ANTHROPIC_API_KEY` | Only used for messages the classifier is unsure about, capped by `WHATSAPP_AI_DAILY_TURNS` (per customer) and `WHATSAPP_AI_GLOBAL_DAILY_TURNS`. Set a monthly spend limit. `WHATSAPP_AI_MODEL`: `claude-opus-5-5` (default) or `claude-haiku-5-5` (fastest and cheapest) |
| 5 | **Google Cloud**: Maps JavaScript API, Places API (New), Geocoding API | `GOOGLE_MAPS_BROWSER_KEY`, restricted to the referrer `<API>/w/*` | Without it the page still works with GPS and a typed address |
| 6 | **Bachs.io live keys** | `BACHS_*` | The only payment provider. Flutterwave has been removed. |
| 7 | Set `WHATSAPP_BUSINESS_NUMBER`, `WHATSAPP_LINK_SECRET` and `WHATSAPP_WEB_BASE_URL` | | `.env` |

Check `GET /v1/admin/integrations` (it shows which keys are set, never their values).

## 2. How a request flows

The assistant was rebuilt (Nov 2026) as a deterministic flow with an in-process understanding layer, so it works fully without an AI key and stays inside the use case Meta allows (since 15 Jan 2026 WhatsApp bars general-purpose AI assistants; booking and support bots with a human hand-off are fine).

1. **Understanding** (`modules/whatsapp/nlu`). Every text is read by our own intent and scope classifier (character n-grams + logistic regression, trained in-process on ~540 starter lines in Nigerian English and Pidgin plus every line ops label). Deterministic extractors read the trade ("my AC dey leak"), the budget ("15k", "₦20,000", "twenty thousand"), the day ("next tomorrow", "Saturday", "5 Nov") and the time ("by 4", "morning"). Explicit dates use chrono-node, the one open-source library added.
2. **Booking flow** (`flow.ts`). One message per step, with buttons or lists: what needs doing → trade → photo (optional) → budget (optional) → location (our map page or a shared WhatsApp location) → day → time → summary with **Find vendors** / **Change something**. Anything the customer already said is filled in and skipped, so "my AC dey leak water, budget 15k, tomorrow morning" goes straight to the photo, then the location, then the summary.
3. **Matched vendors**. Confirming creates the request, ranks vendors with the matching model, and sends **See vendors**. The vendor gets Accept / Decline; when they accept, the customer gets a Bachs payment link (or a "they'll quote first" note).
4. **Questions** about payments, refunds, prices (from the catalogue), coverage, safety, warranty or joining as a vendor get the official answers in `facts.ts`, then the open step again. **Off-topic** requests are declined without any AI call.
5. **A person**: "agent", complaints, damage, refunds and safety go to the support inbox; the bot stays quiet until the customer types `bot` (or 12 hours of quiet).
6. **AI fallback**: only messages the classifier is unsure about go to Claude (tools only, scope-restricted prompt, daily caps). Without a key they get a clarifying question.

Rules enforced on every message (`policy.ts`): the first reply says it is an automated assistant; STOP / START control promotions; free-form messages only within 24 hours of the customer's last message (otherwise an approved template or SMS); at most 40 inbound messages per number per hour. Inbound messages are processed one at a time per customer and a turn interrupted by a crash is retried once.

What the AI cannot do: set prices, confirm payments, assign vendors, or read other users' data. Every action is a server tool that validates its input.

### Improving understanding

Each customer text is logged to `ml.nlu_event` **redacted** (no phone numbers, emails, codes or ID numbers; the WhatsApp id is hashed) with what the router did. In the admin console, **WhatsApp assistant** shows the review queue (lines it was unsure about, sent to the AI, or declined). Label them, then **Retrain** (or `npm run ml:train-nlu`): the new model only switches on if its held-out macro-F1 is at least the current one's. Unlabelled lines are deleted after 180 days. `npm run ml:eval-nlu` prints held-out accuracy on the starter lines (about 75% end to end at launch; the router acts on its own only when confident, about half of messages at ~92% precision, and asks otherwise).

## 3. The matching model, trained on your data

- Every list shown is logged to `ml.match_event` with its features. Outcomes are added later: whether the vendor accepted, whether the job was completed, and the rating.
- `npm run ml:train` (run it nightly) fits a logistic regression. It only switches to the new model if that beats the current one on held-out requests (AUC ≥ 0.6) and has at least 200 labelled rows. Until then the hand-set starting weights are used.
- Data to collect from day one: the photos and need text on each request, offer response times, completion photos, and the reasons customers give for cancelling.

## 4. Pricing recommendations for Nigeria

These are from desk research in October 2026 and are indicative; run a quick 10–15 artisan quote survey in Uyo before publishing prices.

- **Commission by category:** cleaning and fumigation **15%**, repairs **12%**, big jobs over ₦150k **8% capped at about ₦25k**. For comparison: CraftRanked takes 15%, Wrkman about 10%, and Gotwork's 2% doesn't cover the roughly 2% card fees.
- **Call-out / inspection fee, credited to the job if the customer goes ahead:** Uyo ₦3,000, Abuja ₦5,000, Lagos ₦5,000–7,000.
- **Uyo launch packages:**
  - Standard clean, 1/2/3-bed: ₦15k / 22k / 28k
  - Deep clean, 1/2/3-bed: ₦20k / 28k / 38k
  - Fumigation, 1/2/3-bed: ₦10k / 15k / 22k
  - AC service: ₦10k per unit
  - Small generator service: ₦12k
  - Lagos and Abuja: +25–35%
- **Customer service fee:** none at the Uyo launch. Add ₦300–500 flat in Lagos and Abuja later.
- **Deposits:** take a 30–50% deposit through Bachs, held by Kendibo until the job is done, on jobs over ₦50k (so vendors can buy materials).
- **Payment options:** make bank transfer the default. Allow cash only for repeat customers. Offer the guarantee only when payment goes through the app.
- **Recurring plans:** recurring cleaning at 10–15% off, and AC/generator maintenance plans. Avoid "fix anything" annual plans.
- **Vendor earnings:** a vendor's net pay for a typical day should be at least the local day rate (Uyo ₦10–15k, Lagos ₦15–25k).
- **WhatsApp costs:** since 1 Oct 2026 Meta bills service messages (replies) beyond 1,000 a month per number, and utility templates even inside the 24-hour window. The flow sends one message per step (about 8–10 per booking). Budget about ₦50–80 of WhatsApp messages per booking and keep marketing broadcasts small, since they cost about 7× as much.

Sources are in the research report in the conversation (Connect Nigeria, Skillland, Onexportal, Gotwork, CraftRanked, Wrkman, NBS/Nairametrics, Meta rate pages and others).
