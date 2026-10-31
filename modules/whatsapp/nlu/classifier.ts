// Text classifier for the WhatsApp assistant: hashed word + character n-grams
// → multinomial logistic regression (softmax), trained in-process with seeded
// SGD, so the same examples always give the same model (testable, no files).
//
// Why this and not embeddings or an LLM: we have hundreds of labelled lines,
// not millions, and the text is Nigerian English, Pidgin and typos
// ("abeg", "d ac no dey cool", "tomoro"). Character n-grams carry that signal
// well on small data, run in microseconds and need no model download.
// Training on ~500 lines takes well under a second.

export const DIM = 1 << 14;

export interface Example { text: string; label: string }
export interface Model { labels: string[]; dim: number; W: Float32Array[]; b: Float32Array }
export interface Prediction { label: string; confidence: number; ranked: { label: string; p: number }[] }

/** Lower-case, strip tone marks, squash repeats, map numbers to placeholders. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // Yoruba/Igbo tone marks
    .replace(/(.)\1{2,}/g, '$1$1') // "pleeeease" → "pleease"
    .replace(/₦/g, ' naira ')
    .replace(/\d+/g, (d) => (d.length >= 7 ? ' <long> ' : ' <num> '))
    .replace(/[^a-z0-9<>'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Sparse features: hashed index → value (sublinear tf, L2-normalised). */
export function featurize(text: string, dim = DIM): [number, number][] {
  const words = normalize(text).split(' ').filter(Boolean);
  const counts = new Map<number, number>();
  const add = (f: string) => { const i = fnv1a(f) % dim; counts.set(i, (counts.get(i) ?? 0) + 1); };
  words.forEach((w, i) => {
    add(`w:${w}`);
    if (i > 0) add(`b:${words[i - 1]} ${w}`);
    const padded = `<${w}>`;
    for (let n = 3; n <= 5; n++) for (let j = 0; j + n <= padded.length; j++) add(`c:${padded.slice(j, j + n)}`);
  });
  if (!words.length) add('w:<empty>');
  let norm = 0;
  const out: [number, number][] = [];
  for (const [i, c] of counts) { const v = 1 + Math.log(c); out.push([i, v]); norm += v * v; }
  norm = Math.sqrt(norm) || 1;
  for (const f of out) f[1] /= norm;
  return out;
}

/** mulberry32: tiny seeded PRNG so training and splits are reproducible. */
function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function softmaxInto(m: Model, x: [number, number][], out: Float64Array) {
  let max = -Infinity;
  for (let k = 0; k < m.labels.length; k++) {
    let z = m.b[k];
    const wk = m.W[k];
    for (const [i, v] of x) z += wk[i] * v;
    out[k] = z;
    if (z > max) max = z;
  }
  let sum = 0;
  for (let k = 0; k < m.labels.length; k++) { out[k] = Math.exp(out[k] - max); sum += out[k]; }
  for (let k = 0; k < m.labels.length; k++) out[k] /= sum;
}

export function train(examples: Example[], opts: { epochs?: number; lr?: number; l2?: number; seed?: number; dim?: number } = {}): Model {
  const dim = opts.dim ?? DIM;
  const epochs = opts.epochs ?? 40;
  const l2 = opts.l2 ?? 1e-5;
  const lr0 = opts.lr ?? 0.5;
  const labels = [...new Set(examples.map((e) => e.label))].sort();
  const K = labels.length;
  const m: Model = { labels, dim, W: labels.map(() => new Float32Array(dim)), b: new Float32Array(K) };
  const data = examples.map((e) => ({ x: featurize(e.text, dim), y: labels.indexOf(e.label) }));
  // Balance classes so a large class (bookings) doesn't drown small ones (opt-out).
  const count = new Array<number>(K).fill(0);
  for (const d of data) count[d.y]++;
  const classWeight = count.map((c) => data.length / (K * Math.max(1, c)));
  const rand = rng(opts.seed ?? 7);
  const order = data.map((_, i) => i);
  const p = new Float64Array(K);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const lr = lr0 / (1 + ep * 0.1);
    for (const idx of order) {
      const { x, y } = data[idx];
      softmaxInto(m, x, p);
      for (let k = 0; k < K; k++) {
        const g = (p[k] - (k === y ? 1 : 0)) * classWeight[y];
        if (Math.abs(g) < 1e-7) continue;
        const wk = m.W[k];
        for (const [i, v] of x) wk[i] -= lr * (g * v + l2 * wk[i]);
        m.b[k] -= lr * g;
      }
    }
  }
  return m;
}

