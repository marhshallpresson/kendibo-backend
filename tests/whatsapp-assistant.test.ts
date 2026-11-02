// The rebuilt WhatsApp assistant: classifier quality on held-out lines, the
// deterministic extractors, and whole conversations through the router.
// No LLM is configured here, except where a fake one proves it is NOT called.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

process.env.NODE_ENV = 'test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
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

const NOW = new Date('2026-10-31T09:00:00Z'); // Saturday, 10:00 in Lagos
const watDay = (offset: number) => new Date(Date.now() + 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const number = () => `23490${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

async function bot() { return import('../modules/whatsapp/whatsapp.bot.js'); }
const say = async (waId: string, text: string) =>
  (await bot()).handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'text', text: { body: text } }, 'Ada Okon');
const tap = async (waId: string, id: string, title = '', kind: 'button' | 'list' = 'button') =>
  (await bot()).handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'interactive', interactive: kind === 'list' ? { list_reply: { id, title } } : { button_reply: { id, title } } }, 'Ada Okon');

/** Everything the bot sent to this number while `act` ran. */
async function botReply(waId: string, act: () => Promise<unknown>): Promise<string> {
  const seen = new Set((await q<{ id: string }>(`SELECT id FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [waId])).map((r) => String(r.id)));
  await act();
  const rows = await q<{ id: string; content: string }>(`SELECT id, content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [waId]);
  return rows.filter((r) => !seen.has(String(r.id))).map((r) => String(r.content)).join('\n---\n');
}
const draftOf = async (waId: string) =>
  (await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_job_draft WHERE wa_id=$1 ORDER BY created_at DESC LIMIT 1`, [waId]))[0];

describe('understanding layer', () => {
  it('meets the quality bar on held-out seed lines', async () => {
    const { nluReady } = await import('../modules/whatsapp/nlu/index.js');
    const m = await nluReady();
    assert.ok(m.heldOut.precisionAtThreshold >= 0.85, `precision when confident: ${m.heldOut.precisionAtThreshold}`);
    assert.ok(m.heldOut.macroF1 >= 0.55, `macro-F1: ${m.heldOut.macroF1}`);
    assert.ok(m.examples >= 500);
  });

  it('reads naira amounts the way people type them, and nothing else', async () => {
    const { extractBudgetKobo } = await import('../modules/whatsapp/nlu/entities.js');
    assert.equal(extractBudgetKobo('my budget is 15k'), 1_500_000n);
    assert.equal(extractBudgetKobo('₦20,000 abeg'), 2_000_000n);
    assert.equal(extractBudgetKobo('I fit pay twenty five thousand'), 2_500_000n);
    assert.equal(extractBudgetKobo('between 10k and 15k'), 1_500_000n, 'a range means the most they will pay');
    assert.equal(extractBudgetKobo('1.5 million for the whole building'), 150_000_000n);
    assert.equal(extractBudgetKobo('the room is 5m wide'), null, 'a bare m is metres');
    assert.equal(extractBudgetKobo('15000'), null, 'a bare number is not money');
    assert.equal(extractBudgetKobo('15000', { expectingBudget: true }), 1_500_000n, '...unless we just asked for the budget');
    assert.equal(extractBudgetKobo('call me on 08031234567'), null);
    assert.equal(extractBudgetKobo('come by 4pm'), null);
    assert.equal(extractBudgetKobo('it is a 3 bedroom flat'), null);
  });

  it('reads days and times in Nigerian phrasing (Lagos time)', async () => {
    const { extractWhen } = await import('../modules/whatsapp/nlu/entities.js');
    assert.deepEqual(extractWhen('tomorrow morning', NOW), { date: '2026-11-01', window: 'morning' });
    assert.deepEqual(extractWhen('next tomorrow evening', NOW), { date: '2026-11-02', window: 'evening' });
    assert.deepEqual(extractWhen('Saturday afternoon', NOW), { date: '2026-10-31', window: 'afternoon' });
    assert.equal(extractWhen('monday', NOW).date, '2026-11-02');
    assert.equal(extractWhen('5th November', NOW).date, '2026-11-05');
    assert.equal(extractWhen('come by 4', NOW).window, 'evening');
    assert.equal(extractWhen('at 10', NOW).window, 'morning');
    assert.deepEqual(extractWhen('asap', NOW), { urgent: true, date: '2026-10-31', window: 'morning' });
    assert.equal(extractWhen('in March 2027', NOW).date, undefined, 'more than 60 days out is ignored');
  });

  it('picks the trade from the words that matter most', async () => {
    const { tradeFromLexicon } = await import('../modules/whatsapp/nlu/entities.js');
    assert.equal(tradeFromLexicon('clean my toilet')?.trade, 'cleaning');
    assert.equal(tradeFromLexicon('my AC is leaking water')?.trade, 'ac');
    assert.equal(tradeFromLexicon('fridge no dey cool')?.trade, 'appliance');
    assert.equal(tradeFromLexicon('termites are eating my door')?.trade, 'pest');
    assert.equal(tradeFromLexicon('no light for one side of the house')?.trade, 'electrical');
    assert.equal(tradeFromLexicon('the man never reach'), null);
  });

  it('redacts contact details, codes and ID numbers before anything is stored', async () => {
    const { redact } = await import('../modules/whatsapp/nlu/entities.js');
    const out = redact('call 08031234567 or ada@example.com, my otp is 482913 and BVN 22212345678');
    assert.ok(!/0803|ada@|482913|22212345678/.test(out), out);
    assert.match(out, /<phone>/);
    assert.match(out, /otp is <secret>/);
  });
});

