import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlingClient } from '../modules/notifications/sling.client.js';

test('Sling rejects provider failures and does not retry an ambiguous send', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const client = new SlingClient({ token: 'test-token' });
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ status: 'fail', message: 'rejected' }), { status: 200 });
    };
    await assert.rejects(client.sendSms({ to: '07070919911', message: 'test' }), /rejected/);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('connection lost'); };
    await assert.rejects(client.sendSms({ to: '07070919911', message: 'test' }), /connection lost/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Sling never simulates sends or delivery receipts in production', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const client = new SlingClient({ token: '' });
    await assert.rejects(client.sendSms({ to: '07070919911', message: 'test' }), /SLING_NOT_CONFIGURED/);
    await assert.rejects(client.getMessageStatus('sim_test'), /SLING_MESSAGE_STATUS_UNAVAILABLE/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
