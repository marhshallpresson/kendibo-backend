// Config — versioned runtime config, validated once at boot (zod).
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://kendibo:kendibo@localhost:5432/kendibo'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().default('dev-access'),
  JWT_REFRESH_SECRET: z.string().default('dev-refresh'),
  BACHS_API_KEY: z.string().default(''),
  BACHS_BASE_URL: z.string().default('https://sandbox-api.bachs.io'),
  BACHS_WEBHOOK_SECRET: z.string().default(''),
  BACHS_ACCOUNT_ID: z.string().default(''),
  FLW_SECRET_KEY: z.string().default(''),
  FLW_PUBLIC_KEY: z.string().default(''),
  FLW_SECRET_HASH: z.string().default(''),
  WATCHUP_API_KEY: z.string().default(''),
  WATCHUP_ENV: z.string().default('development'),
  WATCHUP_RELEASE: z.string().default('dev'),
});
export type AppConfig = z.infer<typeof schema>;
export const config: AppConfig = schema.parse(process.env);
