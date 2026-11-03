// Integration manifest — every third-party credential Kendibo uses, in one
// place: what it is, whether it is SECRET (server only, never in a client
// bundle) or PUBLIC (safe in the app), which flows break without it, and
// whether production refuses to run without it.
//
// GET /v1/admin/integrations reports configured / missing per key. It NEVER
// returns values — only presence and, for secrets, a short fingerprint so ops
// can confirm which key is deployed without exposing it.
import crypto from 'node:crypto';

export type Exposure = 'secret' | 'public' | 'config';
export interface IntegrationKey { env: string; exposure: Exposure; requiredInProd: boolean; note: string }
export interface Integration { id: string; name: string; purpose: string; docs: string; keys: IntegrationKey[] }

export const INTEGRATIONS: Integration[] = [
  {
    id: 'core', name: 'Core runtime', purpose: 'Sessions, signed media URLs, OTP hashing', docs: '',
    keys: [
      { env: 'JWT_ACCESS_SECRET', exposure: 'secret', requiredInProd: true, note: '≥32 random bytes; rotating logs every user out' },
      { env: 'JWT_REFRESH_SECRET', exposure: 'secret', requiredInProd: true, note: 'Different from the access secret' },
      { env: 'MEDIA_SIGN_SECRET', exposure: 'secret', requiredInProd: true, note: 'HMAC for signed media URLs' },
      { env: 'KYC_CACHE_SECRET', exposure: 'secret', requiredInProd: false, note: 'HMAC for the KYC result cache key; falls back to JWT_ACCESS_SECRET' },
      { env: 'DATABASE_URL', exposure: 'secret', requiredInProd: true, note: 'Managed Postgres connection string' },
      { env: 'REDIS_URL', exposure: 'secret', requiredInProd: false, note: 'Queues and rate-limit store' },
      { env: 'CORS_ORIGINS', exposure: 'config', requiredInProd: true, note: 'Comma-separated web origins' },
      { env: 'STOREFRONT_BASE_URL', exposure: 'config', requiredInProd: false, note: 'Public base for /s/<slug> share links' },
    ],
  },
  {
    id: 'bachs', name: 'Bachs.io (payments)', purpose: 'Checkout, transfers to virtual accounts, verify, refunds, payouts, bank list', docs: 'https://docs.bachs.io',
    keys: [
      { env: 'BACHS_API_KEY', exposure: 'secret', requiredInProd: true, note: 'sk_live_… in prod, sk_sandbox_… elsewhere' },
      { env: 'BACHS_WEBHOOK_SECRET', exposure: 'secret', requiredInProd: true, note: 'whsec_…; signs X-Bachs-Signature' },
      { env: 'BACHS_ACCOUNT_ID', exposure: 'config', requiredInProd: true, note: 'acct_…' },
      { env: 'BACHS_BASE_URL', exposure: 'config', requiredInProd: true, note: 'Live vs sandbox host — must match the key' },
    ],
  },
  {
    id: 'prembly', name: 'Prembly IdentityPass (KYC/KYB)', purpose: 'NIN, BVN, face match, CAC, bank account', docs: 'https://docs.prembly.com',
    keys: [
      { env: 'PREMBLY_SECRET_KEY', exposure: 'secret', requiredInProd: true, note: 'Secret (private) key, sent as x-api-key. Legacy name PREMBLY_API_KEY still read' },
      { env: 'PREMBLY_APP_ID', exposure: 'secret', requiredInProd: true, note: 'Sent as app-id' },
      { env: 'PREMBLY_PUBLIC_KEY', exposure: 'public', requiredInProd: false, note: 'Client widget/SDK only; never used for server calls' },
      { env: 'PREMBLY_ENVIRONMENT', exposure: 'config', requiredInProd: true, note: 'sandbox | live. Must match the keys (toggle in Prembly: Integrations → API Library)' },
      { env: 'KYC_COST_NIN_KOBO', exposure: 'config', requiredInProd: false, note: 'Your contract price per NIN lookup, in kobo' },
      { env: 'KYC_COST_BVN_KOBO', exposure: 'config', requiredInProd: false, note: 'Per BVN lookup' },
      { env: 'KYC_COST_NIN_FACE_KOBO', exposure: 'config', requiredInProd: false, note: 'Per NIN + face match' },
      { env: 'KYC_COST_CAC_KOBO', exposure: 'config', requiredInProd: false, note: 'Per CAC lookup' },
      { env: 'KYC_DAILY_BUDGET_KOBO', exposure: 'config', requiredInProd: false, note: 'Hard daily spend cap (0 = no cap)' },
      { env: 'KYC_MONTHLY_BUDGET_KOBO', exposure: 'config', requiredInProd: false, note: 'Hard monthly spend cap (0 = no cap)' },
    ],
  },
  {
    id: 'whatsapp', name: 'WhatsApp Cloud API (Meta)', purpose: 'Booking assistant, vendor offer buttons', docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    keys: [
      { env: 'WHATSAPP_ACCESS_TOKEN', exposure: 'secret', requiredInProd: false, note: 'Permanent System User token (never expires) with whatsapp_business_messaging + whatsapp_business_management; the 24h API Setup token stops working' },
      { env: 'WHATSAPP_PHONE_NUMBER_ID', exposure: 'config', requiredInProd: false, note: 'From WhatsApp Manager → API setup' },
      { env: 'WHATSAPP_BUSINESS_ACCOUNT_ID', exposure: 'config', requiredInProd: false, note: 'WhatsApp Business Account ID; the Template API lives under it' },
      { env: 'WHATSAPP_APP_SECRET', exposure: 'secret', requiredInProd: false, note: 'Meta App Secret; verifies X-Hub-Signature-256' },
      { env: 'WHATSAPP_VERIFY_TOKEN', exposure: 'secret', requiredInProd: false, note: 'You choose it; paste the same value in the webhook form' },
      { env: 'WHATSAPP_GRAPH_VERSION', exposure: 'config', requiredInProd: false, note: 'e.g. v21.0' },
      { env: 'WHATSAPP_BUSINESS_NUMBER', exposure: 'config', requiredInProd: false, note: 'International format, for "Back to WhatsApp" links' },
      { env: 'WHATSAPP_LINK_SECRET', exposure: 'secret', requiredInProd: false, note: 'Signs map / vendor-list links; falls back to JWT_ACCESS_SECRET' },
      { env: 'WHATSAPP_WEB_BASE_URL', exposure: 'config', requiredInProd: false, note: 'Public base the /w/* pages are served from' },
      { env: 'WHATSAPP_TEMPLATE_JOB_OFFER', exposure: 'config', requiredInProd: false, note: 'Utility template for job offers outside the 24h window (1 body variable + Accept/Decline quick replies); else SMS' },
      { env: 'WHATSAPP_TEMPLATE_VENDOR_ACCEPTED', exposure: 'config', requiredInProd: false, note: 'Utility template "vendor accepted + pay" (vendor, amount, link); else SMS' },
    ],
  },
  {
    id: 'facebook_login', name: 'Facebook Login (same Meta app)', purpose: 'Sign in with Facebook in the app', docs: 'https://developers.facebook.com/docs/facebook-login',
    keys: [
      { env: 'FACEBOOK_APP_ID', exposure: 'public', requiredInProd: false, note: 'Meta App ID (also EXPO_PUBLIC_FACEBOOK_APP_ID in the app build)' },
      { env: 'FACEBOOK_APP_SECRET', exposure: 'secret', requiredInProd: false, note: 'Optional: defaults to WHATSAPP_APP_SECRET (same Meta app)' },
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic Claude (WhatsApp AI agent)', purpose: 'Conversational booking + support; falls back to the menu bot without it', docs: 'https://docs.claude.com',
    keys: [
      { env: 'ANTHROPIC_API_KEY', exposure: 'secret', requiredInProd: false, note: 'Server only; set a monthly spend limit in the Anthropic console' },
      { env: 'WHATSAPP_AI_MODEL', exposure: 'config', requiredInProd: false, note: 'claude-opus-5-5 (default) or claude-haiku-5-5 for speed/cost' },
      { env: 'WHATSAPP_AI_DAILY_TURNS', exposure: 'config', requiredInProd: false, note: 'AI fallback turns per customer per day (default 25)' },
    ],
  },
  {
    id: 'google_maps', name: 'Google Maps Platform', purpose: 'Location picker: map, Places (New) search + nearby landmarks, geocoding', docs: 'https://developers.google.com/maps',
    keys: [
      { env: 'GOOGLE_MAPS_API_KEY', exposure: 'secret', requiredInProd: false, note: 'Server geocoding (primary provider); Mapbox is the fallback, OSM the last resort' },
      { env: 'GOOGLE_MAPS_BROWSER_KEY', exposure: 'public', requiredInProd: false, note: 'Restrict to HTTP referrer <WHATSAPP_WEB_BASE_URL>/* and to Maps JS + Places (New) + Geocoding APIs' },
    ],
  },
  {
    id: 'sling', name: 'Sling (SMS / WhatsApp templates / RCS / email)', purpose: 'OTP and notifications', docs: 'https://docs.hellosling.com',
    keys: [
      { env: 'SLING_API_TOKEN', exposure: 'secret', requiredInProd: true, note: 'Bearer token. Sling is the only SMS provider; OTP SMS refuses in prod without it' },
      { env: 'SLING_WEBHOOK_SECRET', exposure: 'secret', requiredInProd: true, note: 'Delivery receipts are rejected without it in prod' },
    ],
  },
  {
    id: 'fallback_comms', name: 'SMTP / FCM', purpose: 'Email (SMTP first, Sling email next) and push', docs: '',
    keys: [
      { env: 'SMTP_PASS', exposure: 'secret', requiredInProd: false, note: 'SMTP relay password (with SMTP_HOST / SMTP_USER); without SMTP, email goes through Sling' },
      { env: 'FIREBASE_SERVICE_ACCOUNT_JSON', exposure: 'secret', requiredInProd: false, note: 'FCM HTTP v1 (the legacy server key API is retired)' },
    ],
  },
  {
    id: 'gemini', name: 'Google Gemini', purpose: 'AI CTA copy, trade-proposal drafting', docs: 'https://ai.google.dev',
    keys: [
      { env: 'GEMINI_API_KEY', exposure: 'secret', requiredInProd: false, note: 'Sent as x-goog-api-key; features fall back to deterministic logic' },
      { env: 'GEMINI_MODEL', exposure: 'config', requiredInProd: false, note: 'Model id' },
    ],
  },
  {
    id: 'storage', name: 'Object storage (Pxxl S3) / FTP', purpose: 'Media uploads', docs: '',
    keys: [
      { env: 'STORAGE_ACCESS_KEY', exposure: 'secret', requiredInProd: false, note: 'S3 access key (STORAGE_DRIVER=s3)' },
      { env: 'STORAGE_SECRET_KEY', exposure: 'secret', requiredInProd: false, note: 'S3 secret' },
      { env: 'FTP_PASS', exposure: 'secret', requiredInProd: false, note: 'Only for STORAGE_DRIVER=ftp; prefer FTPS' },
    ],
  },
  {
    id: 'observability', name: 'WatchUp / Sentry / PostHog', purpose: 'Errors, traces, product analytics', docs: '',
    keys: [
      { env: 'WATCHUP_API_KEY', exposure: 'secret', requiredInProd: false, note: 'Server ingest key' },
      { env: 'SENTRY_DSN', exposure: 'public', requiredInProd: false, note: 'DSNs are designed to be public' },
      { env: 'POSTHOG_KEY', exposure: 'public', requiredInProd: false, note: 'Project key; public by design' },
    ],
  },
];

// Keys the MOBILE app may embed (EXPO_PUBLIC_*). Anything secret above must
// never appear here — EXPO_PUBLIC_* values ship inside the app bundle.
export const CLIENT_PUBLIC_KEYS = ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_MAPBOX_TOKEN (pk.* public token, URL-restricted)', 'EXPO_PUBLIC_GOOGLE_*_CLIENT_ID'];

const fingerprint = (v: string) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 8);

export function integrationStatus() {
  const prod = process.env.NODE_ENV === 'production';
  return INTEGRATIONS.map((i) => {
    const keys = i.keys.map((k) => {
      const v = (process.env[k.env] ?? '').trim();
      return {
        env: k.env, exposure: k.exposure, configured: v.length > 0, requiredInProd: k.requiredInProd, note: k.note,
        // Detect a sandbox/test key deployed to production (common outage cause).
        looksLikeTestKey: prod && k.exposure === 'secret' && /(sandbox|_test|test_|TEST-)/i.test(v),
        fingerprint: v && k.exposure === 'secret' ? fingerprint(v) : undefined,
        value: v && k.exposure !== 'secret' ? v : undefined,
      };
    });
    const missingRequired = keys.filter((k) => k.requiredInProd && !k.configured).map((k) => k.env);
    return { id: i.id, name: i.name, purpose: i.purpose, docs: i.docs, ready: missingRequired.length === 0, missingRequired, keys };
  });
}
