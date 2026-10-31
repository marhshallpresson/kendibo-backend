// Preloaded by `npm run dev:local` (tsx --import) BEFORE dotenv runs. .env holds
// production values, and dotenv never overrides a variable that is already set,
// so everything below wins: the local API gets an in-memory database, its own
// signing secrets (a token minted here must never work against production), and
// no outbound SMS / email / WhatsApp / push / live Bachs checkouts. Read-only
// provider checks live in `npm run integrations:check`.
import crypto from 'node:crypto';

const secret = () => crypto.randomBytes(32).toString('hex');

Object.assign(process.env, {
  NODE_ENV: 'development',
  PXXL_ENV: 'local',
  PORT: process.env.LOCAL_API_PORT || '4000',
  DATABASE_URL: '',
  REDIS_URL: '',
  STORAGE_DRIVER: 'local',
  JWT_ACCESS_SECRET: secret(),
  JWT_REFRESH_SECRET: secret(),
  MEDIA_SIGN_SECRET: secret(),
  KYC_CACHE_SECRET: secret(),
  WHATSAPP_LINK_SECRET: secret(),
  ALLOW_OTP_DEBUG: 'true',
  CORS_ORIGINS: 'http://localhost:3002,http://localhost:5173,http://localhost:8081',
  APP_URL: 'http://localhost:8081',
  WHATSAPP_WEB_BASE_URL: `http://localhost:${process.env.LOCAL_API_PORT || '4000'}`,
  STOREFRONT_BASE_URL: `http://localhost:${process.env.LOCAL_API_PORT || '4000'}`,
  WATCHUP_ENV: 'local',
  // Outbound channels and money paths off (they simulate / log in development).
  SLING_API_TOKEN: '',
  SLING_WEBHOOK_SECRET: '',
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_APP_SECRET: '',
  FIREBASE_SERVICE_ACCOUNT_JSON: '', FCM_SERVER_KEY: '',
  BACHS_API_KEY: '', BACHS_WEBHOOK_SECRET: '',
  WATCHUP_API_KEY: '',
  FTP_PASS: '', STORAGE_ACCESS_KEY: '', STORAGE_SECRET_KEY: '',
});

console.log(`[local] in-memory database, local storage, outbound messaging and live payments off, API on :${process.env.PORT}`);
