# Kendibo roadmap to public launch

Status 1 Nov 2026. Kendibo is **members-only**: services, vendors, prices and booking are only
available after a person registers and signs in (app or WhatsApp). Shared storefront links show a
teaser that asks people to join. The catalogue (trades and services) stays public so sign-up works.

## 1. Blockers (owner: you, before any public traffic)

| # | Item | Why it blocks |
|---|---|---|
| 1 | Redeploy the API on Pxxl (`api-kendibo.pxxlspace.cv` returns 404) and set the server variables there | Nothing works for real users; Meta can't verify the webhook |
| 2 | Permanent WhatsApp System User token, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `FACEBOOK_APP_ID` | The current WhatsApp token expired on 31 Oct; templates and Facebook Login need the IDs |
| 3 | Live Prembly secret key, then `KYC_PROVIDER=prembly` | Identity checks are simulated today, so nobody is really verified |
| 4 | `BACHS_ACCOUNT_ID`, `BACHS_WEBHOOK_SECRET`, `SLING_WEBHOOK_SECRET` | Payments can't be confirmed; delivery receipts are refused |
| 5 | Media storage on FTPS or S3 (`FTP_SECURE=false` sends the password in clear) | Security |
| 6 | Run migrations 027–030 on production after review | New tables for the WhatsApp assistant, templates, Facebook Login |
| 7 | Submit the three WhatsApp templates (admin → WhatsApp assistant) and get them approved | Job offers and payment links outside the 24-hour window go by SMS until then |

## 2. Verification, as a first-time vendor sees it

A walk-through of the current vendor flow as an artisan in Uyo with a basic Android phone and no
company registration. It was not run against live Prembly because a real NIN/BVN lookup sends
sensitive identity data and may incur a charge.

| Step | What the person thinks | Risk | Change |
|---|---|---|---|
| Sign up with phone OTP | Clear | SMS delays on some networks | Show "Didn't get it? Resend in 30s", and also offer WhatsApp OTP once the authentication template exists |
| Pick trade | Clear if the trade exists | "Interior designer"-type trades are missing | Keep "Suggest a trade" visible, and say it is reviewed within 24 hours |
| NIN or BVN | "Which one? Is it safe to give my BVN?" | Drop-off and fear of fraud | Say in one line why it is needed, that Kendibo never sees the bank balance, and that NIN is enough to start. Show the Prembly / NDPA notice |
| Selfie match | "Why another photo?" | Bad light means failed checks, and each check costs money | Show a framing guide and a "good light, no cap or glasses" tip. Allow one free retry, then a human review instead of another paid check |
| CAC certificate | Many artisans are not registered | Blocks most of the supply | Make CAC optional for individuals (badge only); require it only for company accounts and trades that need it (category rules already allow this) |
| Licence (electrical, generator) | "Which licence?" | Confusion | Give the exact document names with a photo example; accept "pending" plus a time limit |
| Bank account | "Why must the name match?" | Rejection when the name order differs (Okon Ada vs Ada Okon) | Explain before entry; accept the same names in a different order or with a middle name; route close matches to manual review |
| Waiting | "Am I approved?" | Silence means they leave | Status screen with each check ticked, an expected time, and a WhatsApp message on approval |

**Communication principles:** one action per screen, plain words (no "KYC", "KYB" or "tier"),
Pidgin options on the key screens, say why before asking for anything sensitive, show progress
("Step 3 of 5"), and always offer "Talk to a person".

## 3. Business model (implemented; tune the numbers in the admin console)

- **Members only:** browse and book after sign-up (app or WhatsApp).
- **Commission per trade** (Trade rules page): cleaning and fumigation 15%, repairs 12%, big jobs 8% with a cap.
- **Onboarding / verification fee** per trade, deducted from the vendor's first earnings (KYC spend is tracked per vendor).
- **Escrow:** customers pay through Bachs. Kendibo holds the money until the customer confirms the job is done, then pays the vendor their net earnings. Payouts are capped at the available balance.
- **Call-out fee** credited to the job; cancellation rules by stage.
- **Retainers:** recurring cleaning and maintenance plans (AI-assisted reminders through Sling).
- **Marketing** only with consent (STOP/START), never to numbers without an account.

## 4. Accessibility (target WCAG 2.2 AA)

Done in the admin console:
- design tokens in one file;
- visible keyboard focus;
- skip link;
- grouped navigation with `aria-current`;
- table captions and column headers;
- error messages announced (`role="alert"`);
- 40px minimum buttons;
- reduced-motion support;
- the console works at phone width.

Next:
- App screens: check contrast against the final brand tokens, add `accessibilityLabel` on icon-only buttons (the Google and Facebook buttons have them), support dynamic text size, and make 44px touch targets.
- WhatsApp: no information carried only by emoji or colour; every button also works as typed text (done).
- Run an automated audit (axe) on the admin console and the web build of the app once the final tokens land.

## 5. Integrations platform: next

| When | Item |
|---|---|
| Launch | WhatsApp templates approved; Facebook Login live after App Review; Prembly live; Bachs live with webhooks |
| +2 weeks | WhatsApp authentication template for OTP (cheaper than SMS); WhatsApp Flows for the intake form |
| +1 month | Retrain the intent model on about 300 labelled customer lines; retrain the matching model after about 200 completed jobs |
| +2 months | Queue (Redis/BullMQ) to replace the in-process WhatsApp serialisation before running more than one API instance |

## 6. Competitor notes

helper.ng could not be reached from our machine (the domain did not resolve on 1 Nov 2026), so its sign-up flow still needs a manual walk-through. Comparable Nigerian platforms:
- [Wrkman](https://apps.apple.com/dk/app/wrkman/id1564644002) uses a separate pro app and "rigorous" artisan selection before onboarding.
- [Rísé.ng](https://nannews.ng/surulere-lg-rise-ng-partner-to-empower-1000-artisans-vendors/) charges artisans about ₦3,000 for KYC verification.
- [Clickafix](https://businessday.ng/brands-advertising/article/clickafix-app-for-artisans-home-service-debuts/) and [Viable247](https://businessday.ng/news/article/viable247-targets-informal-service-sector-with-new-marketplace/) target the informal sector.

Kendibo's difference: members-only trust (verified both sides), escrow until the job is done, and WhatsApp booking without installing an app.
