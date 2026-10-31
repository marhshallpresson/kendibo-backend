// Retrain the vendor-matching model from logged rankings + real outcomes.
//   npm run ml:train            (uses DATABASE_URL)
// Safe to run on a schedule (e.g. nightly): it only activates a model that
// beats the current one on held-out requests.
import 'dotenv/config';
import { trainAndMaybeActivate } from '../modules/matching/trainer.js';

const out = await trainAndMaybeActivate();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
