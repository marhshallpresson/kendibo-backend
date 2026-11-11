// The printable receipt / invoice page (/w/invoice/:token) and its email.
// Clean, print-friendly HTML with no scripts; every value is escaped.
import type { Invoice } from './invoice.service.js';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const naira = (kobo: string | bigint | number) => `₦${(Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }).format(new Date(iso));

const CSS = `
:root{--ink:#0F172A;--sub:#475569;--line:#E2E8F0;--brand:#1D5BD6;--bg:#F6F7F9;--ok:#15803D;--okbg:#EAF6EE;--warn:#92400E;--warnbg:#FEF3C7}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.doc{max-width:720px;margin:16px auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px}
.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:16px}
.brand{font-size:22px;font-weight:800;color:var(--brand);margin:0}.co{color:var(--sub);font-size:13px;margin:4px 0 0}
h1{font-size:18px;margin:0;text-align:right}.meta{color:var(--sub);font-size:13px;text-align:right;margin:4px 0 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;margin:16px 0}.grid dt{color:var(--sub);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.grid dd{margin:0;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:10px 0;border-bottom:1px solid var(--line)}th{color:var(--sub);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.amt,th.amt{text-align:right;white-space:nowrap}tr.total td{font-weight:800;border-bottom:0;font-size:16px}
.status{display:inline-block;border-radius:999px;padding:4px 10px;font-size:13px;font-weight:600;margin-top:12px}
.held{color:var(--warn);background:var(--warnbg)}.released{color:var(--ok);background:var(--okbg)}
.foot{color:var(--sub);font-size:12px;margin-top:20px;border-top:1px solid var(--line);padding-top:12px}
.print{display:block;width:100%;margin:16px 0 0;padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--brand);font:inherit;font-weight:700;text-align:center;text-decoration:none}
@media (max-width:520px){.grid{grid-template-columns:1fr}h1,.meta{text-align:left}.doc{margin:0;border-radius:0;border-left:0;border-right:0}}
@media print{body{background:#fff}.doc{border:0;margin:0;max-width:none}.print{display:none}}
`;

export function renderInvoicePage(inv: Invoice): string {
  const d = inv.data;
  const title = inv.kind === 'final' ? 'Invoice' : 'Payment receipt';
  const rows = d.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="amt">${naira(l.amountKobo)}</td></tr>`).join('');
  const status = inv.kind === 'final'
    ? '<span class="status released">Paid. Job confirmed and payment released to the pro.</span>'
    : '<span class="status held">Paid. Kendibo holds this payment until you confirm the job is done.</span>';
  const c = d.company;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} ${esc(inv.number)} — Kendibo</title><style>${CSS}</style></head>
<body><main class="doc">
<div class="top"><div><p class="brand">kendibo.</p><p class="co">${esc(c.name)}<br>${esc(c.address)}<br>${esc(c.email)}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.rc ? `<br>RC ${esc(c.rc)}` : ''}</p></div>
<div><h1>${esc(title)}</h1><p class="meta">No. ${esc(inv.number)}<br>Issued ${esc(dateText(inv.issuedAt))}</p></div></div>
<dl class="grid">
<div><dt>Billed to</dt><dd>${esc(d.customerName ?? 'Kendibo customer')}</dd></div>
<div><dt>Service date</dt><dd>${esc(d.when ?? 'To be agreed')}</dd></div>
<div><dt>Pro</dt><dd>${esc(d.proName ?? 'Kendibo pro')}</dd></div>
<div><dt>Address</dt><dd>${esc(d.address ?? '—')}</dd></div>
</dl>
<table><thead><tr><th>Item</th><th class="amt">Amount</th></tr></thead><tbody>${rows}
<tr class="total"><td>Total paid</td><td class="amt">${naira(d.paidKobo)}</td></tr></tbody></table>
${status}
<p class="foot">Payment reference: ${esc(d.paymentReference ?? '—')}${d.paidAt ? ` · Paid ${esc(dateText(d.paidAt))}` : ''}<br>
Prices include everything you pay. Kendibo's service fee is charged to the pro, not to you.<br>
Questions? Message us on WhatsApp or email ${esc(c.email)}. ${esc(c.website)}</p>
<p class="print">To keep a copy, use your browser's Print or Share and choose "Save as PDF".</p>
</main></body></html>`;
}

export function renderInvoiceEmail(opts: { name?: string; number: string; kind: 'receipt' | 'final'; service: string; when: string | null; proName: string | null; total: string; url: string }): { html: string; text: string } {
  const first = esc(String(opts.name ?? '').trim().split(/\s+/)[0] || 'there');
  const doc = opts.kind === 'final' ? 'invoice' : 'receipt';
  const intro = opts.kind === 'final'
    ? 'Thanks for confirming your job. Here is your invoice.'
    : 'We got your payment. Kendibo holds it safely until you confirm the job is done.';
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0b1b36;max-width:520px;margin:0 auto;padding:24px">
  <p style="font-size:22px;font-weight:800;color:#1D5BD6;margin:0 0 16px">kendibo.</p>
  <p style="font-size:15px;line-height:1.6">Hi ${first},</p>
  <p style="font-size:15px;line-height:1.6">${esc(intro)}</p>
  <table style="font-size:15px;line-height:1.8;border-collapse:collapse">
    <tr><td style="color:#5b6b84;padding-right:16px">${doc === 'invoice' ? 'Invoice' : 'Receipt'}</td><td><strong>${esc(opts.number)}</strong></td></tr>
    <tr><td style="color:#5b6b84;padding-right:16px">Service</td><td>${esc(opts.service)}</td></tr>
    ${opts.when ? `<tr><td style="color:#5b6b84;padding-right:16px">Date</td><td>${esc(opts.when)}</td></tr>` : ''}
    ${opts.proName ? `<tr><td style="color:#5b6b84;padding-right:16px">Pro</td><td>${esc(opts.proName)}</td></tr>` : ''}
    <tr><td style="color:#5b6b84;padding-right:16px">Paid</td><td><strong>${esc(opts.total)}</strong></td></tr>
  </table>
  <p style="margin:24px 0"><a href="${esc(opts.url)}" style="background:#1D5BD6;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">View or print your ${doc}</a></p>
  <p style="font-size:13px;color:#5b6b84">— The Kendibo team</p>
  </body></html>`;
  const text = `Hi ${String(opts.name ?? '').trim().split(/\s+/)[0] || 'there'},\n\n${intro}\n${doc === 'invoice' ? 'Invoice' : 'Receipt'}: ${opts.number}\nService: ${opts.service}\nPaid: ${opts.total}\n\nView or print: ${opts.url}\n\n— The Kendibo team`;
  return { html, text };
}
