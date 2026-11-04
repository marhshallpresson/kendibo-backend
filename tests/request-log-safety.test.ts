import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { safeRequestLog } from '../packages/observability/safe-request-log.js';

test('request logs do not expose signed query strings', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const app = Fastify({ logger: { stream, serializers: { req: safeRequestLog } } });
  app.get('/w/location', async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/w/location?t=private-signed-token' })).statusCode, 200);
    assert.match(output, /\/w\/location/);
    assert.doesNotMatch(output, /private-signed-token/);
  } finally { await app.close(); }
});
