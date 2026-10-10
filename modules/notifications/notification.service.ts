// Notifications — Domain Event -> versioned Template -> Channel Router.
// Persisted to notification.notification; delivery via BullMQ worker with
// push -> SMS fallback -> WhatsApp fallback. Marketing consent separate.
import { enqueue } from '../../packages/queue/queues.js';
import { q } from '../../packages/database/db.js';

export const TEMPLATES = [
  'booking.confirmed', 'provider.assigned', 'provider.en_route', 'provider.arrived',
  'quote.ready', 'payment.success', 'payment.failed', 'refund.completed', 'warranty.expiring',
  'welcome',
] as const;
export type Template = (typeof TEMPLATES)[number];

export const notificationService = {
  async dispatch(template: Template, to: { userId?: string; push?: string; phone?: string }, vars: Record<string, string> = {}) {
    const channel = to.push ? 'push' : to.phone ? 'sms' : 'inapp';
    await q(`INSERT INTO notification.notification (recipient_id, channel, template) VALUES ($1,$2,$3)`,
      [to.userId ?? to.phone ?? 'unknown', channel, `${template}@v1`]);
    await enqueue('notifications', 'notification.send', { template: `${template}@v1`, to, vars, idempotencyKey: `${template}:${JSON.stringify(vars)}` });
    return { queued: true, template };
  },
};