export function predict(m: Model, text: string): Prediction {
  const p = new Float64Array(m.labels.length);
  softmaxInto(m, featurize(text, m.dim), p);
  const ranked = m.labels.map((label, k) => ({ label, p: p[k] })).sort((a, b) => b.p - a.p);
  return { label: ranked[0].label, confidence: ranked[0].p, ranked: ranked.slice(0, 3) };
}

/** Stratified split, reproducible. */
export function split(examples: Example[], testShare = 0.2, seed = 11): { train: Example[]; test: Example[] } {
  const rand = rng(seed);
  const byLabel = new Map<string, Example[]>();
  for (const e of examples) byLabel.set(e.label, [...(byLabel.get(e.label) ?? []), e]);
  const trainSet: Example[] = []; const testSet: Example[] = [];
  for (const group of byLabel.values()) {
    const g = [...group];
    for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; }
    const n = Math.max(1, Math.round(g.length * testShare));
    testSet.push(...g.slice(0, n)); trainSet.push(...g.slice(n));
  }
  return { train: trainSet, test: testSet };
}

export interface Evaluation {
  n: number; accuracy: number; macroF1: number;
  perLabel: Record<string, { precision: number; recall: number; f1: number; n: number }>;
  /** Share of predictions at or above `threshold` and how often those are right. */
  threshold: number; coverage: number; precisionAtThreshold: number;
  mistakes: { text: string; want: string; got: string; p: number }[];
}

export function evaluate(m: Model, test: Example[], threshold = 0): Evaluation {
  const tp: Record<string, number> = {}; const fp: Record<string, number> = {}; const fn: Record<string, number> = {}; const n: Record<string, number> = {};
  let right = 0; let covered = 0; let coveredRight = 0;
  const mistakes: Evaluation['mistakes'] = [];
  for (const e of test) {
    const r = predict(m, e.text);
    n[e.label] = (n[e.label] ?? 0) + 1;
    if (r.label === e.label) { right++; tp[e.label] = (tp[e.label] ?? 0) + 1; }
    else { fp[r.label] = (fp[r.label] ?? 0) + 1; fn[e.label] = (fn[e.label] ?? 0) + 1; mistakes.push({ text: e.text, want: e.label, got: r.label, p: Number(r.confidence.toFixed(2)) }); }
    if (r.confidence >= threshold) { covered++; if (r.label === e.label) coveredRight++; }
  }
  const perLabel: Evaluation['perLabel'] = {};
  let f1Sum = 0;
  const labels = [...new Set(test.map((e) => e.label))];
  for (const l of labels) {
    const precision = (tp[l] ?? 0) / Math.max(1, (tp[l] ?? 0) + (fp[l] ?? 0));
    const recall = (tp[l] ?? 0) / Math.max(1, n[l] ?? 0);
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perLabel[l] = { precision, recall, f1, n: n[l] ?? 0 };
    f1Sum += f1;
  }
  return {
    n: test.length, accuracy: right / Math.max(1, test.length), macroF1: f1Sum / Math.max(1, labels.length),
    perLabel, threshold, coverage: covered / Math.max(1, test.length), precisionAtThreshold: coveredRight / Math.max(1, covered), mistakes,
  };
}

/**
 * Lowest confidence at which held-out predictions are right at least
 * `targetPrecision` of the time. Below it, the router asks or escalates
 * instead of acting on a guess.
 */
export function chooseThreshold(m: Model, held: Example[], targetPrecision = 0.9): number {
  const scored = held.map((e) => { const r = predict(m, e.text); return { p: r.confidence, ok: r.label === e.label }; });
  for (let t = 0.2; t <= 0.9 + 1e-9; t += 0.05) {
    const kept = scored.filter((s) => s.p >= t);
    if (kept.length && kept.filter((s) => s.ok).length / kept.length >= targetPrecision) return Number(t.toFixed(2));
  }
  return 0.9;
}
