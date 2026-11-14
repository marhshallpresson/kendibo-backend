// Provider-facing tier notifications: in-app inbox + push + WhatsApp through
// the existing omnichannel service (user preferences are honoured there).
// Always best-effort: a failed message never blocks a tier/subscription change.
import { q } from '../../packages/database/db.js';

export const naira = (kobo: bigint | number | string): string => `₦${(Number(kobo) / 100).toLocaleString('en-NG')}`;

export async function notifyProvider(userId: string, template: string, title: string, body: string, route = '/provider/tier'): Promise<void> {
  try {
    const { notificationService } = await import('../notifications/notification.service.js');
    await notificationService.sendOmnichannel({
      recipientId: userId, channels: ['inapp', 'push', 'whatsapp'], template,
      vars: { title, body }, msgType: 'transactional', route,
    });
  } catch (e) {
    console.warn(`[tiers] notify ${template} failed: ${(e as Error).message}`);
  }
}

/** Claim a once-per-(user, template, period) slot; false when it was already claimed. */
export async function claimOnce(userId: string, template: string, period: string): Promise<boolean> {
  const prior = await q(`SELECT 1 FROM notification.email_send_log WHERE user_id=$1 AND template=$2 AND period=$3`, [userId, template, period]).catch(() => []);
  if (prior.length) return false;
  try {
    await q(`INSERT INTO notification.email_send_log (user_id, template, period, kind) VALUES ($1,$2,$3,'transactional')`, [userId, template, period]);
    return true;
  } catch { return false; }
}
