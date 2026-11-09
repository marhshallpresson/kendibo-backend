import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { wa } from '../modules/whatsapp/whatsapp.client.js';
import { handleInbound } from '../modules/whatsapp/whatsapp.bot.js';
import { q } from '../packages/database/db.js';
import { signRefresh, rotateRefresh } from '../packages/auth/auth.js';

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

test('WhatsApp 131037 send block falls back to SMS and marks inbound message processed', async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const oldPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-key';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  const { sms } = await import('../modules/notifications/channels.js');
  const oldSmsSend = sms.send;
  const smsSent: { to: string; body: string }[] = [];
  sms.send = async (to: string, body: string) => { smsSent.push({ to, body }); return { id: 'test-sms' }; };
  const msgId = `wamid.${randomUUID()}`;
  const from = `23481${Math.floor(10000000 + Math.random() * 89999999)}`;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 131037, message: 'Display name approval required' } }), { status: 400 });
    await handleInbound({ id: msgId, from, type: 'text', text: { body: 'Hello' } }, 'Ada');
    const inbound = await q<{ processed_at: string | null }>(`SELECT processed_at FROM messaging.whatsapp_inbound WHERE message_id=$1`, [msgId]);
    assert.ok(inbound[0]?.processed_at, 'inbound message is marked processed rather than stuck in queue');
    assert.equal(smsSent.length, 1);
    assert.equal(smsSent[0].to, `+${from}`);
  } finally {
    sms.send = oldSmsSend;
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = oldToken;
    if (oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhone;
  }
});

test('Concurrent rotateRefresh calls with the same token coalesce instead of revoking session', async () => {
  const email = `refresh-${randomUUID()}@kendibo.local`;
  const userRows = await q<{ id: string }>(`INSERT INTO identity.users (email, role) VALUES ($1, 'CUSTOMER') RETURNING id`, [email]);
  const userId = String(userRows[0].id);
  const { token } = await signRefresh(userId, 'device-1');
  const [r1, r2, r3] = await Promise.all([rotateRefresh(token), rotateRefresh(token), rotateRefresh(token)]);
  assert.ok(r1?.access && r1?.refresh);
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);
});
