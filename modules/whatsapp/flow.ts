// Step-by-step booking over WhatsApp. The server owns the order of the steps
// and every value saved; free text only fills draft fields through
// patchFromUnderstanding. Each step is ONE message (Meta bills service
// messages), with reply buttons or a list wherever a tap beats typing.
//
//   need → trade → photo (optional) → budget (optional) → location → day → time → confirm
import { q } from '../../packages/database/db.js';
import { wa } from './whatsapp.client.js';
import { locationLink } from './links.js';
import { patchDraft, submitDraft, type Draft } from './draft.js';
import { WINDOW_HOURS, type TimeWindow } from './nlu/entities.js';
import type { Understanding } from './nlu/index.js';

export type Step = 'need' | 'trade' | 'photo' | 'budget' | 'location' | 'day' | 'window' | 'confirm';
/** Per-conversation flags kept in messaging.whatsapp_session.data. */
export interface Asked { photo?: boolean; budget?: boolean; dayPick?: boolean; lang?: 'en' | 'pcm'; cancelDraftId?: string; pendingText?: string; onboard?: 'name' | 'name_text' | 'email' }

const naira = (k: bigint | number | string) => `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
const say = (lang: Asked['lang'], en: string, pcm?: string) => (lang === 'pcm' && pcm ? pcm : en);
const watHour = () => new Date(Date.now() + 3600_000).getUTCHours();
const watToday = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const prettyDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const WINDOW_LABEL: Record<TimeWindow, string> = { morning: 'Morning 8–12', afternoon: 'Afternoon 12–4', evening: 'Evening 4–7' };
const WINDOW_END: Record<TimeWindow, number> = { morning: 11, afternoon: 15, evening: 18 };

let tradeCache: { at: number; rows: { id: string; name: string; description: string | null }[] } | null = null;
export async function trades() {
  if (tradeCache && Date.now() - tradeCache.at < 300_000) return tradeCache.rows;
  const rows = await q<{ id: string; name: string; description: string | null }>(`SELECT id, name, description FROM catalog.category WHERE active ORDER BY sort_order LIMIT 10`);
  tradeCache = { at: Date.now(), rows: rows.map((r) => ({ id: String(r.id), name: String(r.name), description: r.description ? String(r.description) : null })) };
  return tradeCache.rows;
}
export async function tradeName(id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await trades()).find((t) => t.id === id)?.name ?? id;
}

export function nextStep(d: Draft, a: Asked): Step {
  if (!d.need) return 'need';
  if (!d.category_id) return 'trade';
  if (!d.photo_asset_ids.length && !a.photo) return 'photo';
  if (!d.budget_kobo && !a.budget) return 'budget';
  if (d.lat == null || d.lng == null) return 'location';
  if (!d.scheduled_date) return 'day';
  if (!d.time_window) return 'window';
  return 'confirm';
}

const GENERIC_ASK = /^(i (want|need|wan|wish|would like) (to )?(book|make|get|do|request)( a| an| one)?( service| request| booking| job| pro)?|book( a)?( pro| service)?( for me)?|make a request)\W*$/i;

/** Which draft fields this message fills. Only validated values get through. */
export async function patchFromUnderstanding(d: Draft, u: Understanding, text: string, step: Step): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  const t = text.trim();
  const onlySchedule = !u.trade && (u.budgetKobo || u.when.date || u.when.window) && t.split(/\s+/).length <= 6;
  const describes = u.intent === 'book' || (step === 'need' && !onlySchedule && !['greeting', 'thanks', 'affirm', 'deny', 'out_of_scope', 'status', 'cancel', 'human'].includes(u.intent));
  if (!d.need && describes && !GENERIC_ASK.test(t) && t.length >= 3) patch.need = t.slice(0, 300);
  if (u.trade && (!d.category_id || step === 'trade') && (await trades()).some((x) => x.id === u.trade)) patch.category_id = u.trade;
  if (u.budgetKobo) patch.budget_kobo = String(u.budgetKobo);
  if (u.when.date) patch.scheduled_date = u.when.date;
  if (u.when.window) patch.time_window = u.when.window;
  const day = String(patch.scheduled_date ?? d.scheduled_date ?? '');
  if (patch.time_window && day === watToday() && watHour() >= WINDOW_END[patch.time_window as TimeWindow]) delete patch.time_window;
  return patch;
}

/** A short "here's what I got" line for the next prompt. */
export async function acknowledge(patch: Record<string, unknown>): Promise<string> {
  const bits: string[] = [];
  if (patch.category_id) bits.push(`${await tradeName(String(patch.category_id))}`);
  if (patch.budget_kobo) bits.push(`budget ${naira(String(patch.budget_kobo))}`);
  if (patch.scheduled_date) bits.push(prettyDay(String(patch.scheduled_date)));
  if (patch.time_window) bits.push(WINDOW_LABEL[patch.time_window as TimeWindow].toLowerCase());
  return bits.length ? `Got it: ${bits.join(', ')}.` : patch.need ? 'Got it.' : '';
}

export async function summary(d: Draft): Promise<string> {
  const lines = [
    `Job: ${(await tradeName(d.category_id)) ?? 'not set'}${d.need ? ` — "${d.need.slice(0, 120)}"` : ''}`,
    `Photos: ${d.photo_asset_ids.length || 'none'}`,
    `Budget: ${d.budget_kobo ? naira(d.budget_kobo) : 'not given'}`,
    `Where: ${d.address_text ?? (d.lat != null ? 'pinned on the map' : 'not set')}${d.landmark ? ` (landmark: ${d.landmark})` : ''}`,
    `When: ${d.scheduled_date ? prettyDay(d.scheduled_date) : 'not set'}${d.time_window ? `, ${WINDOW_LABEL[d.time_window].toLowerCase()}` : ''}`,
  ];
  return lines.join('\n');
}

/** Send the prompt for whatever is missing next. `lead` goes on top of the same message. */
export async function sendStep(waId: string, d: Draft, a: Asked, lead = ''): Promise<Step> {
  const step = nextStep(d, a);
  const L = a.lang ?? 'en';
  const pre = lead ? `${lead}\n\n` : '';
  switch (step) {
    case 'need':
      await wa.text(waId, pre + say(L, 'What needs fixing or cleaning?', 'Wetin you need help with?'));
      break;
    case 'trade':
      await wa.list(waId, pre + say(L, 'Which kind of job is it?', 'Which kind work be this?'), 'Choose a trade',
        (await trades()).map((c) => ({ id: `cat:${c.id}`, title: c.name, description: c.description ?? undefined })));
      break;
    case 'photo':
      await wa.buttons(waId, pre + say(L, 'Can you send a photo?', 'You fit send picture?'),
        [{ id: 'flow:skip_photo', title: say(L, 'Skip photo', 'No picture') }]);
      break;
    case 'budget':
      await wa.buttons(waId, pre + say(L, 'Have a budget? Type it, like 15k, or skip.', 'You get budget? Type am, like 15k, or skip.'),
        [{ id: 'flow:skip_budget', title: say(L, 'No budget', 'No budget') }]);
      break;
    case 'location':
      await wa.ctaUrl(waId, pre + say(L, 'Where is the job? Share your location, type the address, or pin it below.', 'Where the work dey? Share location, type address, or pin am below.'),
        'Set location', locationLink(waId, d.id));
      break;
    case 'day': {
      const late = watHour() >= 17;
      const today = watToday();
      const options = late
        ? [{ id: `flow:day:${addDays(today, 1)}`, title: 'Tomorrow' }, { id: `flow:day:${addDays(today, 2)}`, title: 'Next tomorrow' }]
        : [{ id: `flow:day:${today}`, title: 'Today' }, { id: `flow:day:${addDays(today, 1)}`, title: 'Tomorrow' }];
      await wa.buttons(waId, pre + say(L, 'When should the vendor come?', 'When you want make the vendor come?'), [...options, { id: 'flow:day:pick', title: 'Another day' }]);
      break;
    }
    case 'window': {
      const isToday = d.scheduled_date === watToday();
      const open = (['morning', 'afternoon', 'evening'] as TimeWindow[]).filter((w) => !isToday || watHour() < WINDOW_END[w]);
      if (!open.length) {
        await patchDraft(d.id, { scheduled_date: addDays(watToday(), 1) });
        return sendStep(waId, { ...d, scheduled_date: addDays(watToday(), 1) }, a, `${pre}It's too late for a visit today, so I moved it to tomorrow.`);
      }
      await wa.buttons(waId, pre + say(L, 'What time suits you?', 'Which time good for you?'), open.map((w) => ({ id: `flow:win:${w}`, title: WINDOW_LABEL[w] })));
      break;
    }
    case 'confirm':
      await wa.buttons(waId, `${pre}Here's your request:\n${await summary(d)}\n\nShall I find vendors?`, [
        { id: 'flow:confirm', title: 'Find vendors' }, { id: 'flow:change', title: 'Change something' },
      ]);
      break;
  }
  return step;
}

