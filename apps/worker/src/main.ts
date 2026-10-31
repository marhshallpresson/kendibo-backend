// Worker — BullMQ consumers: payments reconcile/verify, dispatch expire, notifications,
// Sling omnichannel bulk campaigns, AI-assisted customer retainers, media, warranty, privacy.
import { registerHandler } from '../../../packages/queue/queues.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';
import { sms, whatsapp, email, push } from '../../../modules/notifications/channels.js';
import { deviceService } from '../../../modules/devices/device.service.js';
import { slingAutomationService } from '../../../modules/notifications/automation.service.js';

registerHandler('payments', 'payment.reconcile', async (job: { name: string; data: unknown }) => {
  try { /* poll pending txns via verify endpoints */ void job; } catch (e) { observability.captureException(e); throw e; }
});
registerHandler('dispatch', 'assignment.expire', async (job: { name: string; data: unknown }) => { void job; });
registerHandler('notifications', 'notification.send', async (job: { name: string; data: unknown }) => {
  const d = job.data as {
    template?: string;
    to?: { userId?: string; push?: string; phone?: string; whatsapp?: string; email?: string };
    vars?: Record<string, string>;
  };
  try {
    const title = 'KENDIBO update';
    const body = `${d.template ?? 'notification'}: ${Object.values(d.vars ?? {}).join(' ').slice(0, 140)}`;
    let sent = false;
    const tokens: string[] = [];
    if (d.to?.userId) tokens.push(...(await deviceService.tokensFor(d.to.userId)));
    if (d.to?.push) tokens.push(d.to.push);
    for (const t of tokens) { await push.send(t, title, body); sent = true; }
    if (!sent && d.to?.whatsapp) { await whatsapp.send(d.to.whatsapp, `${title} — ${body}`); sent = true; }
    if (!sent && d.to?.phone) { await sms.send(d.to.phone, `${title} — ${body}`); sent = true; }
    if (!sent && d.to?.email) { await email.send(d.to.email, title, `<p>${body}</p>`); sent = true; }
    void sent;
  } catch (e) { observability.captureException(e, { job: job.name }); throw e; }
});
registerHandler('bulk', 'campaign.launch', async (job: { name: string; data: unknown }) => {
  const d = job.data as { campaignId?: string; customNumbers?: string[] };
  if (d?.campaignId) {
    await slingAutomationService.launchCampaign(d.campaignId, d.customNumbers);
  }
});
registerHandler('maintenance', 'retainer.sweep', async () => {
  await slingAutomationService.sweepDueRetainers();
});
process.on('unhandledRejection', (err) => observability.captureException(err, { source: 'worker:unhandledRejection' }));
registerHandler('media', 'media.process', async (job: { name: string; data: unknown }) => { void job; });
registerHandler('maintenance', 'warranty.expire', async () => {});
registerHandler('maintenance', 'privacy.delete', async () => {});

console.log('kendibo-worker handlers registered (with Sling omnichannel + AI retainer handlers)');
