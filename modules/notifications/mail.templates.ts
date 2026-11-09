// Kendibo canonical mail templates — ported from kendibo-page
// (backend branch) lib/mail-templates.js, the system of record for brand.
// Table layout for client compatibility; nothing hardcoded: links resolve
// from APP_URL env. All money in Naira (₦/NGN), integer kobo in, formatted out.
const APP_NAME = process.env.APP_NAME ?? 'Kendibo';

export const normalizeUrl = (value: string): string => String(value || '').trim().replace(/\/+$/, '');
const defaultAppUrl = (): string => normalizeUrl(process.env.APP_URL || 'http://localhost:3000');
const resolveAppUrl = (override?: string): string => normalizeUrl(override || defaultAppUrl());

const PRIMARY = '#0463ee';
const NAVY = '#002a63';

const styles = {
  body: 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.7; color: #333; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; background-color: #eef2fb;',
  header: `background-color: ${NAVY}; padding: 28px 20px; text-align: center;`,
  brand: 'color: #ffffff; font-size: 26px; font-weight: 900; letter-spacing: -0.5px; margin: 0;',
  brandDot: 'color: #9dbfff;',
  content: 'padding: 36px 34px; background-color: #ffffff;',
  p: 'font-size: 16px; margin: 0 0 20px 0; color: #333333; line-height: 1.7;',
  boldLine: 'font-size: 16px; font-weight: 800; margin: 0 0 20px 0; color: #111111; line-height: 1.7;',
  buttonContainer: 'text-align: center; margin: 30px 0;',
  button: `display: inline-block; background-color: ${PRIMARY}; color: #ffffff; font-size: 16px; font-weight: 800; text-decoration: none; padding: 15px 34px; border-radius: 10px;`,
  signoff: 'font-size: 16px; margin: 0; color: #333333; line-height: 1.7;',
  footer: 'background-color: #f8fafd; padding: 26px 20px; text-align: center; font-size: 12px; color: #8fa0bf;',
  socialLink: 'display: inline-block; margin: 0 10px; color: #5b6b8c; text-decoration: none; font-weight: 700;',
  divider: 'height: 1px; background-color: #e2e8f5; margin: 24px 0;',
};

export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function renderLayout(content: string, title: string, opts: { recipientEmail?: string; appUrl?: string } = {}): string {
  const site = resolveAppUrl(opts.appUrl);
  const unsub = opts.recipientEmail
    ? `${site}/#/unsubscribe?email=${encodeURIComponent(opts.recipientEmail)}`
    : `${site}/#/unsubscribe`;
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="${styles.body}">
  <table width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center" style="padding: 20px 12px;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 42, 99, 0.15);">
          <tr>
            <td style="${styles.header}">
              <p style="${styles.brand}"><a href="${site}/" style="color: #ffffff; text-decoration: none;">kendibo<span style="${styles.brandDot}">.</span></a></p>
              <p style="color: #9dbfff; font-size: 12px; margin: 6px 0 0 0;">Good help. Right around the corner.</p>
            </td>
          </tr>
          <tr>
            <td style="${styles.content}">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="${styles.footer}">
              <p style="margin: 0 0 14px 0; font-weight: 700; color: #5b6b8c;">Stay Connected</p>
              <div style="margin-bottom: 18px;">
                <a href="https://www.facebook.com/kendibohomes" style="${styles.socialLink}">Facebook</a>
                <a href="https://www.instagram.com/kendibohomes" style="${styles.socialLink}">Instagram</a>
                <a href="https://x.com/kendibohomes" style="${styles.socialLink}">X</a>
                <a href="https://www.linkedin.com/company/kendibohomes" style="${styles.socialLink}">LinkedIn</a>
              </div>
              <div style="${styles.divider}"></div>
              <p style="margin: 0;">&copy; ${new Date().getFullYear()} ${escapeHtml(APP_NAME)}. All rights reserved.</p>
              <p style="margin: 12px 0 0 0; font-size: 11px;">If you wish to unsubscribe from our newsletter, click <a href="${unsub}" style="color: #8fa0bf; text-decoration: underline;">here</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

