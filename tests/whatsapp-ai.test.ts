// WhatsApp AI assistant, in-WhatsApp pages and the matching model.
// The LLM is replaced by a scripted fake (setLlmForTests), so these run with no
// API key and no network. WhatsApp sends fall back to dev logging.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { q } from '../packages/database/db.js';

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';

let app: { inject: (opts: unknown) => Promise<{ statusCode: number; headers: Record<string, string>; body: string; json: () => any }>; close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  const { setLlmForTests } = await import('../modules/whatsapp/agent.js');
  setLlmForTests(null);
  await app?.close?.().catch(() => {});
});

const UYO = { lat: 5.0377, lng: 7.9128 };

// Minimal BetaMessage builders for the scripted fake model.
const msg = (content: unknown[], stop: string): Anthropic.Beta.BetaMessage =>
  ({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.BetaMessage);
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `tu_${randomUUID().slice(0, 8)}`, name, input });

describe('signed WhatsApp links', () => {
  it('verifies only the right purpose, untampered and unexpired', async () => {
    const { signLink, verifyLink } = await import('../modules/whatsapp/links.js');
    const t = signLink({ w: '2348030000001', d: randomUUID(), p: 'loc' });
    assert.ok(verifyLink(t, 'loc'));
    assert.equal(verifyLink(t, 'vendors'), null, 'purpose is bound');
    assert.equal(verifyLink(`${t}x`, 'loc'), null, 'tampered MAC rejected');
    const expired = signLink({ w: '1', d: '2', p: 'loc' }, -10);
    assert.equal(verifyLink(expired, 'loc'), null, 'expired rejected');
  });
});

describe('WhatsApp webhook signature', () => {
  it('rejects unsigned posts and accepts a valid X-Hub-Signature-256', async () => {
    const payload = JSON.stringify({ entry: [] });
    const bad = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json' } });
    assert.equal(bad.statusCode, 401);
    const sig = crypto.createHmac('sha256', 'test-app-secret').update(payload).digest('hex');
    const good = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` } });
    assert.equal(good.statusCode, 200);
  });
});

describe('AI agent tools (scripted model)', () => {
  it('captures the job, refuses to submit without a location, then submits after the map pin', async () => {
    const { setLlmForTests, runAgent } = await import('../modules/whatsapp/agent.js');
    const waId = `23480${Math.floor(Math.random() * 1e8)}`;
    const user = (await q<{ id: string }>(`INSERT INTO identity.users (phone, role) VALUES ($1,'CUSTOMER') RETURNING id`, [`+${waId}`]))[0].id;
    const seen: string[] = [];

    // Turn 1: model saves the need + trade, then tries to submit too early.
    let step = 0;
    setLlmForTests(async (params) => {
      const last = params.messages[params.messages.length - 1];
      if (last.role === 'user' && Array.isArray(last.content)) {
        for (const b of last.content as { type: string; content?: string }[]) if (b.type === 'tool_result') seen.push(String(b.content));
      }
      step++;
      if (step === 1) return msg([toolUse('update_job_request', { need: 'AC is leaking water', category_id: 'ac', budget_naira: 15000, preferred_day: 'tomorrow', time_window: 'morning' })], 'tool_use');
      if (step === 2) return msg([toolUse('submit_job_request', {})], 'tool_use');
      return msg([{ type: 'text', text: 'Got it. Please set your location.' }], 'end_turn');
    });
    assert.equal(await runAgent({ waId, userId: user, text: 'my AC dey leak water' }), true);
    assert.ok(seen.some((s) => s.includes('"saved"')), 'draft saved');
    assert.ok(seen.some((s) => s.includes('Cannot submit yet') && s.includes('location')), 'submit blocked without location');
    const draft = (await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_job_draft WHERE wa_id=$1`, [waId]))[0];
    assert.equal(draft.category_id, 'ac');
    assert.equal(String(draft.budget_kobo), '1500000');

    // The map page saves the pin with a signed link.
    const { signLink } = await import('../modules/whatsapp/links.js');
    const t = signLink({ w: waId, d: String(draft.id), p: 'loc' });
    const page = await app.inject({ method: 'GET', url: `/w/location?t=${encodeURIComponent(t)}` });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers['content-security-policy']), /nonce-/);
    let calls = 0;
    const submitResults: string[] = [];
    setLlmForTests(async (params) => {
      const last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content)) for (const b of last.content as { type: string; content?: string }[]) if (b.type === 'tool_result') submitResults.push(String(b.content));
      return ++calls === 1 ? msg([toolUse('submit_job_request', {})], 'tool_use') : msg([{ type: 'text', text: 'Submitted.' }], 'end_turn');
    });
    const saved = await app.inject({ method: 'POST', url: '/w/location', payload: { t, lat: UYO.lat, lng: UYO.lng, address: 'Ewet Housing', landmark: 'Near the church' } });
    assert.equal(saved.statusCode, 200, saved.body);
    // The agent continues in the background; wait for it (bounded).
    let after: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      after = (await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_job_draft WHERE wa_id=$1`, [waId]))[0];
      if (after.status === 'submitted' || submitResults.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < 100 && after.status !== 'submitted'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = (await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_job_draft WHERE wa_id=$1`, [waId]))[0];
    }
    assert.ok(!submitResults.some((s) => s.includes('error')), `submit tool result: ${submitResults.join(' | ')}`);
    assert.equal(Number(after.lat).toFixed(4), UYO.lat.toFixed(4));
    assert.equal(after.status, 'submitted');
    assert.ok(after.request_id, 'a service request was created');
  });

  it('rejects an unknown trade id instead of trusting the model', async () => {
    const { setLlmForTests, runAgent } = await import('../modules/whatsapp/agent.js');
    const waId = `23481${Math.floor(Math.random() * 1e8)}`;
    const user = (await q<{ id: string }>(`INSERT INTO identity.users (phone, role) VALUES ($1,'CUSTOMER') RETURNING id`, [`+${waId}`]))[0].id;
    const results: string[] = [];
    let n = 0;
    setLlmForTests(async (params) => {
      const last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content)) for (const b of last.content as { type: string; content?: string }[]) if (b.type === 'tool_result') results.push(String(b.content));
      return ++n === 1 ? msg([toolUse('update_job_request', { category_id: 'rocket_repair' })], 'tool_use') : msg([{ type: 'text', text: 'ok' }], 'end_turn');
    });
    await runAgent({ waId, userId: user, text: 'fix my rocket' });
    assert.ok(results[0]?.includes('Unknown trade id'));
  });
});

