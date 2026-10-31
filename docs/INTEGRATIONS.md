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
| Prembly | `PREMBLY_SECRET_KEY` (sent as `x-api-key`), `PREMBLY_APP_ID` (sent as `app-id`) | `PREMBLY_ENVIRONMENT` (`sandbox`/`live`), `KYC_COST_*_KOBO`, `KYC_*_BUDGET_KOBO`, `KYC_MAX_ATTEMPTS_PER_DAY`, `KYC_CACHE_DAYS`, `KYC_FEE_PASSTHROUGH` | `PREMBLY_PUBLIC_KEY` (widget/SDK only; unused today) | — |
| WhatsApp Cloud API | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_GRAPH_VERSION` | — | `<API>/webhooks/whatsapp` (subscribe to `messages`, `message_template_status_update`, `message_template_quality_update`, `template_category_update`) |
| Facebook Login (same Meta app) | `FACEBOOK_APP_SECRET` (optional, defaults to `WHATSAPP_APP_SECRET`) | `FACEBOOK_APP_ID` | `EXPO_PUBLIC_FACEBOOK_APP_ID` | Data deletion `<API>/v1/auth/facebook/data-deletion`, deauthorize `<API>/v1/auth/facebook/deauthorize` |
| Sling (only SMS provider) | `SLING_API_TOKEN`, `SLING_WEBHOOK_SECRET` | `SLING_*_SENDER` | — | `<API>/webhooks/sling` |
| Email (SMTP first, then Sling email) | `SMTP_PASS` | `SMTP_HOST`, `SMTP_USER`, `SMTP_PORT`, `EMAIL_FROM` | — | — |
| FCM push | `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` | — | `google-services.json` (EAS secret file) | — |
| Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` | — | — |
| Storage | `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `FTP_PASS` | `STORAGE_DRIVER`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET` | — | — |
| Maps | — | — | `EXPO_PUBLIC_MAPBOX_TOKEN` (`pk.*`, URL-restricted). Never an `sk.*` token. | — |
| Google sign-in | — | — | `EXPO_PUBLIC_GOOGLE_{WEB,IOS,ANDROID}_CLIENT_ID` | — |
| Observability | `WATCHUP_API_KEY` | `WATCHUP_ENV`, `WATCHUP_RELEASE` | `SENTRY_DSN`, `POSTHOG_KEY`, `EXPO_PUBLIC_WATCHUP_KEY` (an ingest-only key, see below) | — |
| Landing page mailer | `ADMIN_TOKEN`, `UNSUBSCRIBE_SECRET`, `SMTP_PASS`, `DATABASE_URL` | `APP_URL`, `SMTP_*` | — | — |

## Meta setup (WhatsApp + Facebook Login, one app)

`<API>` is the production API origin, `https://api-kendibo.pxxlspace.cv`. Meta checks the
webhook live, so the API must be deployed (with these variables set on Pxxl) before step 5.

1. **App**: one Meta app (type Business) with the WhatsApp and Facebook Login products. The
   permissions it needs: `whatsapp_business_messaging`, `whatsapp_business_management`,
   `business_management`, `public_profile`, `email`.
2. **Phone number**: add and verify it; copy its Phone number ID into `WHATSAPP_PHONE_NUMBER_ID` and
   the WhatsApp Business Account ID (WhatsApp Manager → API Setup) into
   `WHATSAPP_BUSINESS_ACCOUNT_ID`.
3. **Permanent token**: Business Settings → Users → System users → add one (Admin), assign the
   app and the WhatsApp Business Account, then Generate token with
   `whatsapp_business_messaging` and `whatsapp_business_management`, expiry **Never**. Put it in
   `WHATSAPP_ACCESS_TOKEN`. (The token on the API Setup page expires after 24 hours.)
4. **Secrets**: App settings → Basic → App Secret into `WHATSAPP_APP_SECRET`; the App ID into
   `FACEBOOK_APP_ID` (and `EXPO_PUBLIC_FACEBOOK_APP_ID` for the app build). Pick a long random
   `WHATSAPP_VERIFY_TOKEN`. Set `WHATSAPP_GRAPH_VERSION=v26.0` (v21.0 stops working on 21 Jan 2027).
5. **Webhook**: WhatsApp → Configuration → Callback URL `<API>/webhooks/whatsapp`, Verify token =
   `WHATSAPP_VERIFY_TOKEN`. Subscribe to `messages`, `message_template_status_update`,
   `message_template_quality_update` and `template_category_update`.
6. **Templates**: `npm run whatsapp:templates -- --submit` (or "Submit for review" on the admin
   console's WhatsApp assistant page) submits `kendibo_job_offer`, `kendibo_vendor_accepted` and
   `kendibo_request_update`. Each is used once Meta approves it; until then those messages go by SMS.
7. **Facebook Login → Settings**: Valid OAuth Redirect URIs: the web app origin
   (`https://kendibo-app.pxxl.click`, also with a trailing `/`). Data deletion request URL:
   `<API>/v1/auth/facebook/data-deletion`. Deauthorize callback URL:
   `<API>/v1/auth/facebook/deauthorize`. For the Android build add package `com.kendibo.app` with
   the signing key hash under the app's Android platform settings; native builds get the
   `fb<APP_ID>` scheme from `app.config.js`.
8. Switch the app to **Live** after App Review for `email` and `public_profile` (and business
   verification for WhatsApp).

## Before production

- [ ] `GET /v1/admin/integrations` shows every `requiredInProd` key as configured, with no test keys.
- [ ] Set `KYC_COST_*_KOBO` from the Prembly contract, and set `KYC_DAILY_BUDGET_KOBO`.
- [ ] Set webhook secrets in each dashboard to the same values as on the server.
- [ ] Check that `EXPO_PUBLIC_WATCHUP_KEY` is an ingest-only or public key. It ships inside the app.
