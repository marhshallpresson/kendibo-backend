// Offline check of the WhatsApp intent model on held-out seed lines, trained
// exactly as production trains it (augmented + marked). "router" adds the exact
// short-reply lists the router applies first. Run: npx tsx scripts/eval-nlu.ts
import { SEED, SHORT_REPLIES } from '../modules/whatsapp/nlu/seed.js';
import { train, split, evaluate, chooseThreshold, predict, normalize } from '../modules/whatsapp/nlu/classifier.js';
import { markers, prepare } from '../modules/whatsapp/nlu/features.js';

const OPTS = { epochs: 40, lr: 2, l2: 1e-4 };
const examples = SEED.map(([text, label]) => ({ text, label }));
const shortReply = (t: string) => {
  const s = normalize(t).replace(/[^a-z' ]/g, '').trim();
  return Object.entries(SHORT_REPLIES).find(([, list]) => list.includes(s))?.[0];
};
const SPLITS = [11, 23, 37, 41, 53];
const sum = { model: 0, router: 0, f1: 0, cov: 0, prec: 0 };
for (const seed of SPLITS) {
  const { train: tr, test } = split(examples, 0.2, seed);
  const m = train(prepare(tr), OPTS);
  const marked = test.map((e) => ({ ...e, text: markers(e.text) }));
  const th = chooseThreshold(m, marked);
  const e = evaluate(m, marked, th);
  const router = test.filter((x, i) => (shortReply(x.text) ?? predict(m, marked[i].text).label) === x.label).length / test.length;
  Object.assign(sum, { model: sum.model + e.accuracy, router: sum.router + router, f1: sum.f1 + e.macroF1, cov: sum.cov + e.coverage, prec: sum.prec + e.precisionAtThreshold });
  console.log(`split ${seed}: n=${e.n} model acc=${e.accuracy.toFixed(3)} macroF1=${e.macroF1.toFixed(3)} router acc=${router.toFixed(3)} threshold=${th} coverage=${e.coverage.toFixed(2)} precision@t=${e.precisionAtThreshold.toFixed(3)}`);
}
const n = SPLITS.length;
console.log(`mean: model acc=${(sum.model / n).toFixed(3)} macroF1=${(sum.f1 / n).toFixed(3)} router acc=${(sum.router / n).toFixed(3)} coverage=${(sum.cov / n).toFixed(2)} precision@t=${(sum.prec / n).toFixed(3)}`);
console.log(`examples=${examples.length} intents=${new Set(examples.map((e) => e.label)).size}`);
