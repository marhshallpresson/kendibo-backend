// Deterministic extractors for the booking details people type in WhatsApp.
// Rules beat a model here: amounts, days and times have a closed grammar, a
// wrong guess costs money or a missed visit, and every rule is unit-tested.
// Explicit calendar dates ("5th November", "05/11") go to chrono-node (MIT),
// used for that one step only; Nigerian phrasing ("next tomorrow", "by 4",
// "15k") is handled here first.
import * as chrono from 'chrono-node';
import { TRADE_LEXICON, type Trade } from './seed.js';

export type TimeWindow = 'morning' | 'afternoon' | 'evening';
export const WINDOW_HOURS: Record<TimeWindow, string> = { morning: '08:00-12:00', afternoon: '12:00-16:00', evening: '16:00-19:00' };

const MIN_NAIRA = 500;
const MAX_NAIRA = 50_000_000;

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "twenty five thousand" → "25000" (runs of number words become digits). */
export function wordsToDigits(text: string): string {
  const words = text.split(/(\s+|-)/);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    let total = 0; let current = 0; let any = false;
    for (const w of run) {
      if (w in UNITS) { current += UNITS[w]; any = true; }
      else if (w === 'hundred') { current = (current || 1) * 100; any = true; }
      else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; any = true; }
      else if (w === 'million') { total += (current || 1) * 1_000_000; current = 0; any = true; }
    }
    out.push(any ? `${total + current} ` : `${run.join(' ')} `);
    run = [];
  };
  for (const tok of words) {
    const w = tok.toLowerCase();
    if (/^\s+$|^-$/.test(tok)) { if (!run.length) out.push(tok); continue; }
    if (w in UNITS || w === 'hundred' || w === 'thousand' || w === 'million' || (w === 'and' && run.length)) { run.push(w); continue; }
    flush();
    out.push(tok, ' ');
  }
  flush();
  return out.join('').replace(/\s+/g, ' ').trim();
}

const MULT: Record<string, number> = { k: 1000, thousand: 1000, grand: 1000, m: 1_000_000, mil: 1_000_000, million: 1_000_000 };
const toNum = (s: string) => Number(s.replace(/,/g, ''));

/**
 * Budget in kobo, or null. Bare numbers only count as money with a money
 * word nearby ("budget 20000", "I fit pay 15000") or when we just asked for
 * the budget, and never when they look like a phone number, time or date.
 * A range ("10k-15k") means the upper end: that is the most they will pay.
 */
export function extractBudgetKobo(text: string, opts: { expectingBudget?: boolean } = {}): bigint | null {
  const t = ` ${wordsToDigits(text.toLowerCase())} `
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/g, ' ') // times
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' ') // dates
    .replace(/(\+?234|\b0)[789][01]\d{8}\b/g, ' ') // phone numbers
    .replace(/\b\d+\s*(bed ?rooms?|rooms?|units?|km|kilometres?|floors?|storey|plots?|bedroom)\b/g, ' ');
  const found: number[] = [];
  for (const m of t.matchAll(/(?:₦|\bngn\s?|\bn)(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|grand|m|mil|million)?\b/g)) found.push(toNum(m[1]) * (m[2] ? MULT[m[2]] : 1));
  for (const m of t.matchAll(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|grand|mil|million)\b/g)) found.push(toNum(m[1]) * MULT[m[2]]);
  for (const m of t.matchAll(/\b(\d[\d,]*)\s*(naira|ngn)\b/g)) found.push(toNum(m[1]));
  if (!found.length && (opts.expectingBudget || /\b(budget|pay|price|cost|charge|amount|spend|afford|around|about|max(imum)?|not more than|below|under|less than)\b/.test(t))) {
    for (const m of t.matchAll(/\b(\d[\d,]{2,})\b/g)) {
      const n = toNum(m[1]);
      if (String(Math.trunc(n)).length <= 8) found.push(n);
    }
  }
  const valid = found.filter((n) => Number.isFinite(n) && n >= MIN_NAIRA && n <= MAX_NAIRA);
  if (!valid.length) return null;
  return BigInt(Math.round(Math.max(...valid))) * 100n;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|sday|nesday|rsday|urday)\b|\b(mon|tue|tues|wed|thu|thur|thurs|fri)\b/;
const watDate = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10); // Lagos is UTC+1, no DST
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const watHour = (d: Date) => new Date(d.getTime() + 3600_000).getUTCHours();

function windowForHour(h: number): TimeWindow | undefined {
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 16) return 'afternoon';
  if (h >= 16 && h <= 21) return 'evening';
  return undefined;
}

/**
 * Day (YYYY-MM-DD, Lagos time) and/or time window from free text.
 * Dates outside today … +60 days are ignored rather than guessed.
 */
