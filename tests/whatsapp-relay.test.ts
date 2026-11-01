// Masked client <-> vendor chat through Kendibo after a vendor accepts.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';

process.env.NODE_ENV = 'test';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { close?: () => Promise<void> } | undefined;
before(async () => {
  process.env.DATABASE_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

const turns = async (waId: string) =>
  (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [waId])).map((r) => String(r.content));

describe('client <-> vendor relay', () => {
  it('hides contact details', async () => {
    const { maskContacts } = await import('../modules/whatsapp/relay.js');
    const out = maskContacts('call me 0803 123 4567 or ada@example.com, see wa.me/2348031234567 at 10am');
    assert.ok(!/0803|ada@|wa\.me/.test(out), out);
    assert.match(out, /10am/);
  });

  it('passes words both ways, labelled and masked, until END', async () => {
    const customer = `23493${Math.floor(1e7 + Math.random() * 8e7)}`;
    const vendor = `23470${Math.floor(1e7 + Math.random() * 8e7)}`;
    const cu = String((await q<{ id: string }>(`INSERT INTO identity.users (phone, role) VALUES ($1,'CUSTOMER') RETURNING id`, [`+${customer}`]))[0].id);
    const vu = String((await q<{ id: string }>(`INSERT INTO identity.users (phone, role, name) VALUES ($1,'PROVIDER','Ewet Cool Air') RETURNING id`, [`+${vendor}`]))[0].id);
    const pid = String((await q<{ id: string }>(`INSERT INTO provider.provider (user_id, business_name) VALUES ($1,'Ewet Cool Air') RETURNING id`, [vu]))[0].id);
    const { requestService } = await import('../modules/requests/request.service.js');
    const r = await requestService.create(cu, { categoryId: 'ac', title: 'AC leaking', lat: 5.0377, lng: 7.9128, contactPhone: `+${customer}`, idempotencyKey: `t_${randomUUID()}`, source: 'whatsapp' });
    await q(`INSERT INTO booking.request_offer (request_id, provider_id, status) VALUES ($1,$2,'accepted')`, [r.id, pid]);
    // Both sides have written recently, so messages go as normal WhatsApp text.
    for (const w of [customer, vendor]) await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [`wamid.${randomUUID()}`, w]);

    const { openRelay } = await import('../modules/whatsapp/relay.js');
    await openRelay(r.id);
    const { handleInbound } = await import('../modules/whatsapp/whatsapp.bot.js');
    const say = (from: string, body: string) => handleInbound({ id: `wamid.${randomUUID()}`, from, type: 'text', text: { body } });

    await say(vendor, 'I can come by 10am. My number is 08031234567');
    assert.ok((await turns(customer)).some((t) => t.startsWith('Ewet Cool Air: I can come by 10am') && t.includes('[number hidden]')));
    await say(customer, 'Great, see you then');
    assert.ok((await turns(vendor)).some((t) => t === 'Customer: Great, see you then'));
    await say(customer, 'END');
    const before = (await turns(vendor)).length;
    await say(customer, 'still there?');
    assert.equal((await turns(vendor)).length, before, 'nothing is relayed after END');
  });
});
