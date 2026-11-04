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
  SMTP_HOST: z.string().default(''),
  SMTP_FROM: z.string().default(''),
  SMTP_FROM_NAME: z.string().default('Kendibo'),
  WATCHUP_API_KEY: z.string().default(''),
  WATCHUP_ENV: z.string().default('development'),
  WATCHUP_RELEASE: z.string().default('dev'),
  KYC_PROVIDER: z.string().default('prembly'),
  DOJAH_API_KEY: z.string().default(''),
  // Prembly server verification calls use the secret key only. The public key
  // belongs to client widgets/SDKs and is not sent by the server.
  PREMBLY_SECRET_KEY: z.string().default(''),
  PREMBLY_API_KEY: z.string().default(''), // legacy name for the secret key
  PREMBLY_PUBLIC_KEY: z.string().default(''),
  PREMBLY_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),
  PREMBLY_BASE_URL: z.string().default('https://api.prembly.com'),
  PREMBLY_MCP_URL: z.string().default('https://mcp.prembly.com/mcp'),
  PREMBLY_COUNTRY: z.string().default('NG'),
  // Sling (HelloSling / SlingAfrica) — https://docs.hellosling.com
  SLING_API_TOKEN: z.string().default(''),
  SLING_BASE_URL: z.string().default('https://app.sling.com.ng/api/v2'),
  SLING_V1_BASE_URL: z.string().default('https://app.sling.com.ng/api/v1'),
  SLING_SMS_SENDER: z.string().default('Kendibo'),
  SLING_WHATSAPP_SENDER: z.string().default('Kendibo'),
  SLING_RCS_SENDER: z.string().default('Kendibo'),
  SLING_TRUECALLER_SENDER: z.string().default('Kendibo'),
  SLING_EMAIL_SENDER: z.string().default('hello@kendibo.com'),
  SLING_WEBHOOK_SECRET: z.string().default(''),
  SLING_DEFAULT_GROUP_ID: z.string().default(''),
  SLING_ONBOARDING_FORM_ID: z.string().default(''),
  // AI-Assisted CTA Campaigns & Customer Retainers (Gemini)
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
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
  for (const [k, v] of [['BACHS_API_KEY', config.BACHS_API_KEY], ['SLING_API_TOKEN', config.SLING_API_TOKEN],
      ['SMTP_HOST', config.SMTP_HOST], ['WATCHUP_API_KEY', config.WATCHUP_API_KEY],
      ['PREMBLY_SECRET_KEY', config.PREMBLY_SECRET_KEY || config.PREMBLY_API_KEY]] as const) {
    if (!v) console.warn(`[config] production running without ${k} (related feature degrades safely)`);
  }
  if (config.KYC_PROVIDER === 'stub') console.warn('[config] KYC_PROVIDER=stub: identity checks are simulated, nobody is really verified');
  if (config.PREMBLY_ENVIRONMENT !== 'live') console.warn('[config] PREMBLY_ENVIRONMENT is not "live": identity checks are using sandbox keys');
}
