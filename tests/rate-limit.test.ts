import { test } from 'node:test';
import assert from 'node:assert/strict';

test('OTP verification is rate limited without contacting a provider', async () => {
  const { app } = await import('../apps/api/src/main.js');
  try {
    let response;
    for (let i = 0; i < 11; i++) {
      response = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', remoteAddress: '192.0.2.42', payload: {} });
      if (i === 0) assert.equal(response.statusCode, 400);
    }
    assert.equal(response?.statusCode, 429);
    assert.equal(response?.json().error.code, 'RATE_LIMIT');
    for (let i = 0; i < 101; i++) {
      response = await app.inject({ method: 'GET', url: '/health/live', remoteAddress: '192.0.2.43' });
    }
    assert.equal(response?.statusCode, 429, 'global per-IP limit applies to normal routes');
  } finally { await app.close(); }
});