export function extractWhen(text: string, now: Date = new Date()): { date?: string; window?: TimeWindow; urgent?: boolean } {
  const t = ` ${text.toLowerCase().replace(/[’']/g, '')} `;
  const today = watDate(now);
  const out: { date?: string; window?: TimeWindow; urgent?: boolean } = {};

  if (/\b(right now|come now|now now|asap|urgent\w*|immediately|right away|sharp ?sharp|emergency)\b/.test(t)) {
    out.urgent = true;
    out.date = today;
    const h = watHour(now);
    out.window = h < 11 ? 'morning' : h < 15 ? 'afternoon' : h < 18 ? 'evening' : undefined;
    if (!out.window) out.date = addDays(today, 1);
  }
  if (/\b(next ?tomm?orr?ow|next tomoro|next tmr\w*|day after tomm?orr?ow|nxt tmr\w*)\b/.test(t)) out.date = addDays(today, 2);
  else if (/\b(tomm?orr?ow|tomoro|tomorow|tmrw?|2moro\w*|2morrow|tomorrw)\b/.test(t)) out.date = addDays(today, 1);
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) out.date = today;
  else if (/\b(this |next )?weekend\b/.test(t)) {
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    out.date = addDays(today, (6 - dow + 7) % 7);
  } else if (/\bnext week\b/.test(t)) {
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    out.date = addDays(today, ((1 - dow + 7) % 7) || 7);
  } else {
    const wd = t.match(WEEKDAY_RE);
    if (wd) {
      const stem = (wd[1] ?? wd[3] ?? '').slice(0, 3);
      const target = WEEKDAYS.findIndex((d) => d.startsWith(stem));
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
      // "Saturday" / "next Saturday": the coming one (today if it is that day).
      if (target >= 0) out.date = addDays(today, (target - dow + 7) % 7);
    } else {
      const parsed = chrono.en.GB.parse(text, now, { forwardDate: true }).find((r) => r.start.isCertain('day'));
      if (parsed) out.date = watDate(parsed.start.date());
    }
  }

  if (/\b(tonight|evening|night|after work|after 5)\b/.test(t)) out.window = 'evening';
  else if (/\b(afternoon|noon|midday|after lunch)\b/.test(t)) out.window = 'afternoon';
  else if (/\b(morning|early|before noon|before 12)\b/.test(t)) out.window = 'morning';
  else {
    const clock = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    const loose = t.match(/\b(?:by|at|from|around|before|after)\s+(\d{1,2})(?::\d{2})?\b(?!\s*(am|pm|k|naira|days?))/);
    let h: number | undefined;
    if (clock) h = (Number(clock[1]) % 12) + (clock[3] === 'pm' ? 12 : 0);
    else if (loose) { const n = Number(loose[1]); h = n >= 7 && n <= 11 ? n : n >= 1 && n <= 6 ? n + 12 : n; }
    if (h !== undefined) out.window = windowForHour(h) ?? out.window;
  }

  if (out.date && (out.date < today || out.date > addDays(today, 60))) delete out.date;
  return out;
}

/** Trade from the lexicon: highest total weight wins, ties go to the earlier line. */
export function tradeFromLexicon(text: string): { trade: Trade; score: number } | null {
  const t = ` ${text.toLowerCase()} `;
  const scores = new Map<Trade, { score: number; first: number }>();
  TRADE_LEXICON.forEach(([trade, re, weight], i) => {
    if (!re.test(t)) return;
    const cur = scores.get(trade) ?? { score: 0, first: i };
    cur.score += weight;
    scores.set(trade, cur);
  });
  let best: { trade: Trade; score: number; first: number } | null = null;
  for (const [trade, s] of scores) {
    if (!best || s.score > best.score || (s.score === best.score && s.first < best.first)) best = { trade, ...s };
  }
  return best ? { trade: best.trade, score: best.score } : null;
}

const PIDGIN = /\b(dey|wetin|abeg|una|gree|comot|wahala|sabi|naim|wey|don spoil|no be|e don|make i|oya|pikin|biko|abi|shey|sef|wan)\b/;
export const detectLanguage = (text: string): 'en' | 'pcm' => (PIDGIN.test(` ${text.toLowerCase()} `) ? 'pcm' : 'en');

/** What we keep for analytics and retraining: no contact details, codes or ID numbers. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/(\+?234|\b0)[789][01]\d{8}\b/g, '<phone>')
    .replace(/\b\d{7,}\b/g, '<number>')
    .replace(/\b(otp|code|pin|password|passcode|cvv)\b(\s*(?:is|:|=)?\s*)(\S{3,40})/gi, '$1$2<secret>')
    .slice(0, 500);
}
