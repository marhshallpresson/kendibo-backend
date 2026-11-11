// The page a customer opens to pay a Paga bank-transfer payment request: the
// one-off account number, the exact amount, the expiry, and the live status.
// No secrets: the link is signed (purpose 'paga') and only shows what the
// customer needs to make the transfer.
import { escapeHtml } from '../../notifications/mail.templates.js';

export interface PagaPayView {
  status: 'pending' | 'successful' | 'failed' | 'expired';
  accountNumber: string | null;
  bankName: string | null;
  amountKobo: bigint;
  expiresAt: string | null;
  reference: string;
  sandbox: boolean;
  nonce: string;
}

const naira = (kobo: bigint) => `₦${(Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function renderPagaPayPage(v: PagaPayView): string {
  const when = v.expiresAt ? new Date(`${v.expiresAt.replace(/Z?$/, 'Z')}`).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
  const body = v.status === 'successful'
    ? `<h1>Payment received</h1><p>Thank you. Your payment of <b>${escapeHtml(naira(v.amountKobo))}</b> is confirmed. You can close this page.</p>`
    : v.status === 'failed' || v.status === 'expired'
      ? `<h1>This payment link has ended</h1><p>No money was taken by this link. Go back to WhatsApp or the app and ask for a new payment link.</p>`
      : `<h1>Pay by bank transfer</h1>
         <p>Transfer exactly this amount to the account below from any bank app. We confirm it automatically.</p>
         <dl>
           <dt>Amount</dt><dd class="big">${escapeHtml(naira(v.amountKobo))}</dd>
           <dt>Account number</dt><dd class="big" id="acct">${escapeHtml(v.accountNumber ?? 'Not available, please ask for a new link')}</dd>
           <dt>Bank</dt><dd>${escapeHtml(v.bankName ?? 'Paga')}</dd>
           ${when ? `<dt>Pay before</dt><dd>${escapeHtml(when)}</dd>` : ''}
         </dl>
         <button id="copy" type="button">Copy account number</button>
         <p class="muted" id="state" role="status" aria-live="polite">Waiting for your transfer…</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kendibo payment</title>
<style nonce="${v.nonce}">
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f8fc;color:#0f172a}
  main{max-width:440px;margin:0 auto;padding:24px 16px}
  h1{font-size:20px;margin:8px 0 12px} p{font-size:14px;line-height:1.5}
  dl{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;margin:16px 0}
  dt{font-size:12px;color:#64748b;margin-top:8px} dd{margin:2px 0 4px;font-size:15px}
  .big{font-size:22px;font-weight:700;letter-spacing:.5px}
  button{width:100%;padding:12px;border:0;border-radius:10px;background:#1d5bd6;color:#fff;font-size:15px;font-weight:600}
  .muted{color:#64748b;font-size:13px} .tag{display:inline-block;font-size:11px;background:#fef3c7;color:#92400e;border-radius:6px;padding:2px 8px}
</style></head><body><main>
${v.sandbox ? '<span class="tag">Test payment (sandbox): no real money moves</span>' : ''}
${body}
<p class="muted">Reference: ${escapeHtml(v.reference)}</p>
</main>
${v.status === 'pending' ? `<script nonce="${v.nonce}">
  document.getElementById('copy')?.addEventListener('click', function () {
    var t = document.getElementById('acct'); if (t && navigator.clipboard) navigator.clipboard.writeText(t.textContent.trim());
    this.textContent = 'Copied';
  });
  // Re-check every 15s; the server asks Paga, so a late callback doesn't leave the page stuck.
  setInterval(function () { location.reload(); }, 15000);
</script>` : ''}
</body></html>`;
}
