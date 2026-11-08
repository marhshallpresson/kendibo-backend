# Kendibo email: admin alerts, lifecycle, retention and marketing

Code: `modules/notifications/admin-alerts.service.ts`, `lifecycle.service.ts`,
`email-layout.ts` (shared branded layout), routes in `apps/api/src/email.routes.ts`,
schema in migration `042_email_alerts_lifecycle.sql`.

## 1. Principles (what we borrowed from other marketplaces)

- **One job per email, one button.** Airbnb, Uber and TaskRabbit lifecycle mail is short,
  has a single call to action and is triggered by what the user did (or did not do), not
  by a calendar blast. We do the same: every template is 1–2 short paragraphs + 1 CTA.
- **Behaviour first, calendar second.** Thumbtack and TaskRabbit nudge on "started a request but
  didn't book" and "job done, rate your pro". These have the best open and conversion rates, so
  they are our first retention lever. Calendar-based mail (seasonal AC) is marketing and consented.
- **Supply side is onboarding-heavy.** Uber/Bolt driver onboarding and Chowdeck vendor onboarding
  send step-by-step "finish your profile" nudges at roughly 1 and 3 days, then a clear "you're
  approved, here's how to get your first job" and a weekly earnings statement. Providers get the same.
- **WhatsApp is the primary channel in Nigeria; email is the record.** Chowdeck and Bolt lean on
  push/WhatsApp for real-time and use email for receipts, statements and longer-form tips. Email
  here never carries anything time-critical (those go via WhatsApp/push in notification.service).
- **Frequency cap.** At most one marketing email per user per 7 days (enforced in code), and
  lifecycle tips stop entirely after an unsubscribe.

**Owner rule — no internal labels in content.** Template keys, series names, day numbers
("Mail 2 of 5", "Day 5"), campaign ids and badges never appear in a subject, preheader, body or
plain-text part. They live only in code and `notification.email_send_log`. Every visible line reads
as a normal message to the customer or provider. A test enforces this on swept mail.

## 2. Email kinds and consent rules

| Kind | Examples | Consent needed | Honors unsubscribe | Cap |
|---|---|---|---|---|
| transactional | receipts, approval, weekly earnings statement, OTP | No | No (legally required/expected service mail) | none |
| lifecycle | welcome series, abandoned request, review ask, onboarding nudges, inactive provider | No (legitimate interest; existing relationship) | **Yes** — `email_unsubscribed_at` stops them | one per template+period |
| marketing | no booking 30 d, win-back 60 d, seasonal, newsletter/campaigns | **Yes** — `email_marketing_consent = TRUE` | **Yes** | 1 / user / 7 days |

Legal basis (summary, not legal advice):

- **NDPA 2023 (Nigeria Data Protection Act)** and the NDPC GAID 2025: direct marketing needs a lawful
  basis; we use **opt-in consent**, default off, recorded with time and source
  (`email_marketing_consent_at`, `email_marketing_consent_source`), and withdrawable at any time as
  easily as it was given. We keep proof of consent.
- **GDPR / ePrivacy (for EU residents/diaspora users):** same opt-in model; pre-ticked boxes are not
  consent; unsubscribe must be free and simple.
- **CAN-SPAM (US recipients):** accurate From/subject, a physical postal address in every marketing
  mail (footer: `COMPANY_POSTAL_ADDRESS`), a working opt-out honoured within 10 business days (ours is
  immediate).
- **Gmail/Yahoo bulk-sender rules (2024):** `List-Unsubscribe` + `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` (RFC 8058) on marketing/lifecycle mail — implemented. SPF/DKIM/DMARC
  must be set on the sending domain (ops task).

Mechanics:

- Consent: `PUT /v1/me/email-preferences { marketing: true|false, source }` (signed-in user).
  Opting in clears a previous unsubscribe.
- One-click unsubscribe: `GET|POST /v1/email/unsubscribe?u=<userId>&t=<HMAC>` (public, HMAC-signed
  with `EMAIL_UNSUB_SECRET`, falling back to the JWT access secret). Sets consent false and
  `email_unsubscribed_at`. Transactional mail still flows.
