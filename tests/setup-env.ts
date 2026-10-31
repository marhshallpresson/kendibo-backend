// Preloaded before EVERY test file (see the "test" script in package.json).
// Tests must never touch a real database, send real messages, or call paid
// APIs — whatever the developer's .env contains. dotenv never overrides a
// variable that is already defined, so setting these first wins.
const HERMETIC: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: '',          // in-memory pg-mem only
  REDIS_URL: '',
  VENDOR_ELIGIBILITY_ENFORCED: 'false',
  // Third-party credentials: blank so no real SMS, email, WhatsApp, push,
  // payment, KYC, AI or telemetry call can leave the machine.
  BACHS_API_KEY: '', BACHS_WEBHOOK_SECRET: '', BACHS_ACCOUNT_ID: '',
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
  SLING_API_TOKEN: '', SLING_WEBHOOK_SECRET: '',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_BUSINESS_ACCOUNT_ID: '', WHATSAPP_APP_SECRET: '',
  FACEBOOK_APP_ID: '', FACEBOOK_APP_SECRET: '', META_APP_ID: '',
  PREMBLY_API_KEY: '', PREMBLY_SECRET_KEY: '', PREMBLY_PUBLIC_KEY: '', PREMBLY_APP_ID: '', DOJAH_SECRET_KEY: '',
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', GEMINI_API_KEY: '',
  FIREBASE_SERVICE_ACCOUNT_JSON: '', GOOGLE_APPLICATION_CREDENTIALS: '', FCM_SERVER_KEY: '',
  WATCHUP_API_KEY: '', SENTRY_DSN: '', POSTHOG_KEY: '',
  FTP_HOST: '', FTP_PASS: '', STORAGE_ACCESS_KEY: '', STORAGE_SECRET_KEY: '', STORAGE_DRIVER: 'local',
  KYC_PROVIDER: 'stub',
};
for (const [k, v] of Object.entries(HERMETIC)) process.env[k] = v;