const firstNameOf = (name?: string): string => String(name || '').trim().split(/\s+/)[0] || 'there';
export const koboToNaira = (kobo: number | bigint | string): string =>
  (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

export interface MailPiece { html: string; text: string }

export const templates = {
  welcome(name?: string, opts: { recipientEmail?: string; appUrl?: string; whatsappUrl?: string } = {}): MailPiece {
    const first = escapeHtml(firstNameOf(name));
    const wa = String(opts.whatsappUrl || '').trim();
    const content = `
      <p style="${styles.p}">Hi ${first},</p>
      <p style="${styles.p}">Thanks for joining Kendibo.</p>
      <p style="${styles.p}">We started building <strong>Kendibo</strong> with one goal: make finding trusted home help faster, safer, and simpler — no more endless phone calls, WhatsApp broadcasts, or hoping a referral shows up.</p>
      <p style="${styles.boldLine}">What if booking trusted home help felt as easy as sending a WhatsApp message?</p>
      <p style="${styles.p}">That's how <strong>Kendibo</strong> was born.</p>
      <p style="${styles.p}">Kendibo brings verified cleaners, plumbers, electricians, and handymen into one marketplace with smart location matching. Instead of chasing referrals, you simply tell us what you need done — and Kendibo handles the rest.</p>
      ${wa ? `
      <div style="${styles.buttonContainer}">
        <a href="${escapeHtml(wa)}" style="${styles.button}">Join the Private WhatsApp Group</a>
      </div>` : ''}
      <p style="${styles.p}">I can't wait to hear what you think.</p>
      <p style="${styles.p}">See you inside.</p>
      <p style="${styles.signoff}">From the Kendibo Team</p>
    `;
    return {
      html: renderLayout(content, `Welcome to Kendibo, ${firstNameOf(name)}!`, opts),
      text: `Hi ${firstNameOf(name)},\n\nThanks for joining Kendibo.\n\nWhat if booking trusted home help felt as easy as sending a WhatsApp message?\n\nSee you inside.\nFrom the Kendibo Team`,
    };
  },

  newsletter(subject: string, bodyHtml: string, recipientName?: string, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const first = firstNameOf(recipientName);
    const personalised = String(bodyHtml || '')
      .replace(/\{\{\s*firstName\s*\}\}/g, escapeHtml(first))
      .replace(/\{\{\s*name\s*\}\}/g, escapeHtml(recipientName || 'there'));
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(first)},</p>
      <div style="font-size: 16px; color: #333333; line-height: 1.7;">${personalised}</div>
      <p style="${styles.signoff}"><br>From the Kendibo Team</p>
    `;
    return {
      html: renderLayout(content, subject, opts),
      text: `Hi ${first},\n\n${String(bodyHtml || '').replace(/<[^>]+>/g, '')}\n\nFrom the Kendibo Team`,
    };
  },

  otp(code: string, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const content = `
      <p style="${styles.p}">Your Kendibo verification code is:</p>
      <p style="font-size: 32px; font-weight: 900; letter-spacing: 6px; text-align: center; margin: 8px 0 24px 0; color: #111111;">${escapeHtml(code)}</p>
      <p style="${styles.p}">It expires in 5 minutes. Never share this code with anyone.</p>
    `;
    return {
      html: renderLayout(content, `Your Kendibo code - ${code}`, opts),
      text: `Your Kendibo verification code is: ${code}\nIt expires in 5 minutes.`,
    };
  },

  /** Email added on WhatsApp: one tap confirms it is theirs before we attach it. */
  confirmEmail(input: { name?: string; link: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}">You added this email to your Kendibo account on WhatsApp. Tap below to confirm it is yours. We will send your booking receipts here, and you can use it to sign in to the app.</p>
      <p style="text-align:center;margin:24px 0"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:#1D5BD6;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px">Confirm my email</a></p>
      <p style="${styles.p}">The link works for 24 hours. If you did not add this email, ignore this message and nothing changes.</p>
    `;
    return {
      html: renderLayout(content, 'Confirm your email for Kendibo', opts),
      text: `Hi ${firstNameOf(input.name)},\nConfirm your email for Kendibo: ${input.link}\nThe link works for 24 hours. If you did not add this email, ignore this message.`,
    };
  },

  /** WhatsApp RECOVER: the code that moves a new number onto this account. */
  recoveryCode(input: { name?: string; code: string; last4: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}">Someone asked to move your Kendibo account to the WhatsApp number ending ${escapeHtml(input.last4)}. If that's you, reply in WhatsApp with this code:</p>
      <p style="font-size: 32px; font-weight: 900; letter-spacing: 6px; text-align: center; margin: 8px 0 24px 0; color: #111111;">${escapeHtml(input.code)}</p>
      <p style="${styles.p}">It works for 10 minutes. Never share it with anyone, including Kendibo staff. If this wasn't you, ignore this email and nothing changes.</p>
    `;
    return {
      html: renderLayout(content, 'Your Kendibo account recovery code', opts),
      text: `Hi ${firstNameOf(input.name)},\nYour Kendibo recovery code is ${input.code}. It works for 10 minutes.\nIf you did not ask to move your account to the number ending ${input.last4}, ignore this email.`,
    };
  },

  /** WhatsApp RECOVER finished: tell the old address the account moved. */
  accountMoved(input: { name?: string; last4: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}">Your Kendibo account is now on the WhatsApp number ending ${escapeHtml(input.last4)}.</p>
      <p style="${styles.p}">If this wasn't you, reply to this email or contact Kendibo support right away and we'll lock the account.</p>
    `;
    return {
      html: renderLayout(content, 'Your Kendibo account moved to a new number', opts),
      text: `Hi ${firstNameOf(input.name)},\nYour Kendibo account is now on the WhatsApp number ending ${input.last4}.\nIf this wasn't you, reply to this email or contact Kendibo support right away.`,
    };
  },

  bookingConfirmed(input: { name?: string; service: string; when: string; where: string; ref: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const row = (k: string, v: string) => `<p style="${styles.p}"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</p>`;
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}">Your booking is confirmed. Here is your summary:</p>
      ${row('Service', input.service)}${row('When', input.when)}${row('Where', input.where)}${row('Reference', input.ref)}
      <p style="${styles.p}">We will notify you the moment a verified provider accepts.</p>
    `;
    return {
      html: renderLayout(content, `Booking confirmed — ${input.ref}`, opts),
      text: `Hi ${firstNameOf(input.name)},\nYour booking ${input.ref} is confirmed.\nService: ${input.service}\nWhen: ${input.when}\nWhere: ${input.where}`,
    };
  },

  paymentSuccess(input: { name?: string; amountKobo: number | bigint | string; ref: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const naira = koboToNaira(input.amountKobo);
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.boldLine}">Payment received: ₦${naira}</p>
      <p style="${styles.p}">Reference: ${escapeHtml(input.ref)}. Your money is held safely until the job is done.</p>
    `;
    return {
      html: renderLayout(content, `Payment received — ${input.ref}`, opts),
      text: `Hi ${firstNameOf(input.name)},\nPayment received: NGN ${naira}\nReference: ${input.ref}`,
    };
  },

  providerAssigned(input: { name?: string; provider: string; eta?: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}"><strong>${escapeHtml(input.provider)}</strong> is on the way${input.eta ? ` (ETA ${escapeHtml(input.eta)})` : ''}.</p>
      <p style="${styles.p}">You can track the visit live in the Kendibo app.</p>
    `;
    return {
      html: renderLayout(content, 'Your provider is on the way', opts),
      text: `Hi ${firstNameOf(input.name)},\n${input.provider} is on the way${input.eta ? ` (ETA ${input.eta})` : ''}.`,
    };
  },

  refundProcessed(input: { name?: string; amountKobo: number | bigint | string; ref: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const naira = koboToNaira(input.amountKobo);
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}">A refund of <strong>₦${naira}</strong> has been processed for ${escapeHtml(input.ref)}.</p>
      <p style="${styles.p}">Bank/card refunds land within 3–7 working days; wallet refunds are instant.</p>
    `;
    return {
      html: renderLayout(content, `Refund processed — ${input.ref}`, opts),
      text: `Hi ${firstNameOf(input.name)},\nRefund of NGN ${naira} processed for ${input.ref}.`,
    };
  },

  payoutSent(input: { name?: string; amountKobo: number | bigint | string; ref: string }, opts: { recipientEmail?: string; appUrl?: string } = {}): MailPiece {
    const naira = koboToNaira(input.amountKobo);
    const content = `
      <p style="${styles.p}">Hi ${escapeHtml(firstNameOf(input.name))},</p>
      <p style="${styles.p}">Your payout of <strong>₦${naira}</strong> is on its way (${escapeHtml(input.ref)}).</p>
      <p style="${styles.p}">Bank transfers typically land within 24 hours.</p>
    `;
    return {
      html: renderLayout(content, `Payout sent — ${input.ref}`, opts),
      text: `Hi ${firstNameOf(input.name)},\nPayout of NGN ${naira} sent (${input.ref}).`,
    };
  },
};

export type TemplateName = keyof typeof templates;
