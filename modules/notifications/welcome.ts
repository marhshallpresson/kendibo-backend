// Welcome messaging — fires once at account creation (OTP new user or Google
// isNew). Every channel is best-effort: failures log and never block auth.
// Integrates with Sling Contacts (/api/v2/upsert-contact), Sling Visual Workflow
// Forms (/api/v2/forms/{formId}/submit), and WhatsApp/SMS/Email/Push channels.
import { q } from '../../packages/database/db.js';
import { email as emailPort, push as pushPort, whatsapp as whatsappPort } from './channels.js';
import { slingClient } from './sling.client.js';

const SUBJECT = 'Welcome to KENDIBO';

function welcomeHtml(name: string): string {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0b1b36;max-width:520px;margin:0 auto;padding:24px">
  <h1 style="color:#0463ee;font-size:22px">Welcome to KENDIBO${name ? `, ${name}` : ''} 👋</h1>
  <p style="font-size:15px;line-height:1.6">Your account is ready. Book trusted local professionals — cleaners, plumbers, electricians, appliance mechanics — in under 60 seconds, track them live, and pay securely.</p>
  <p style="font-size:15px;line-height:1.6">Need a hand getting started? Just reply to this email.</p>
  <p style="font-size:13px;color:#5b6b84;margin-top:28px">— The KENDIBO team</p>
  </body></html>`;
}

export const welcomeService = {
  async send(user: { id: string; name?: string | null; email?: string | null; phone?: string | null; role?: string }) {
    const name = (user.name ?? '').trim();

    // 1) In-app bookkeeping row (the notification inbox reads this trail).
    try {
      await q(
        `INSERT INTO notification.notification (recipient_id, channel, template, title, body, route)
         VALUES ($1,'inapp','welcome@v1',$2,$3,'/(tabs)')`,
        [
          user.id,
          `Welcome to KENDIBO${name ? `, ${name}` : ''}!`,
          'Book verified cleaners, plumbers, electricians & AC pros in 60 seconds with escrow protection.',
        ],
      ).catch(async () => {
        await q(
          `INSERT INTO notification.notification (recipient_id, channel, template) VALUES ($1,'inapp','welcome@v1')`,
          [user.id],
        );
      });
    } catch (e) {
      console.warn('[welcome] in-app row failed', (e as Error).message);
    }

    // 2) Sling Contact Upsert + Onboarding Form Automation + WhatsApp Welcome
    if (user.phone) {
      void slingClient
        .upsertContact({
          name: name || 'Kendibo User',
          email: user.email || undefined,
          phone: user.phone,
          identifier: user.id,
          description: `Kendibo ${user.role || 'CUSTOMER'}`,
        })
        .catch(() => {});

      const formId = process.env.SLING_ONBOARDING_FORM_ID || 'kendibo_onboarding_v2';
      void slingClient
        .submitAutomationForm(formId, {
          name: name || 'Kendibo User',
          email: user.email || undefined,
          phone: user.phone,
          fields: { userId: user.id, role: user.role || 'CUSTOMER' },
        })
        .catch(() => {});

      void whatsappPort
        .send(
          user.phone,
          `Welcome to *KENDIBO*${name ? `, *${name}*` : ''} 👋!\n\nYour account is live. Book verified home cleaners, AC technicians, plumbers & electricians in under 60 seconds with full escrow protection.`,
          { type: 'transactional' },
        )
        .catch(() => {});
    }

    // 3) Email via the existing channel port (SMTP relay or Sling Email).
    if (user.email) {
      void emailPort.send(user.email, SUBJECT, welcomeHtml(name)).catch((e) => {
        console.warn('[welcome] email failed', (e as Error).message);
      });
    }

    // 4) Push to every registered device token for this user.
    try {
      const rows = await q<{ push_token: string }>(
        `SELECT push_token FROM identity.device WHERE user_id=$1`,
        [user.id],
      );
      for (const r of rows) {
        const token = String(r.push_token || '');
        if (!token) continue;
        void pushPort
          .send(
            token,
            'Welcome to KENDIBO',
            `Hi ${name || 'there'} — your account is ready. Book a trusted professional in under 60 seconds.`,
            { route: '/(tabs)' },
          )
          .catch((e) => console.warn('[welcome] push failed', (e as Error).message));
      }
    } catch (e) {
      console.warn('[welcome] device lookup failed', (e as Error).message);
    }

    return { queued: true };
  },
};