describe('in-WhatsApp pages', () => {
  it('expired or forged tokens get the expired page', async () => {
    const r = await app.inject({ method: 'GET', url: '/w/location?t=forged.token' });
    assert.equal(r.statusCode, 410);
    const v = await app.inject({ method: 'GET', url: '/w/vendors?t=nope' });
    assert.equal(v.statusCode, 410);
  });

  it('location outside coverage is refused', async () => {
    const { signLink } = await import('../modules/whatsapp/links.js');
    const waId = '2348099999999';
    const user = (await q<{ id: string }>(`INSERT INTO identity.users (phone, role) VALUES ($1,'CUSTOMER') RETURNING id`, [`+${waId}`]))[0].id;
    const d = (await q<{ id: string }>(`INSERT INTO messaging.whatsapp_job_draft (wa_id, user_id) VALUES ($1,$2) RETURNING id`, [waId, user]))[0].id;
    const t = signLink({ w: waId, d, p: 'loc' });
    const r = await app.inject({ method: 'POST', url: '/w/location', payload: { t, lat: 51.5, lng: -0.12 } }); // London
    assert.equal(r.statusCode, 422);
  });
});

describe('matching model', () => {
  it('closer, better-rated, budget-fitting vendors score higher', async () => {
    const { matchingService, score } = await import('../modules/matching/matching.service.js');
    const base = { radiusKm: 15, reviewCount: 10, completedJobs: 10, acceptanceRate: 0.9, onTime: 0.9, cancellations: 0, need: 'ac leaking water', profile: 'AC repair and gas refill', online: true };
    const near = score(matchingService.features({ ...base, distanceKm: 1, avgRating: 4.8 }));
    const far = score(matchingService.features({ ...base, distanceKm: 12, avgRating: 4.8 }));
    const poor = score(matchingService.features({ ...base, distanceKm: 1, avgRating: 3.1 }));
    assert.ok(near > far, 'distance');
    assert.ok(near > poor, 'rating');
    const fits = matchingService.features({ ...base, distanceKm: 2, avgRating: 4.5, budgetKobo: 2_000_000n, typicalKobo: 1_500_000n });
    const over = matchingService.features({ ...base, distanceKm: 2, avgRating: 4.5, budgetKobo: 1_000_000n, typicalKobo: 3_000_000n });
    assert.ok(fits.budget > over.budget, 'budget fit');
  });

  it('the trainer learns from outcomes (synthetic data)', async () => {
    const { fit, auc, labelOf } = await import('../modules/matching/trainer.js');
    const { FEATURES } = await import('../modules/matching/matching.service.js');
    // Ground truth: proximity and reliability drive acceptance.
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ex = Array.from({ length: 400 }, (_, i) => {
      const x = Object.fromEntries(FEATURES.map((k) => [k, rnd()])) as Record<(typeof FEATURES)[number], number>;
      const p = 1 / (1 + Math.exp(-(4 * x.dist + 3 * x.reliability - 3.5)));
      return { requestId: `r${i}`, x, y: (rnd() < p ? 1 : 0) as 0 | 1 };
    });
    const m = fit(ex.slice(0, 300));
    assert.ok(auc(ex.slice(300), m) > 0.7, 'held-out AUC above 0.7');
    assert.equal(labelOf({ accepted: true, completed: true, rating: 5 }), 1);
    assert.equal(labelOf({ accepted: true, completed: false, rating: null }), 0);
    assert.equal(labelOf({ accepted: true, completed: true, rating: 2 }), 0);
    assert.equal(labelOf({ accepted: false, completed: null, rating: null }), 0);
  });
});
