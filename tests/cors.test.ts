// CORS tests (node:test). The deployed web app (https://kendibo-app.pxxl.click)
// must pass every preflight, and unknown origins must be denied cleanly (no 500,
// no Access-Control-Allow-Origin) — a thrown origin error turns every OPTIONS
// into a 500 and shows up in the browser as "API unreachable".
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

type InjectOpts = { method: string; url: string; headers?: Record<string, string> };
type InjectRes = { statusCode: number; headers: Record<string, string | string[] | undefined> };
// Fastify's `inject` is overloaded (callback + promise forms); a narrow
// structural type here rejects the instance, so the promise form is asserted.
let app: {
  inject: (opts: InjectOpts) => Promise<InjectRes>;
  close?: () => Promise<void>;
};
const asApp = (instance: unknown): typeof app => instance as typeof app;

const preflight = (origin: string): InjectOpts => ({
  method: 'OPTIONS',
  url: '/v1/categories',
  headers: {
    origin,
    'access-control-request-method': 'GET',
    'access-control-request-headers': 'authorization,content-type,idempotency-key',
  },
});
const allowOrigin = (res: InjectRes): unknown => res.headers['access-control-allow-origin'];

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  app = asApp((await import('../apps/api/src/main.js')).app);
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  await app?.close?.().catch(() => {});
});

describe('CORS', () => {
  it('allows the deployed web app origin', async () => {
    const res = await app.inject(preflight('https://kendibo-app.pxxl.click'));
    assert.ok(res.statusCode < 300, `preflight failed: ${res.statusCode}`);
    assert.equal(allowOrigin(res), 'https://kendibo-app.pxxl.click');
  });

  it('allows dashboard-configured origins even if unset in env', async () => {
    const res = await app.inject(preflight('https://kendibo-page.pxxlspace.cv'));
    assert.ok(res.statusCode < 300, `preflight failed: ${res.statusCode}`);
    assert.equal(allowOrigin(res), 'https://kendibo-page.pxxlspace.cv');
  });

  it('denies unknown origins without a 500 and without ACAO', async () => {
    const res = await app.inject(preflight('https://evil.example'));
    assert.ok(res.statusCode < 500, `deny must not 500, got ${res.statusCode}`);
    assert.equal(allowOrigin(res), undefined);
  });

  it('allows native clients that send no Origin header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/categories' });
    assert.ok(res.statusCode < 500, `got ${res.statusCode}`);
  });

  it('answers actual GETs from an allowed origin with ACAO', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/categories',
      headers: { origin: 'https://kendibo-app.pxxl.click' },
    });
    assert.equal(allowOrigin(res), 'https://kendibo-app.pxxl.click');
  });
});
