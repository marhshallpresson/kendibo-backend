// Synthetic, hand-authored stress cases. Keep these examples out of SEED.
// Compares the previous seed with the Nigerian home-services additions.
import { SEED } from '../modules/whatsapp/nlu/seed.js';
import { evaluate, train, type Example } from '../modules/whatsapp/nlu/classifier.js';
import { markers, prepare } from '../modules/whatsapp/nlu/features.js';

const holdout: Example[] = [
  { text: 'deep freezer don spoil and food dey melt', label: 'book' },
  { text: 'the AC blows but the room is still hot', label: 'book' },
  { text: 'the water pump stopped supplying my flat', label: 'book' },
  { text: 'my plug socket dey smell like burning', label: 'book' },
  { text: 'need someone wash empty apartment before moving in', label: 'book' },
  { text: 'generator no gree remain on after starting', label: 'book' },
  { text: 'who has accepted the service I requested', label: 'status' },
  { text: 'abeg where is my assigned technician', label: 'status' },
  { text: 'any progress on the request I submitted', label: 'status' },
  { text: 'how much will person charge to inspect my fridge', label: 'pricing' },
  { text: 'wetin be the cost before work starts', label: 'pricing' },
  { text: 'do I agree on the amount before the repair', label: 'pricing' },
  { text: 'can I use transfer to settle my bill', label: 'payment' },
  { text: 'how will I pay for the service', label: 'payment' },
  { text: 'is the artisan checked before coming to my home', label: 'trust' },
  { text: 'how do I know the person is verified', label: 'trust' },
  { text: 'is there service around my neighbourhood', label: 'coverage' },
  { text: 'una get technician for my area', label: 'coverage' },
  { text: 'I repair appliances and want to get jobs here', label: 'vendor_join' },
  { text: 'how can a carpenter register to receive work', label: 'vendor_join' },
  { text: 'the service damaged my things please get me support', label: 'human' },
  { text: 'I need a human to resolve a complaint', label: 'human' },
  { text: 'I want to stop the booking I just started', label: 'cancel' },
  { text: 'forget the service request please', label: 'cancel' },
  { text: 'write a football poem for my school', label: 'out_of_scope' },
  { text: 'what is the latest political news', label: 'out_of_scope' },
];
const addedCount = SEED.findIndex(([text]) => text === 'I need a cleaner for my 3 bedroom flat');
if (addedCount < 0) throw new Error('Could not find the original seed boundary');
const opts = { epochs: 40, lr: 2, l2: 1e-4 };
const test = holdout.map(e => ({ ...e, text: markers(e.text) }));
for (const [name, rows] of [['baseline', SEED.slice(addedCount)], ['candidate', SEED]] as const) {
  const examples = rows.map(([text, label]) => ({ text, label }));
  const model = train(prepare(examples), opts);
  const result = evaluate(model, test);
  console.log(JSON.stringify({ name, trainExamples: examples.length, holdout: result.n, accuracy: result.accuracy, macroF1: result.macroF1, perLabel: result.perLabel, mistakes: result.mistakes }));
}
