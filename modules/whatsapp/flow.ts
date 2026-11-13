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
import { onEmit } from '../../packages/observability/emit.js';
import { toKeywords } from '../catalog/catalog.service.js';
import { matchKeywords } from '../catalog/category-match.js';

export type Step = 'need' | 'trade' | 'photo' | 'budget' | 'location' | 'day' | 'window' | 'confirm';
/** Per-conversation flags kept in messaging.whatsapp_session.data. */
export interface Asked { photo?: boolean; budget?: boolean; dayPick?: boolean; lang?: 'en' | 'pcm'; cancelDraftId?: string; pendingText?: string; onboard?: 'name' | 'name_text' | 'email' | 'email_taken'; takenEmail?: string; recover?: 'ask' | 'code'; recoverId?: string }

const naira = (k: bigint | number | string) => `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
const say = (lang: Asked['lang'], en: string, pcm?: string) => (lang === 'pcm' && pcm ? pcm : en);
const watHour = () => new Date(Date.now() + 3600_000).getUTCHours();
const watToday = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const prettyDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const WINDOW_LABEL: Record<TimeWindow, string> = { morning: 'Morning 8–12', afternoon: 'Afternoon 12–4', evening: 'Evening 4–7' };
const WINDOW_END: Record<TimeWindow, number> = { morning: 11, afternoon: 15, evening: 18 };

export interface Trade {
  id: string; name: string; shortName: string; description: string | null;
  groupId: string; groupName: string; keywords: string[];
}
export interface TradeGroup { id: string; name: string; shortName: string; count: number }

// Every active service category (products are not booked over chat), in
// group order. Cached briefly; any category.* event (provider-made category,
// merge, reject) clears it.
let tradeCache: { at: number; rows: Trade[]; groups: TradeGroup[] } | null = null;
onEmit((event) => { if (event.startsWith('category.')) tradeCache = null; });
export function resetTradeCache(): void { tradeCache = null; }

async function loadTrades() {
  if (tradeCache && Date.now() - tradeCache.at < 300_000) return tradeCache;
  const [rows, groupRows] = await Promise.all([
    q<Record<string, unknown>>(`SELECT id, name, short_name, description, group_id, keywords, kind, sort_order FROM catalog.category WHERE active`),
    q<Record<string, unknown>>(`SELECT id, name, short_name, sort_order FROM catalog.category_group`).catch(() => []),
  ]);
  const gOrder = new Map(groupRows.map((g) => [String(g.id), { name: String(g.name), shortName: String(g.short_name ?? g.name), order: Number(g.sort_order ?? 0) }]));
  const other = { name: 'Other Services', shortName: 'Other Services', order: 99 };
  const list = rows
    .filter((r) => String(r.kind ?? 'service') !== 'product')
    .map((r) => {
      const gid = r.group_id && gOrder.has(String(r.group_id)) ? String(r.group_id) : 'other';
      const g = gOrder.get(gid) ?? other;
      return {
        t: {
          id: String(r.id), name: String(r.name), shortName: String(r.short_name ?? r.name).slice(0, 24),
          description: r.description ? String(r.description) : null, groupId: gid, groupName: g.shortName, keywords: toKeywords(r.keywords),
        } as Trade,
        sort: g.order * 100_000 + Number(r.sort_order ?? 0),
      };
    })
    .sort((a, b) => a.sort - b.sort || a.t.id.localeCompare(b.t.id))
    .map((x) => x.t);
  const groups: TradeGroup[] = [];
  for (const t of list) {
    const g = groups.find((x) => x.id === t.groupId);
    if (g) g.count++;
    else groups.push({ id: t.groupId, name: (gOrder.get(t.groupId) ?? other).name, shortName: t.groupName, count: 1 });
  }
  tradeCache = { at: Date.now(), rows: list, groups };
  return tradeCache;
}

export async function trades(): Promise<Trade[]> { return (await loadTrades()).rows; }
export async function tradeGroups(): Promise<TradeGroup[]> { return (await loadTrades()).groups; }

/** Chat label for a trade: the short name ("AC Services"), not the long catalogue title. */
export async function tradeName(id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await trades()).find((t) => t.id === id)?.shortName ?? id;
}

type Row = { id: string; title: string; description?: string };
const PAGE = 9; // 9 trades + a "More…" row keeps a list inside WhatsApp's 10 rows

/** First list: one row per group (≤10). */
export async function tradeGroupRows(): Promise<Row[]> {
  return (await tradeGroups()).slice(0, 10).map((g) => ({ id: `flow:grp:${g.id}`, title: g.shortName, description: g.name }));
}

/** Second list: the trades of one group, page by page; >10 trades get a "More…" row. */
export async function tradeCategoryPage(groupId: string, page = 0): Promise<{ rows: Row[]; hasMore: boolean }> {
  const inGroup = (await trades()).filter((t) => t.groupId === groupId);
  const start = Math.max(0, page) * PAGE;
  const rest = inGroup.slice(start);
  const shown = rest.length <= 10 ? rest : rest.slice(0, PAGE);
  const rows: Row[] = shown.map((t) => ({ id: `cat:${t.id}`, title: t.shortName, description: t.name }));
  const hasMore = rest.length > shown.length;
  if (hasMore) rows.push({ id: `flow:grp:${groupId}:${page + 1}`, title: 'More…', description: `${rest.length - shown.length} more in ${inGroup[0]?.groupName ?? 'this group'}` });
  return { rows, hasMore };
}

/**
 * Which trade free text is about. The NLU lexicon knows the 8 core trades; the
 * catalogue keywords know all of them. Keywords decide when the lexicon found
 * nothing (or only the model guessed), refine the lexicon's trade within the
 * same group ("borehole" -> Borehole, not Plumbing), and win across groups
 * when none of the lexicon trade's own keywords are in the text ("soakaway"
 * -> Septic & Soakaway) or on a stronger multi-word match.
 */
export async function resolveTrade(text: string, u: Pick<Understanding, 'trade' | 'tradeSource'>): Promise<string | null> {
  const all = (await trades()).map((t) => ({ id: t.id, name: t.name, groupId: t.groupId, keywords: t.keywords }));
  const hit = matchKeywords(text, all);
  if (!u.trade) return hit?.id ?? null;
  if (!hit) return u.trade;
  if (u.tradeSource !== 'lexicon') return hit.id;
  const base = all.find((t) => t.id === u.trade);
  if (!base || base.groupId === hit.groupId) return hit.id;
  const own = matchKeywords(text, [base])?.score ?? 0;
  if (own === 0 || (hit.strong && hit.score > own)) return hit.id;
  return u.trade;
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
  if (!d.category_id || step === 'trade') {
    const trade = await resolveTrade(t, u);
    if (trade && (await trades()).some((x) => x.id === trade)) patch.category_id = trade;
  }
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
      // Groups first (≤10 rows); the tap on a group sends its trades.
      await wa.list(waId, pre + say(L, 'Which kind of job is it? Pick the closest group.', 'Which kind work be this? Pick the group wey near am.'), 'Choose a group',
        await tradeGroupRows());
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
  } else if (id === 'flow:groups') {
    await wa.list(waId, say(a.lang, 'Which kind of job is it? Pick the closest group.', 'Which kind work be this? Pick the group wey near am.'), 'Choose a group', await tradeGroupRows());
    return { d, a, sent: true };
  } else if (id.startsWith('flow:grp:')) {
    const [groupId, pageStr] = id.slice(9).split(':');
    const group = (await tradeGroups()).find((g) => g.id === groupId);
    if (group) {
      const page = Math.max(0, Number(pageStr ?? 0) || 0);
      const { rows } = await tradeCategoryPage(group.id, page);
      if (rows.length) {
        await wa.list(waId, say(a.lang, `${group.shortName}: which one is it?`, `${group.shortName}: which one be am?`), page ? 'More trades' : 'Choose a trade', rows);
        return { d, a, sent: true };
      }
    }
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
