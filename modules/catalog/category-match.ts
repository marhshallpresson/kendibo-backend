// Text matching against the live catalogue: near-duplicate trade names (a
// provider proposing "CCTV installation" is pointed at the existing CCTV
// category) and keyword detection for free text ("my borehole pump spoil").
// Pure functions: callers pass the categories they loaded.

export interface MatchableCategory { id: string; name: string; shortName?: string; groupId?: string; keywords: string[] }

// Words that say nothing about which trade it is.
const STOP = new Set([
  'and', 'the', 'of', 'for', 'a', 'an', 'in', 'on', 'to', 'with', 'my', 'our', 'your', 'me', 'we', 'i',
  'service', 'services', 'repair', 'repairs', 'installation', 'install', 'installer', 'fitting', 'fix', 'fixing',
  'maintenance', 'support', 'home', 'house', 'general', 'expert', 'specialist', 'work', 'works', 'job', 'jobs',
]);

/** Lowercase, '&' as 'and', punctuation to spaces, collapsed. */
export function normaliseName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const stem = (t: string) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

export function tokens(s: string): string[] {
  return Array.from(new Set(normaliseName(s).split(' ').filter((t) => t && !STOP.has(t)).map(stem)));
}

export interface NearDuplicate { id: string; name: string; score: number }

/**
 * The existing category a proposed trade name most likely duplicates, or null.
 * A phrase (name, short name, id or keyword) counts when it explains at least
 * half of the proposal's words and the proposal holds most of the phrase.
 */
export function findNearDuplicate(proposed: string, cats: MatchableCategory[]): NearDuplicate | null {
  const p = tokens(proposed);
  const pNorm = normaliseName(proposed);
  if (!p.length) return null;
  let best: NearDuplicate | null = null;
  for (const c of cats) {
    const phrases = [c.name, c.shortName ?? '', c.id.replace(/[-_]+/g, ' '), ...c.keywords].filter(Boolean);
    for (const ph of phrases) {
      if (normaliseName(ph) === pNorm) return { id: c.id, name: c.name, score: 2 };
      const k = tokens(ph);
      if (!k.length) continue;
      const inter = k.filter((t) => p.includes(t)).length;
      if (!inter) continue;
      const covers = inter / p.length; // how much of the proposal this phrase explains
      const held = inter / k.length; // how much of the phrase is in the proposal
      if (covers >= 0.5 && held >= 0.6) {
        const score = covers + held;
        if (!best || score > best.score) best = { id: c.id, name: c.name, score };
      }
    }
  }
  return best;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const reCache = new Map<string, RegExp>();
function phraseRe(kw: string): RegExp {
  let re = reCache.get(kw);
  if (!re) {
    // Whole words only, with an optional plural; spaces/hyphens interchangeable.
    const body = kw.trim().split(/[\s-]+/).map(escape).join('[\\s-]+');
    re = new RegExp(`(^|[^a-z0-9])${body}(s|es)?($|[^a-z0-9])`, 'i');
    reCache.set(kw, re);
  }
  return re;
}

export interface KeywordHit { id: string; groupId?: string; score: number; strong: boolean }

/**
 * Best category for free text by its keywords. Longer phrases score more, so
 * "pop light" beats "pop" and "roof leak" beats "leak". `strong` means a
 * multi-word phrase or two separate keywords matched.
 */
export function matchKeywords(text: string, cats: MatchableCategory[]): KeywordHit | null {
  const t = ` ${text.toLowerCase()} `;
  let best: (KeywordHit & { order: number }) | null = null;
  cats.forEach((c, order) => {
    let score = 0; let hits = 0; let multi = false;
    for (const kw of c.keywords) {
      if (!kw || !phraseRe(kw).test(t)) continue;
      const words = kw.trim().split(/[\s-]+/).length;
      score += words; hits++;
      if (words > 1) multi = true;
    }
    if (!hits) return;
    if (!best || score > best.score || (score === best.score && order < best.order)) {
      best = { id: c.id, groupId: c.groupId, score, strong: multi || hits > 1, order };
    }
  });
  if (!best) return null;
  const { order: _o, ...hit } = best as KeywordHit & { order: number };
  return hit;
}
