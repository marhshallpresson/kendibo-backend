// Retrain the WhatsApp assistant's intent model from the seed lines plus every
// line ops have labelled, and switch it on only if held-out macro-F1 holds up.
// Same as the "Retrain" button in the admin console. Run: npm run ml:train-nlu
import 'dotenv/config';
import { retrainNlu } from '../modules/whatsapp/nlu/index.js';

retrainNlu()
  .then((r) => {
    console.log(`${r.promoted ? 'PROMOTED' : 'KEPT CURRENT MODEL'}: ${r.reason}`);
    console.log(`held-out macro-F1 ${r.macroF1.toFixed(3)} (current ${r.baselineF1.toFixed(3)}), labelled lines ${r.labelled}`);
    process.exit(0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
