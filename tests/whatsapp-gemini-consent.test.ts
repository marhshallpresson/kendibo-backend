import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGemini } from '../modules/whatsapp/gemini-agent.js';
import { hasJobOfferConsent, setJobOfferConsent, sendBusinessInitiated } from '../modules/whatsapp/policy.js';

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
