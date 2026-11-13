// Onboarding: an email already on another account offers link / retry / skip
// instead of a dead end.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';

let app: { close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.WHATSAPP_CONSENT_GATE = 'on';
  ({ app } = (await import('../apps/api/src/main.js')) as never);
  delete process.env.DATABASE_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

describe('whatsapp onboarding: email already taken', () => {
  it('offers to link the account, then sends a recovery code', async () => {
    const taken = `owner-${randomUUID().slice(0, 6)}@example.com`;
    await q(`INSERT INTO identity.users (email, name) VALUES ($1, 'Existing Owner')`, [taken]);
    const { wa } = await import('../modules/whatsapp/whatsapp.client.js');
    const sent: string[] = [];
    const w = wa as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const k of Object.keys(w)) {
      if (typeof w[k] !== 'function' || k.startsWith('fetch') || k.startsWith('download')) continue;
      const orig = w[k];
      w[k] = async (...a: unknown[]) => { sent.push(`${k}: ${JSON.stringify(a.slice(1)).slice(0, 260)}`); return { id: 'stub' }; };
      void orig;
    }
    const bot = await import('../modules/whatsapp/whatsapp.bot.js');
    const handle = (bot as Record<string, unknown>).handleInbound as ((m: unknown) => Promise<void>) | undefined;
    const num = `23480${Math.floor(1e7 + Math.random() * 8e7)}`;
    const say = async (text?: string, buttonId?: string) => {
      sent.length = 0;
      const msg = buttonId
        ? { from: num, id: `wamid.${randomUUID()}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: buttonId } }, profileName: 'Marshall' }
        : { from: num, id: `wamid.${randomUUID()}`, type: 'text', text: { body: text }, profileName: 'Marshall' };
      if (!handle) throw new Error('handleInbound export not found: ' + Object.keys(bot).join(','));
      await handle(msg);
    };
    await say('Hi');
    await say(undefined, 'consent:agree');
    await say(undefined, 'onb:name:yes');
    await say(taken);
    assert.match(sent.join(' '), /onb:email:mine/);
    assert.match(sent.join(' '), /onb:email:retry/);
    await say(undefined, 'onb:email:mine');
    assert.match(sent.join(' '), /6-digit code/);
    const r = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM messaging.whatsapp_recovery WHERE wa_id=$1 AND status='sent'`, [num]);
    assert.equal(Number(r[0].n), 1);
    await say('I need a plumber');
    assert.match(sent.join(' '), /Plumbing/);
  });
});