- Footer on every lifecycle/marketing mail: company address, "Email preferences" link, unsubscribe link.

## 3. Customer program

| Template | Trigger (sweeper, hourly) | Timing | Subject | Goal / KPI |
|---|---|---|---|---|
| welcome (day 0) | sign-up (welcome.ts) | immediate | Welcome to Kendibo | activation; open rate |
| `customer_welcome_d2` | account age 2–7 d | day 2 | How booking on Kendibo works | first request rate within 7 d |
| `customer_welcome_d5` | account age 5–10 d | day 5 | Tips for a smooth first job | first booking rate; job success |
| `customer_abandoned_request` | request SUBMITTED/MATCHING/OFFERED, no booking, 6–72 h old | 6 h+ | Still need a hand? | request→booking conversion (recovered requests) |
| `customer_review_ask` | booking COMPLETED in last 14 d, no customer rating | next sweep | How did it go? | rating rate (target 40%+) |
| `customer_no_booking_30d` (marketing) | last booking/sign-up 30–59 d ago | day 30 | Anything need fixing at home? | repeat booking rate |
| `customer_winback_60d` (marketing) | last activity 60 d+ | day 60 | We miss you at Kendibo | reactivation rate |
| `customer_seasonal_ac` (marketing) | Oct–Nov, active consented customers | once a year | Get your AC ready for dry season | AC category bookings in Nov |

Seasonal ideas for later: fumigation/cleaning before Christmas and Easter, generator service before
rainy season, gutter/drainage checks in March–April.

## 4. Provider / vendor program

| Template | Trigger | Timing | Subject | Goal / KPI |
|---|---|---|---|---|
| `provider_onboarding_24h` | provider not VERIFIED, 24–72 h old | 24 h | Finish your Kendibo profile | onboarding completion |
| `provider_onboarding_72h` | not VERIFIED, 3–7 d old | 72 h | Customers near you are booking | onboarding completion |
| `provider_approved` (transactional) | VERIFIED, joined < 30 d | on approval | You are approved on Kendibo | first time online within 48 h |
| `provider_first_job_tips` | first accepted assignment | first job | Tips for your first Kendibo job | first-job rating ≥ 4.5 |
| `provider_weekly_earnings` (transactional) | Mondays, earnings in last 7 d | weekly | Your Kendibo week | retention of active providers |
| `provider_inactive` | VERIFIED, offline, not seen 14 d | monthly | Jobs are waiting near you | weekly active providers |

## 5. Marketing / newsletter

`sendMarketing(userId, campaignId, title, paragraphs, cta)` in `lifecycle.service.ts` — always `marketing`
kind: consent, unsubscribe and the weekly cap are enforced, one send per user per campaign.

## 6. Idempotency and scheduling

- `notification.email_send_log` is UNIQUE (user_id, template, period). The sweeper claims the row
  *before* sending and releases it if the send fails, so restarts/overlaps never double-send and
  failures retry next hour. Period is `once`, a request/booking id, an ISO week, a month, or
  `since:<last-activity-date>` (re-arms after the user books again).
- `startLifecycleSweeper()` runs hourly from main.ts (not under `NODE_ENV=test`).

## 7. Admin alerts

Recipients: platform setting `admin.alert_emails` (DB; seeded `admin@kendibo.ng`,
`alerts@kendibo.ng`). Change with `GET|PUT /v1/admin/settings/alert-emails` (permission
`configuration:edit`, audited). Never env.

Alerts (fire-and-forget off the `emit()` bus; failures captured in observability and logged in
`notification.admin_alert_log.error`; never block the user):

- New customer sign-up (phone OTP, email OTP, Google, Facebook, WhatsApp) and new provider sign-up
- Provider/vendor steps: profile started, KYC submitted / passed / failed, business KYB submitted,
  bank account added, first price listed, first time online, approved
- Unserved demand: request with no verified/online provider in range, no location, or a service we
  do not offer — category, area/city, customer name + masked phone, what they asked, channel, time.
  One alert per request (`request:<id>:unserved`).

Not done yet: daily digest of all alerts (nice-to-have), KPI dashboard of send/open/click rates.
