// Worker — BullMQ consumers: payments reconcile/verify, dispatch expire, notifications, media, warranty, privacy.
import { registerHandler } from '../../../packages/queue/queues.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';
import { sms, email, push } from '../../../modules/notifications/channels.js';
import { deviceService } from '../../../modules/devices/device.service.js';

registerHandler('payments', 'payment.reconcile', async (job: { name: string; data: unknown }) => {
  try { /* poll pending txns via verify endpoints */ void job; } catch (e) { observability.captureException(e); throw e; }
});
registerHandler('dispatch', 'assignment.expire', async (job: { name: string; data: unknown }) => { void job; });
registerHandler('notifications', 'notification.send', async (job: { name: string; data: unknown }) => { void job; });
registerHandler('media', 'media.process', async (job: { name: string; data: unknown }) => { void job; });
registerHandler('maintenance', 'warranty.expire', async () => {});
registerHandler('maintenance', 'privacy.delete', async () => {});

console.log('kendibo-worker handlers registered');