const CHANGE_FIELDS: Record<string, { label: string; clear: Record<string, unknown>; asked?: Partial<Asked> }> = {
  need: { label: 'What needs doing', clear: { need: null } },
  trade: { label: 'The trade', clear: { category_id: null, service_id: null } },
  photo: { label: 'Photos', clear: { photo_asset_ids: '[]' }, asked: { photo: false } },
  budget: { label: 'Budget', clear: { budget_kobo: null }, asked: { budget: false } },
  location: { label: 'Location', clear: { lat: null, lng: null, address_text: null, landmark: null } },
  day: { label: 'Day', clear: { scheduled_date: null } },
  window: { label: 'Time', clear: { time_window: null } },
};

/**
 * Taps on flow buttons and list rows. Returns the updated draft and flags, or
 * `submitted` once the request went out.
 */
export async function handleFlowTap(id: string, ctx: { waId: string; userId: string; d: Draft; a: Asked }): Promise<{ d: Draft; a: Asked; submitted?: boolean; sent?: boolean }> {
  const { waId, userId } = ctx;
  let d = { ...ctx.d };
  const a = { ...ctx.a };
  const set = async (patch: Record<string, unknown>) => { await patchDraft(d.id, patch); d = { ...d, ...patch } as Draft; };

  if (id === 'flow:skip_photo') a.photo = true;
  else if (id === 'flow:skip_budget') a.budget = true;
  else if (id.startsWith('cat:')) {
    const cat = id.slice(4);
    if ((await trades()).some((t) => t.id === cat)) await set({ category_id: cat });
  } else if (id === 'flow:day:pick') {
    a.dayPick = true;
    await wa.text(waId, 'Type the day, for example "Saturday" or "5 Nov".');
    return { d, a, sent: true };
  } else if (id.startsWith('flow:day:')) {
    const day = id.slice(9);
    const today = watToday();
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= today && day <= addDays(today, 60)) await set({ scheduled_date: day });
  } else if (id.startsWith('flow:win:')) {
    const w = id.slice(9) as TimeWindow;
    if (WINDOW_HOURS[w]) await set({ time_window: w });
  } else if (id === 'flow:confirm') {
    const out = await submitDraft(waId, userId, d);
    if (out.needsVerification) return { d, a, sent: true }; // request kept; goes out after the ID check
    return { d, a: {}, submitted: true, sent: true };
  } else if (id === 'flow:change') {
    await wa.list(waId, 'What would you like to change?', 'Choose', Object.entries(CHANGE_FIELDS).map(([k, v]) => ({ id: `flow:change:${k}`, title: v.label })));
    return { d, a, sent: true };
  } else if (id.startsWith('flow:change:')) {
    const f = CHANGE_FIELDS[id.slice(12)];
    if (f) { await set(f.clear); if (id.endsWith(':photo')) d.photo_asset_ids = []; Object.assign(a, f.asked ?? {}); }
  }
  return { d, a };
}
