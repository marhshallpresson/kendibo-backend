// WhatsApp message templates on the Business Account.
//   npm run whatsapp:templates            show the catalogue and Meta's review status
//   npm run whatsapp:templates -- --submit   submit catalogue templates Meta doesn't have yet
// Same as the buttons on the admin console's WhatsApp assistant page.
// Needs WHATSAPP_ACCESS_TOKEN (permanent System User token with
// whatsapp_business_management) and WHATSAPP_BUSINESS_ACCOUNT_ID.
import 'dotenv/config';
import { catalogue, remoteTemplates, submitMissingTemplates, templateApiConfigured } from '../modules/whatsapp/templates.js';

async function main() {
  if (!templateApiConfigured()) {
    console.error('Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID in .env first.');
    process.exit(1);
  }
  if (process.argv.includes('--submit')) {
    const r = await submitMissingTemplates();
    console.log(`submitted: ${r.submitted.join(', ') || 'none'} · already there: ${r.existing.join(', ') || 'none'}`);
    for (const e of r.errors) console.log(`error ${e.name}: ${e.error}`);
  }
  const remote = await remoteTemplates();
  for (const t of catalogue()) {
    const r = remote.find((x) => x.name === t.name && x.language === t.language);
    console.log(`${t.name.padEnd(28)} ${t.language.padEnd(5)} ${(r?.status ?? 'NOT SUBMITTED').padEnd(14)} ${r?.category ?? t.category}  ${t.purpose}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(String((e as Error).message)); process.exit(1); });
