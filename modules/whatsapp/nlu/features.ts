// Text preparation shared by training, prediction and the offline evaluation
// (scripts/eval-nlu.ts). Pure: no database, no clock.
//
// markers(): the deterministic extractors know things the n-grams can't learn
// from a few hundred lines ("this has an amount in it", "this names a trade"),
// so their findings are appended as tokens the model can weigh. On held-out
// seed lines this lifts end-to-end accuracy by about 3-4 points.
// augment(): each training line again in common WhatsApp spellings
// ("pls", "u", "d", "wan"), so a typo doesn't push a line into another intent.
import type { Example } from './classifier.js';
import { extractBudgetKobo, tradeFromLexicon } from './entities.js';

const WHEN = /\b(today|tonight|tomm?orr?ow|tomoro|tmrw?|2moro\w*|weekend|next week|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/i;
const QUESTION = /\?\s*$|^(how|what|when|where|which|who|why|is|are|do|does|can|will|una|wetin)\b/i;

export function markers(text: string): string {
  const m: string[] = [];
  if (tradeFromLexicon(text)) m.push('zztrade');
  if (extractBudgetKobo(text)) m.push('zzmoney');
  if (WHEN.test(text)) m.push('zzwhen');
  if (QUESTION.test(text.trim())) m.push('zzquestion');
  return m.length ? `${text} ${m.join(' ')}` : text;
}

const SPELLINGS: [RegExp, string][] = [
  [/\bplease\b/g, 'pls'], [/\byou\b/g, 'u'], [/\bthe\b/g, 'd'], [/\bis not\b/g, 'no dey'],
  [/\bmy\b/g, 'ma'], [/\bwant\b/g, 'wan'], [/\bwhat\b/g, 'wetin'], [/\bthank you\b/g, 'thanks'],
];

export function augment(examples: Example[]): Example[] {
  const out = [...examples];
  for (const e of examples) {
    let t = e.text.toLowerCase();
    let changed = false;
    for (const [re, r] of SPELLINGS) if (re.test(t)) { t = t.replace(re, r); changed = true; }
    if (changed) out.push({ text: t, label: e.label });
  }
  return out;
}

/** Training set as the model sees it: augmented, then marked. */
export const prepare = (examples: Example[]): Example[] => augment(examples).map((e) => ({ ...e, text: markers(e.text) }));
