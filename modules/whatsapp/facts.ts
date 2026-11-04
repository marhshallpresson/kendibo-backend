// Official answers the assistant gives about how Kendibo works. Kept here
// (never in a prompt) so ops can change them in one place, and so the bot
// answers the common questions without calling the LLM at all.
import { q } from '../../packages/database/db.js';

export const FACTS: Record<string, string> = {
  payments: "When payment is required, Kendibo provides a checkout link. Review the amount and payment options before paying. Ask to speak to a person if you have questions about payment or a dispute.",
  refunds: 'If a job is cancelled before the vendor sets out, there is no charge. After that a call-out fee may apply, and you see it before you confirm. Problems with finished work go to support, and refunds go back to your payment method or Kendibo wallet.',
  warranty: 'Finished work comes with a workmanship warranty for the period on your receipt. If something fails because of the work, claim it from the receipt in the app or ask here, and support will arrange a fix.',
  coverage: "We're live in Uyo first, then Lagos and Abuja. When you set your location, we tell you straight away if the address is covered.",
  pricing: 'Standard jobs (like cleaning by number of rooms) have fixed prices. Repairs are quoted by the vendor after they see the problem, often within a range shown upfront, with parts listed separately. A small call-out fee may apply, and it counts towards the job if you go ahead.',
  safety: 'Every vendor passes ID and selfie checks, and trades like electrical work need a licence on file. You see verified badges and real reviews before you choose, and you can report anything unsafe here.',
  become_a_pro: 'Vendors join through the Kendibo app: sign up as a pro, verify your ID with a selfie, add your trade and payout account. Approved vendors get job offers here on WhatsApp and in the app, plus their own shareable storefront link.',
  about: 'Kendibo helps you request home-service professionals and follow your requests. You can also ask to speak to a person.',
};

const naira = (k: bigint | number | string) => `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;

/** Starting prices for one trade, from the catalogue (never invented). */
export async function priceLines(categoryId: string): Promise<string | null> {
  const rows = await q<{ name: string; booking_type: string; base_price_kobo: string }>(
    `SELECT name, booking_type, base_price_kobo FROM catalog.service WHERE category_id=$1 AND active ORDER BY name LIMIT 6`, [categoryId],
  ).catch(() => []);
  if (!rows.length) return null;
  return rows.map((s) => `${s.name}: ${s.booking_type === 'quote' || !Number(s.base_price_kobo) ? 'priced after inspection' : `from ${naira(s.base_price_kobo)}`}`).join('\n');
}
