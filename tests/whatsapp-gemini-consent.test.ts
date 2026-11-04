import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGemini } from '../modules/whatsapp/gemini-agent.js';
import { hasJobOfferConsent, setJobOfferConsent, sendBusinessInitiated } from '../modules/whatsapp/policy.js';
import { q } from '../packages/database/db.js';

test('Gemini falls back once for provider overload but not invalid requests', async () => {
  const original = globalThis.fetch;
  const previous = { key: process.env.GEMINI_API_KEY, model: process.env.WHATSAPP_GEMINI_MODEL, fallback: process.env.WHATSAPP_GEMINI_FALLBACK_MODEL };
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.WHATSAPP_GEMINI_MODEL = 'primary-model';
  process.env.WHATSAPP_GEMINI_FALLBACK_MODEL = 'fallback-model';
  const params = { model: 'unused', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }], tools: [] } as any;
  const calls: string[] = [];
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return calls.length === 1
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }), { status: 200 });
    };
    assert.equal((await callGemini(params)).stop_reason, 'end_turn');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /fallback-model/);
    calls.length = 0;
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 400 }); };
    await assert.rejects(callGemini(params), /GEMINI_HTTP_400/);
    assert.equal(calls.length, 1);
    calls.length = 0;
    globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network unavailable'); };
    await assert.rejects(callGemini(params), /network unavailable/);
    assert.equal(calls.length, 2);
    calls.length = 0;
    globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 503 }); };
    await assert.rejects(callGemini({ ...params, messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {}, geminiModel: 'fallback-model', geminiThoughtSignature: 'signed' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '{}' }] },
    ] }), /GEMINI_HTTP_503/);
    assert.equal(calls.length, 1, 'never move a signed tool round-trip between models');
    assert.match(calls[0], /fallback-model/);
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of Object.entries({ GEMINI_API_KEY: previous.key, WHATSAPP_GEMINI_MODEL: previous.model, WHATSAPP_GEMINI_FALLBACK_MODEL: previous.fallback })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('Gemini receives server tools and returns a tool call without executing it', async () => {
  const original = globalThis.fetch;
  const key = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  let request: any;
  try {
    globalThis.fetch = async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_services', args: {} }, thoughtSignature: 'sig' }] } }] }), { status: 200 });
    };
    const response = await callGemini({ model: 'ignored', max_tokens: 100, system: 'Follow the rules', messages: [{ role: 'user', content: 'I need help' }], tools: [{ name: 'get_services', description: 'List services', input_schema: { type: 'object', properties: {} } }] } as any);
    assert.equal(request.tools[0].functionDeclarations[0].name, 'get_services');
    assert.equal(response.stop_reason, 'tool_use');
    assert.equal((response.content[0] as any).name, 'get_services');
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key;
  }
});

test('job offers require explicit consent, and STOP revokes it', async () => {
  const number = '2349010000001';
  let sent = false;
  const offer = () => sendBusinessInitiated({ waId: number, whatsapp: async () => { sent = true; }, template: { key: 'job_offer', params: ['test'] }, sms: 'test' });
  assert.equal(await hasJobOfferConsent(number), false);
  assert.equal(await offer(), 'skipped');
  assert.equal(sent, false);
  await setJobOfferConsent(number, true);
  assert.equal(await hasJobOfferConsent(number), true);
  await setJobOfferConsent(number, false);
  assert.equal(await hasJobOfferConsent(number), false);
  assert.equal(await offer(), 'skipped');
});

test('Gemini receives the prior function signature and server result on the next turn', async () => {
  const original = globalThis.fetch;
  const key = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  let request: any;
  try {
    globalThis.fetch = async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Here are the services.' }] } }] }), { status: 200 });
    };
    await callGemini({ model: 'unused', max_tokens: 100, messages: [
      { role: 'user', content: 'What services are available?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'get_services', input: {}, geminiThoughtSignature: 'signed' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '{"trades":["Cleaning"]}' }] },
    ], tools: [{ name: 'get_services', description: 'List services', input_schema: { type: 'object', properties: {} } }] } as any);
    assert.equal(request.contents[1].parts[0].thoughtSignature, 'signed');
    assert.equal(request.contents[2].parts[0].functionResponse.name, 'get_services');
    assert.deepEqual(request.contents[2].parts[0].functionResponse.response.trades, ['Cleaning']);
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key;
  }
});

test('a newer account-wide opt-out wins, and re-enabling job offers does not enable other promotions', async () => {
  const number = '2349010000002';
  const user = (await q<{ id: string }>(`INSERT INTO identity.users (phone) VALUES ($1) RETURNING id`, [`+${number}`]))[0];
  const { notificationService } = await import('../modules/notifications/notification.service.js');
  await setJobOfferConsent(number, true);
  await new Promise(r => setTimeout(r, 10));
  await notificationService.updateUserPreferences(user.id, { promo: false });
  assert.equal(await hasJobOfferConsent(number), false);
  await new Promise(r => setTimeout(r, 10));
  await setJobOfferConsent(number, true);
  assert.equal(await hasJobOfferConsent(number), true);
  assert.equal((await notificationService.getUserPreferences(user.id)).promo, false);
});

test('production refuses a WhatsApp send when credentials are absent', async () => {
  const oldEnv = process.env.NODE_ENV, token = process.env.WHATSAPP_ACCESS_TOKEN, phone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.NODE_ENV = 'production'; process.env.WHATSAPP_ACCESS_TOKEN = ''; process.env.WHATSAPP_PHONE_NUMBER_ID = '';
  try {
    const { wa } = await import('../modules/whatsapp/whatsapp.client.js');
    await assert.rejects(wa.text('2349010000001', 'test'), /WHATSAPP_NOT_CONFIGURED/);
  } finally {
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (token === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = token;
    if (phone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = phone;
  }
});
