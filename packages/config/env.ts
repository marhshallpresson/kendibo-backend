// Config — validated once at boot (zod). Local-first defaults; production
// (NODE_ENV=production, e.g. api-kendibo.pxxlspace.cv) REFUSES to boot on
// placeholder secrets so a misconfigured deploy fails loud, not open.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default(''),
  // Empty = local modes (pg-mem / memory queues / local storage). Set on Pxxl
  // via Dashboard > Environment Variables (never in git).
  DATABASE_URL: z.string().default(''),
  GEOLOCK_CITY: z.string().default(''),
  REDIS_URL: z.string().default(''),
  JWT_ACCESS_SECRET: z.string().default(''),
  JWT_REFRESH_SECRET: z.string().default(''),
  MEDIA_SIGN_SECRET: z.string().default(''),
  STORAGE_DRIVER: z.string().default('local'),
  BACHS_API_KEY: z.string().default(''),
  BACHS_BASE_URL: z.string().default('https://sandbox-api.bachs.io'),
  BACHS_WEBHOOK_SECRET: z.string().default(''),
  BACHS_ACCOUNT_ID: z.string().default(''),
  FLW_SECRET_KEY: z.string().default(''),
  FLW_PUBLIC_KEY: z.string().default(''),
  FLW_SECRET_HASH: z.string().default(''),
  TERMII_API_KEY: z.string().default(''),
  TERMII_SENDER: z.string().default('KENDIBO'),
  SMTP_HOST: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  WATCHUP_API_KEY: z.string().default(''),
  WATCHUP_ENV: z.string().default('development'),
  WATCHUP_RELEASE: z.string().default('dev'),
  KYC_PROVIDER: z.string().default('stub'),
  DOJAH_API_KEY: z.string().default(''),
  // Prembly (IdentityPass) — https://docs.prembly.com. Sandbox keys use the
  // same base URL. PREMBLY_APP_ID is required for document/face endpoints.
  PREMBLY_API_KEY: z.string().default(''),
  PREMBLY_APP_ID: z.string().default(''),
  PREMBLY_BASE_URL: z.string().default('https://api.prembly.com'),
  PREMBLY_COUNTRY: z.string().default('NG'),
  ALLOW_OTP_DEBUG: z.string().default('false'),
});
export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = schema.parse(process.env);

if (config.NODE_ENV === 'production') {
  const required: (keyof AppConfig)[] = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MEDIA_SIGN_SECRET'];
  const missing = required.filter((k) => !config[k] || String(config[k]).startsWith('dev-') || String(config[k]).startsWith('change-me'));
  if (!config.DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length > 0) {
    throw new Error(`REFUSED TO BOOT IN PRODUCTION — missing env: ${missing.join(', ')}`);
  }
  if (config.ALLOW_OTP_DEBUG === 'true') throw new Error('REFUSED TO BOOT — ALLOW_OTP_DEBUG must never be true in production');
  for (const [k, v] of [['BACHS_API_KEY', config.BACHS_API_KEY], ['TERMII_API_KEY', config.TERMII_API_KEY],
      ['SMTP_HOST', config.SMTP_HOST], ['WATCHUP_API_KEY', config.WATCHUP_API_KEY],
      ['PREMBLY_API_KEY', config.PREMBLY_API_KEY]] as const) {
    if (!v) console.warn(`[config] production running without ${k} (related feature degrades safely)`);
  }
}
