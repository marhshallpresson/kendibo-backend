// Understanding layer for the WhatsApp assistant: what the customer wants
// (intent), whether it is in scope, which trade, budget, day, time window and
// language. It runs on every text before (and usually instead of) the LLM.
//
// The intent model trains in-process from the seed lines plus every line ops
// labelled in the admin console. A retrain only switches on if it scores at
// least as well on held-out data as the model it replaces. What gets stored
// for training is redacted (no phone numbers, emails, codes or ID numbers)
// and keyed by a hashed WhatsApp id.
import crypto from 'node:crypto';
import { q } from '../../../packages/database/db.js';
import { emit } from '../../../packages/observability/emit.js';
import { SEED, SHORT_REPLIES, type Intent, type Trade } from './seed.js';
import { train, predict, split, evaluate, chooseThreshold, normalize, type Example, type Model, type Evaluation } from './classifier.js';
import { extractBudgetKobo, extractWhen, tradeFromLexicon, detectLanguage, redact, type TimeWindow } from './entities.js';
import { markers, prepare } from './features.js';

export type { Intent, Trade, TimeWindow };
export const INTENTS: Intent[] = [...new Set(SEED.map((s) => s[1]))];
const MODEL_NAME = 'wa_intent';
const RETENTION_DAYS = 180;

export interface Understanding {
  intent: Intent;
  confidence: number;
  /** Confident enough to act on without asking or escalating. */
  sure: boolean;
  ranked: { label: string; p: number }[];
  trade: Trade | null;
  tradeSource: 'lexicon' | 'model' | null;
  budgetKobo: bigint | null;
  when: { date?: string; window?: TimeWindow; urgent?: boolean };
  language: 'en' | 'pcm';
  modelVersion: number;
}

interface Loaded { intent: Model; trade: Model; threshold: number; version: number; labelsUpTo: string | null; heldOut: Evaluation; examples: number }
let loaded: Promise<Loaded> | null = null;

export const seedExamples = (): Example[] => SEED.map(([text, label]) => ({ text, label }));
const tradeExamples = (): Example[] => SEED.filter((s) => s[2]).map(([text, , trade]) => ({ text, label: String(trade) }));
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

async function labelledExamples(upTo: string | null): Promise<Example[]> {
  if (!upTo) return [];
  const rows = await q<{ text_redacted: string; label: string }>(
    `SELECT text_redacted, label FROM ml.nlu_event WHERE label IS NOT NULL AND labelled_at <= $1`, [upTo],
  ).catch(() => []);
  return rows.filter((r) => INTENTS.includes(r.label as Intent)).map((r) => ({ text: String(r.text_redacted), label: String(r.label) }));
}

const TRAIN_OPTS = { epochs: 40, lr: 2, l2: 1e-4 };
const marked = (examples: Example[]) => examples.map((e) => ({ ...e, text: markers(e.text) }));

/** Threshold from a held-out split (augmenting the training side only), then the final model on everything. */
function build(examples: Example[]) {
  const { train: tr, test } = split(examples);
  const probe = train(prepare(tr), TRAIN_OPTS);
  const threshold = chooseThreshold(probe, marked(test));
  return { model: train(prepare(examples), TRAIN_OPTS), threshold, heldOut: evaluate(probe, marked(test), threshold) };
}

async function load(): Promise<Loaded> {
  const rows = await q<{ version: number; weights: unknown }>(
    `SELECT version, weights FROM ml.model WHERE name=$1 AND active ORDER BY version DESC LIMIT 1`, [MODEL_NAME],
  ).catch(() => []);
  const labelsUpTo = rows[0] ? parse<{ labelsUpTo?: string }>(rows[0].weights).labelsUpTo ?? null : null;
  const examples = [...seedExamples(), ...(await labelledExamples(labelsUpTo))];
  const b = build(examples);
  return {
    intent: b.model, trade: train(tradeExamples(), { epochs: 60 }), threshold: b.threshold,
    version: rows[0] ? Number(rows[0].version) : 0, labelsUpTo, heldOut: b.heldOut, examples: examples.length,
  };
}

export function nluReady(): Promise<Loaded> {
  loaded ??= load().catch((e) => { loaded = null; throw e; });
  return loaded;
}
export function resetNlu() { loaded = null; }

// Exact words people use to reach a person or restart, whatever the model says.
const KEYWORDS: [RegExp, Intent][] = [
  [/^(agent|human|person|a person|support|customer care|customer service|representative|talk to (a |an )?(person|human|agent))[.!]?$/i, 'human'],
  [/^(hi+|hello+|hey+|menu|start|restart|good (morning|afternoon|evening))[.!]?$/i, 'greeting'],
];

