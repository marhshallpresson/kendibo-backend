# WhatsApp AI assistant: what to connect, and pricing recommendations

## 1. What to connect (in order)

| # | Account / service | What you get | Where it goes |
|---|---|---|---|
| 1 | **Fix the API deployment on Pxxl.** As of 30 Oct 2026, `api-kendibo.pxxlspace.cv` says "Domain not connected". | Everything below depends on this. | Pxxl dashboard → project → domains |
| 2 | **Meta Business Manager**: verified business, WhatsApp Business Account, a Nigerian phone number | `WHATSAPP_PHONE_NUMBER_ID`, a System User token in `WHATSAPP_ACCESS_TOKEN`, the App Secret in `WHATSAPP_APP_SECRET` | Webhook `<API>/webhooks/whatsapp`, subscribed to `messages`. Register the business account in Nigeria (authentication messages cost about 5× more otherwise). |
| 3 | **WhatsApp utility templates**: job offer for vendors, "vendor accepted + pay", job reminder | Messages outside the 24-hour customer-service window | WhatsApp Manager → Message templates |
| 4 | **Anthropic API** (console.anthropic.com) | `ANTHROPIC_API_KEY` | Set a monthly spend limit. `WHATSAPP_AI_MODEL`: `claude-opus-5-5` (default) or `claude-haiku-5-5` (fastest and cheapest) |
| 5 | **Google Cloud**: Maps JavaScript API, Places API (New), Geocoding API | `GOOGLE_MAPS_BROWSER_KEY`, restricted to the referrer `<API>/w/*` | Without it the page still works with GPS and a typed address |
| 6 | **Bachs.io live keys** | `BACHS_*` | The only payment provider. Flutterwave has been removed. |
| 7 | Set `WHATSAPP_BUSINESS_NUMBER`, `WHATSAPP_LINK_SECRET` and `WHATSAPP_WEB_BASE_URL` | | `.env` |

Check `GET /v1/admin/integrations` (it shows which keys are set, never their values).

## 2. How a request flows

1. The customer says "hi". The bot sends a fixed welcome asking for **what needs fixing, a photo, a budget and when**, with three buttons.
2. The **AI agent** (Claude, tools only) captures the need, picks the trade from the real catalog, stores photos and the budget, and sends the **Set location** button.
3. The location page opens inside WhatsApp's browser: drag the pin, search an address, tap a nearby landmark chip. The server checks the area is covered, and the agent carries on in the chat automatically.
4. **submit_job_request** creates the request, ranks vendors with the matching model, and sends the **See vendors** button.
5. The vendors page shows verified vendors, real ratings (or "New"), distance and why they matched. The customer picks one, or chooses "Let Kendibo pick".
6. The vendor gets Accept / Decline buttons on WhatsApp. When they accept, the customer gets a Bachs payment link (or a "they'll quote first" message).
7. For complaints, refunds or safety issues, **talk_to_human** opens a support ticket and pauses the bot for 12 hours (the customer can type `bot` to resume).

What the AI cannot do: set prices, confirm payments, assign vendors, or read other users' data. Every action is a server tool that validates its input.

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
- **WhatsApp costs:** budget about ₦50–80 of WhatsApp messages per booking (utility templates). Keep marketing broadcasts small, since they cost about 7× as much.

Sources are in the research report in the conversation (Connect Nigeria, Skillland, Onexportal, Gotwork, CraftRanked, Wrkman, NBS/Nairametrics, Meta rate pages and others).