describe('conversations through the router (no LLM)', () => {
  it('first contact says it is an automated assistant and offers the menu', async () => {
    const w = number();
    const r = await botReply(w, () => say(w, 'hi'));
    assert.match(r, /automated assistant/);
    assert.match(r, /Book a service/);
  });

  it('declines off-topic requests without calling the LLM', async () => {
    const { setLlmForTests } = await import('../modules/whatsapp/agent.js');
    let calls = 0;
    setLlmForTests(async () => {
      calls++;
      return { id: 'x', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'here is a poem' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.BetaMessage;
    });
    try {
      const w = number();
      await say(w, 'hello');
      const r = await botReply(w, () => say(w, 'write me a poem'));
      assert.match(r, /only help with Kendibo home services/);
      assert.equal(calls, 0, 'the model was never asked');
      const ev = await q<{ route: string }>(`SELECT route FROM ml.nlu_event WHERE text_redacted=$1`, ['write me a poem']);
      assert.ok(ev.some((e) => e.route === 'refuse'));
    } finally {
      setLlmForTests(null);
    }
  });

  it('books a job from one Pidgin message: trade, budget, day and time understood', async () => {
    const w = number();
    let r = await botReply(w, () => say(w, 'my AC dey leak water, budget 15k, tomorrow morning'));
    assert.match(r, /AC Services/);
    assert.match(r, /₦15,000/);
    assert.match(r, /picture|photo/i, 'the next question is the optional photo');
    const d = await draftOf(w);
    assert.equal(d.category_id, 'ac');
    assert.equal(String(d.budget_kobo), '1500000');
    assert.equal((await import('../modules/whatsapp/draft.js')).isoDay(d.scheduled_date), watDay(1));
    assert.equal(d.time_window, 'morning');

    r = await botReply(w, () => tap(w, 'flow:skip_photo', 'Skip photo'));
    assert.match(r, /Set location/, 'budget is known, so it goes straight to the location');

    r = await botReply(w, async () => (await bot()).handleInbound({ id: `wamid.${randomUUID()}`, from: w, type: 'location', location: { latitude: 5.0377, longitude: 7.9128, address: 'Ewet Housing' } }));
    assert.match(r, /Location saved/);
    assert.match(r, /Here's your request/, 'day and time were given up front, so it asks to confirm');
    assert.match(r, /Find vendors/);

    r = await botReply(w, () => tap(w, 'flow:confirm', 'Find vendors'));
    assert.match(r, /request is in/);
    const done = await draftOf(w);
    assert.equal(done.status, 'submitted');
    const sr = await q<{ budget_kobo: string; category_id: string; source: string }>(`SELECT budget_kobo, category_id, source FROM booking.service_request WHERE id=$1`, [done.request_id]);
    assert.equal(String(sr[0].budget_kobo), '1500000');
    assert.equal(sr[0].category_id, 'ac');
    assert.equal(sr[0].source, 'whatsapp');

    r = await botReply(w, () => tap(w, 'flow:confirm', 'Find vendors'));
    assert.match(r, /already been sent/, 'a second tap does not create a second request');
  });

  it('asks for the trade when it cannot tell, and a list tap sets it', async () => {
    const w = number();
    await say(w, 'hello');
    let r = await botReply(w, () => say(w, 'I need someone to fix something in my house'));
    assert.match(r, /Which kind of job/);
    r = await botReply(w, () => tap(w, 'cat:plumbing', 'Plumbing', 'list'));
    assert.match(r, /photo/i);
    assert.equal((await draftOf(w)).category_id, 'plumbing');
  });

  it('answers prices from the catalogue, never invented', async () => {
    const w = number();
    await say(w, 'hello');
    const r = await botReply(w, () => say(w, 'how much to fix AC'));
    assert.match(r, /AC General Service: from ₦15,000/);
    assert.match(r, /AC Installation: priced after inspection/);
  });

  it('hands over to a person and stays quiet until the customer types "bot"', async () => {
    const w = number();
    await say(w, 'hello');
    let r = await botReply(w, () => say(w, 'agent'));
    assert.match(r, /Someone from the Kendibo team/);
    r = await botReply(w, () => say(w, 'are you there?'));
    assert.equal(r, '', 'the support team owns the chat');
    r = await botReply(w, () => say(w, 'bot'));
    assert.match(r, /What would you like to do/);
  });
});

describe('message policy', () => {
  it('outside the 24h window a job offer goes by SMS, inside it by WhatsApp buttons', async () => {
    const { notifyProviderOfOffer } = await bot();
    const v = number();
    const before = await botReply(v, () => notifyProviderOfOffer(`+${v}`, randomUUID(), 'AC repair, 2 km away'));
    assert.equal(before, '', 'no free-form WhatsApp message to someone who has not written in 24h');
    await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [`wamid.${randomUUID()}`, v]);
    const inside = await botReply(v, () => notifyProviderOfOffer(`+${v}`, randomUUID(), 'AC repair, 2 km away'));
    assert.match(inside, /New job near you/);
    assert.match(inside, /Accept \| Decline/);
  });

  it('retries once a turn that a crash cut short', async () => {
    const { sweepInbound } = await bot();
    const w = number();
    const m = { id: `wamid.${randomUUID()}`, from: w, type: 'text', text: { body: 'hi' } };
    await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id, payload, started_at, received_at, attempts) VALUES ($1,$2,$3,$4,$4,1)`,
      [m.id, w, JSON.stringify(m), new Date(Date.now() - 20 * 60_000).toISOString()]);
    const r = await botReply(w, () => sweepInbound());
    assert.match(r, /automated assistant/);
    const row = (await q<{ processed_at: string | null; attempts: number }>(`SELECT processed_at, attempts FROM messaging.whatsapp_inbound WHERE message_id=$1`, [m.id]))[0];
    assert.ok(row.processed_at);
    assert.equal(Number(row.attempts), 2);
    assert.equal(await botReply(w, () => sweepInbound()), '', 'never twice');
  });
});

describe('labelling and retraining', () => {
  it('ops labels feed a retrain that only switches on if it holds up', async () => {
    const { labelEvent, retrainNlu, nluStatus } = await import('../modules/whatsapp/nlu/index.js');
    const lines: [string, string][] = [
      ['abeg my AC no dey work at all', 'book'],
      ['wetin be una price for cleaning', 'pricing'],
      ['I no fit wait again connect me to person', 'human'],
    ];
    let lastId = '';
    for (const [text, intent] of lines) {
      const r = await q<{ id: string }>(
        `INSERT INTO ml.nlu_event (wa_hash, text_redacted, intent, confidence, route) VALUES ('test', $1, 'out_of_scope', 0.2, 'clarify') RETURNING id`, [text],
      );
      lastId = String(r[0].id);
      assert.ok(await labelEvent(lastId, intent, 'test-admin'));
    }
    await assert.rejects(() => labelEvent(lastId, 'not_an_intent', 'test-admin'), /UNKNOWN_INTENT/);
    const res = await retrainNlu();
    assert.ok(res.labelled >= 3);
    assert.ok(typeof res.promoted === 'boolean' && res.reason.length > 0);
    const st = await nluStatus();
    if (res.promoted) assert.equal(st.version, res.version);
    assert.ok(st.labelled >= 3);
  });

  it('the admin view needs an ops seat', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/admin/assistant/status' });
    assert.equal(anon.statusCode, 401);
    const admin = String((await q<{ id: string }>(`INSERT INTO identity.users (name, email, role) VALUES ('Ops', $1, 'SUPER_ADMIN') RETURNING id`, [`ops-${randomUUID()}@kendibo.local`]))[0].id);
    const ok = await app.inject({ method: 'GET', url: '/v1/admin/assistant/status', headers: { authorization: `Bearer ${signAccess(admin, [])}` } });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().data.heldOut.macroF1 > 0);
    const queue = await app.inject({ method: 'GET', url: '/v1/admin/assistant/review', headers: { authorization: `Bearer ${signAccess(admin, [])}` } });
    assert.equal(queue.statusCode, 200);
    assert.ok(Array.isArray(queue.json().data.items));
  });
});