export async function understand(text: string, ctx: { expectingBudget?: boolean; now?: Date } = {}): Promise<Understanding> {
  const m = await nluReady();
  const clean = text.trim().slice(0, 1000);
  const p = predict(m.intent, markers(clean));
  let intent = p.label as Intent;
  let confidence = p.confidence;
  for (const [re, i] of KEYWORDS) if (re.test(clean)) { intent = i; confidence = 1; break; }
  const short = normalize(clean).replace(/[^a-z' ]/g, '').trim();
  for (const [i, phrases] of Object.entries(SHORT_REPLIES)) {
    if (phrases.includes(short)) { intent = i as Intent; confidence = 1; break; }
  }

  const lex = tradeFromLexicon(clean);
  let trade: Trade | null = lex?.trade ?? null;
  let tradeSource: Understanding['tradeSource'] = lex ? 'lexicon' : null;
  if (!trade && (intent === 'book' || intent === 'details')) {
    const t = predict(m.trade, clean);
    if (t.confidence >= 0.6) { trade = t.label as Trade; tradeSource = 'model'; }
  }
  // A trade word means it is about home services, whatever the intent model thought.
  if (intent === 'out_of_scope' && lex) { intent = 'book'; confidence = Math.max(confidence, m.threshold); }

  const budgetKobo = extractBudgetKobo(clean, { expectingBudget: ctx.expectingBudget });
  const when = extractWhen(clean, ctx.now);
  // "tomorrow 4pm", "20k": details, unless the model is very sure it is something else.
  if ((budgetKobo || when.date || when.window) && ['affirm', 'deny', 'greeting', 'thanks', 'out_of_scope'].includes(intent) && confidence < 0.9) {
    intent = 'details';
    confidence = Math.max(confidence, m.threshold);
  }
  const margin = p.ranked.length > 1 ? p.ranked[0].p - p.ranked[1].p : 1;
  return {
    intent, confidence, sure: confidence >= m.threshold || margin >= 0.35, ranked: p.ranked,
    trade, tradeSource, budgetKobo, when, language: detectLanguage(clean), modelVersion: m.version,
  };
}

const waHash = (waId: string) =>
  crypto.createHmac('sha256', process.env.WHATSAPP_LINK_SECRET || process.env.JWT_ACCESS_SECRET || 'kendibo-nlu').update(waId).digest('hex').slice(0, 24);

/** One row per customer text: what we understood and what the router did with it. */
export async function logTurn(waId: string, text: string, u: Understanding, route: string, step: string | null): Promise<void> {
  await q(
    `INSERT INTO ml.nlu_event (wa_hash, text_redacted, intent, confidence, route, step, model_version) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [waHash(waId), redact(text), u.intent, Number(u.confidence.toFixed(4)), route, step, u.modelVersion],
  ).catch(() => undefined);
}

/** LLM turns this customer and everyone had today (for the cost guard). */
export async function llmTurnsToday(waId: string): Promise<{ mine: number; all: number }> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [mine, all] = await Promise.all([
    q<{ n: string }>(`SELECT COUNT(*) AS n FROM ml.nlu_event WHERE wa_hash=$1 AND route='llm' AND created_at >= $2`, [waHash(waId), since]).catch(() => [{ n: '0' }]),
    q<{ n: string }>(`SELECT COUNT(*) AS n FROM ml.nlu_event WHERE route='llm' AND created_at >= $1`, [since]).catch(() => [{ n: '0' }]),
  ]);
  return { mine: Number(mine[0]?.n ?? 0), all: Number(all[0]?.n ?? 0) };
}

export async function labelEvent(id: string, label: string, by: string): Promise<boolean> {
  if (!INTENTS.includes(label as Intent)) throw new Error('UNKNOWN_INTENT');
  const rows = await q<{ id: string }>(
    `UPDATE ml.nlu_event SET label=$2, label_source='ops', labelled_by=$3, labelled_at=now() WHERE id=$1 RETURNING id`, [id, label, by],
  );
  return !!rows[0];
}

/**
 * Retrain with every labelled line and switch the new model on only if its
 * macro-F1 on a held-out split is at least the current model's. Unlabelled
 * lines older than the retention period are deleted on the way.
 */
export async function retrainNlu(): Promise<{ promoted: boolean; version: number | null; reason: string; macroF1: number; baselineF1: number; labelled: number }> {
  await q(`DELETE FROM ml.nlu_event WHERE label IS NULL AND created_at < $1`, [new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()]).catch(() => undefined);
  const upTo = new Date().toISOString();
  const current = await nluReady();
  const labelled = await labelledExamples(upTo);
  const before = await labelledExamples(current.labelsUpTo);
  if (labelled.length <= before.length) {
    return { promoted: false, version: null, reason: 'No new labelled lines since the current model.', macroF1: current.heldOut.macroF1, baselineF1: current.heldOut.macroF1, labelled: labelled.length };
  }
  const all = [...seedExamples(), ...labelled];
  const { train: tr, test } = split(all, 0.2, 13);
  const testKeys = new Set(test.map((e) => `${e.label}|${e.text}`));
  const candidate = evaluate(train(prepare(tr), TRAIN_OPTS), marked(test));
  const baseline = evaluate(train(prepare([...seedExamples(), ...before].filter((e) => !testKeys.has(`${e.label}|${e.text}`))), TRAIN_OPTS), marked(test));
  if (candidate.macroF1 + 0.005 < baseline.macroF1) {
    return { promoted: false, version: null, reason: 'The new labels made held-out results worse, so the current model stays. Check recent labels for mistakes.', macroF1: candidate.macroF1, baselineF1: baseline.macroF1, labelled: labelled.length };
  }
  const v = await q<{ v: number | null }>(`SELECT MAX(version) AS v FROM ml.model WHERE name=$1`, [MODEL_NAME]);
  const version = Number(v[0]?.v ?? 0) + 1;
  await q(`UPDATE ml.model SET active=FALSE WHERE name=$1`, [MODEL_NAME]);
  await q(
    `INSERT INTO ml.model (name, version, weights, metrics, trained_rows, active) VALUES ($1,$2,$3,$4,$5,TRUE)`,
    [MODEL_NAME, version, JSON.stringify({ labelsUpTo: upTo }), JSON.stringify({ macroF1: candidate.macroF1, accuracy: candidate.accuracy, baselineF1: baseline.macroF1 }), all.length],
  );
  resetNlu();
  emit('ml.nlu_model_promoted', { version, macroF1: candidate.macroF1 });
  return { promoted: true, version, reason: `Version ${version} is live.`, macroF1: candidate.macroF1, baselineF1: baseline.macroF1, labelled: labelled.length };
}

/** Admin view: model quality, what customers ask for, where the bot hands over. */
export async function nluStatus(days = 7) {
  const m = await nluReady();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [byIntent, byRoute, byStep, labelled, history] = await Promise.all([
    q<{ intent: string; n: string }>(`SELECT intent, COUNT(*) AS n FROM ml.nlu_event WHERE created_at >= $1 GROUP BY intent`, [since]).catch(() => []),
    q<{ route: string; n: string }>(`SELECT route, COUNT(*) AS n FROM ml.nlu_event WHERE created_at >= $1 GROUP BY route`, [since]).catch(() => []),
    q<{ step: string | null; n: string }>(`SELECT step, COUNT(*) AS n FROM ml.nlu_event WHERE created_at >= $1 AND step IS NOT NULL GROUP BY step`, [since]).catch(() => []),
    q<{ n: string }>(`SELECT COUNT(*) AS n FROM ml.nlu_event WHERE label IS NOT NULL`).catch(() => [{ n: '0' }]),
    q<{ version: number; active: boolean; trained_rows: number; metrics: unknown; created_at: string }>(
      `SELECT version, active, trained_rows, metrics, created_at FROM ml.model WHERE name=$1 ORDER BY version DESC LIMIT 10`, [MODEL_NAME],
    ).catch(() => []),
  ]);
  const count = (rows: { n: string }[]) => rows.reduce((s, r) => s + Number(r.n), 0);
  return {
    version: m.version, examples: m.examples, threshold: m.threshold,
    heldOut: { macroF1: m.heldOut.macroF1, accuracy: m.heldOut.accuracy, coverage: m.heldOut.coverage, precisionAtThreshold: m.heldOut.precisionAtThreshold, n: m.heldOut.n },
    days, turns: count(byRoute),
    byIntent: Object.fromEntries(byIntent.map((r) => [r.intent, Number(r.n)])),
    byRoute: Object.fromEntries(byRoute.map((r) => [r.route, Number(r.n)])),
    byStep: Object.fromEntries(byStep.map((r) => [String(r.step), Number(r.n)])),
    labelled: Number(labelled[0]?.n ?? 0),
    history: history.map((h) => ({ version: Number(h.version), active: Boolean(h.active), trainedRows: Number(h.trained_rows), metrics: parse<Record<string, number>>(h.metrics), at: h.created_at })),
    intents: INTENTS,
  };
}

/** Lines worth a human label: low confidence, or ones the bot could not handle itself. */
export async function reviewQueue(limit = 50) {
  const rows = await q<{ id: string; text_redacted: string; intent: string; confidence: number; route: string; step: string | null; created_at: string }>(
    `SELECT id, text_redacted, intent, confidence, route, step, created_at FROM ml.nlu_event
      WHERE label IS NULL AND (confidence < 0.6 OR route IN ('llm', 'clarify', 'refuse'))
      ORDER BY created_at DESC LIMIT $1`, [limit],
  ).catch(() => []);
  return rows.map((r) => ({ id: String(r.id), text: String(r.text_redacted), intent: r.intent, confidence: Number(r.confidence), route: r.route, step: r.step, at: r.created_at }));
}
