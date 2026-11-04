import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wa } from '../modules/whatsapp/whatsapp.client.js';

test('Meta send errors expose only the numeric provider code', async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const oldPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-key';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 131037, message: 'private-provider-details' } }), { status: 400 });
    await assert.rejects(wa.text('2348000000001', 'test'), (e: Error) => {
      assert.equal(e.message, 'WHATSAPP_SEND_400_META_131037');
      assert.doesNotMatch(e.message, /private-provider-details/);
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'private-provider-details' } }), { status: 400 });
    await assert.rejects(wa.text('2348000000001', 'test'), /WHATSAPP_SEND_400$/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = oldToken;
    if (oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhone;
  }
});
