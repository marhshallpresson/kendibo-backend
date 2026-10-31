# Kendibo integrations and keys

The machine-readable version of this guide is `packages/config/integrations.ts`.
`GET /v1/admin/integrations` (needs `configuration:edit`) shows which keys are configured. It never
returns secret values: it shows a short fingerprint, and flags any test or sandbox key deployed to
production.

## Rules

1. **SECRET keys stay on the server.** Keep them in the host's environment (Pxxl/Render dashboard),
   never in git, and never in an `EXPO_PUBLIC_*` or `NEXT_PUBLIC_*` variable. Those prefixes are
   compiled into app bundles that anyone can unpack.
2. **PUBLIC keys are safe in clients only because they're designed for it.** Examples are the Mapbox
   `pk.*` token, the Google Maps browser key, Sentry DSNs and the PostHog project key. Restrict them
   where the provider allows it: Mapbox URL restrictions, and bundle IDs or package names for Google
   OAuth.
3. **Each environment has its own key set.** Production uses live keys only, staging and dev use
   sandbox keys. A test key in production is reported by the status endpoint.
4. **Every webhook is signed and checked against the raw body:**
   - Bachs: `X-Bachs-Signature`, with a 300 s window.
   - Sling: `x-sling-signature` (HMAC) or the shared secret. Rejected in production if the secret is
     unset.
   - WhatsApp: `X-Hub-Signature-256`, keyed with the App Secret.
5. **Rotation:** rotate any key that was ever pasted into chat, a ticket or a log. Rotating
   `JWT_*_SECRET` signs everyone out. Rotating `MEDIA_SIGN_SECRET` invalidates media URLs that are
   already shared.

## Where each key goes

| Integration | Server (SECRET) | Server (CONFIG) | Client (PUBLIC) | Webhook URL to register |
|---|---|---|---|---|
| Core | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MEDIA_SIGN_SECRET`, `KYC_CACHE_SECRET`, `DATABASE_URL`, `REDIS_URL` | `CORS_ORIGINS`, `STOREFRONT_BASE_URL` | `EXPO_PUBLIC_API_URL`, `NEXT_PUBLIC_API_URL` | — |
| Bachs.io | `BACHS_API_KEY`, `BACHS_WEBHOOK_SECRET` | `BACHS_ACCOUNT_ID`, `BACHS_BASE_URL` | — | `<API>/webhooks/payments/bachs` |
| Prembly | `PREMBLY_API_KEY`, `PREMBLY_APP_ID` | `KYC_COST_*_KOBO`, `KYC_*_BUDGET_KOBO`, `KYC_MAX_ATTEMPTS_PER_DAY`, `KYC_CACHE_DAYS`, `KYC_FEE_PASSTHROUGH` | — | — |
| WhatsApp Cloud API | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_VERSION` | — | `<API>/webhooks/whatsapp` (subscribe to `messages`) |
| Sling | `SLING_API_TOKEN`, `SLING_WEBHOOK_SECRET` | `SLING_*_SENDER` | — | `<API>/webhooks/sling` |
| Termii / Resend | `TERMII_API_KEY`, `RESEND_API_KEY` | `EMAIL_FROM` | — | — |
| FCM push | `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` | — | `google-services.json` (EAS secret file) | — |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` | — | — |
| Storage | `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `FTP_PASS` | `STORAGE_DRIVER`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET` | — | — |
| Maps | — | — | `EXPO_PUBLIC_MAPBOX_TOKEN` (`pk.*`, URL-restricted). Never an `sk.*` token. | — |
| Google sign-in | — | — | `EXPO_PUBLIC_GOOGLE_{WEB,IOS,ANDROID}_CLIENT_ID` | — |
| Observability | `WATCHUP_API_KEY` | `WATCHUP_ENV`, `WATCHUP_RELEASE` | `SENTRY_DSN`, `POSTHOG_KEY`, `EXPO_PUBLIC_WATCHUP_KEY` (an ingest-only key, see below) | — |
| Landing page mailer | `ADMIN_TOKEN`, `UNSUBSCRIBE_SECRET`, `SMTP_PASS`, `DATABASE_URL` | `APP_URL`, `SMTP_*` | — | — |

## WhatsApp setup checklist

1. In Meta Business Manager, create the app (type **Business**) and add the WhatsApp product.
2. Add and verify the business phone number. Copy its **Phone number ID** into
   `WHATSAPP_PHONE_NUMBER_ID`.
3. Create a **System User** and give it the WhatsApp Business Account asset with
   `whatsapp_business_messaging` only. Generate a permanent token and put it in
   `WHATSAPP_ACCESS_TOKEN`.
4. Copy the App Secret from App settings → Basic into `WHATSAPP_APP_SECRET`.
5. Generate a long random string for `WHATSAPP_VERIFY_TOKEN`.
6. In Webhooks, set the callback to `<API>/webhooks/whatsapp`, paste the verify token, and subscribe
   to `messages`.
7. Get a utility template approved for vendor job offers (body plus two quick-reply buttons), for
   when the 24-hour customer-service window is closed.

## Before production

- [ ] `GET /v1/admin/integrations` shows every `requiredInProd` key as configured, with no test keys.
- [ ] Set `KYC_COST_*_KOBO` from the Prembly contract, and set `KYC_DAILY_BUDGET_KOBO`.
- [ ] Set webhook secrets in each dashboard to the same values as on the server.
- [ ] Check that `EXPO_PUBLIC_WATCHUP_KEY` is an ingest-only or public key. It ships inside the app.
