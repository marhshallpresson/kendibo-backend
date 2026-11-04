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

test('OTP uses the documented v1 SMS endpoint without an explicit route or retries', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://app.sling.com.ng/api/v1/send-sms');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.sender, 'Kendibo');
      assert.equal(body.to, '+2347070919911');
      assert.equal(body.type, undefined);
      return new Response(JSON.stringify({ status: 'success', message_id: 'provider-id' }), { status: 200 });
    };
    const client = new SlingClient({ token: 'test-token', v1BaseUrl: 'https://app.sling.com.ng/api/v1', senders: { sms: 'Kendibo' } });
    const result = await client.sendSms({ to: '07070919911', message: 'test', type: 'otp' });
    assert.equal(result.message_id, 'provider-id');
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw new Error('connection lost'); };
    await assert.rejects(client.sendSms({ to: '07070919911', message: 'test', type: 'otp' }), /connection lost/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
