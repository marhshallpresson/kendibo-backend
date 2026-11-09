// Read-only check of every third-party integration configured in .env.
// It never sends a message, never creates a payment or a billed lookup, never
// touches the database, and never prints a key. Run: npm run integrations:check
import 'dotenv/config';
import nodemailer from 'nodemailer';

type Status = 'ok' | 'fail' | 'not set' | 'skipped';
const rows: { name: string; status: Status; detail: string }[] = [];
const env = (k: string) => (process.env[k] ?? '').trim();
const timeout = (ms = 12_000) => AbortSignal.timeout(ms);

// Anything that looks like a credential is scrubbed from what we print.
const secrets = Object.entries(process.env)
  .filter(([k, v]) => /(KEY|TOKEN|SECRET|PASS|JSON)/.test(k) && (v ?? '').length >= 8)
  .map(([, v]) => String(v));
const scrub = (s: string) => secrets.reduce((out, v) => out.split(v).join('[redacted]'), s);

async function check(name: string, needs: string[], fn: () => Promise<string>) {
  const missing = needs.filter((k) => !k.split('|').some((alt) => env(alt)));
  if (missing.length) {
    rows.push({ name, status: 'not set', detail: `missing ${missing.join(', ')}` });
    return;
  }
  try {
    rows.push({ name, status: 'ok', detail: scrub(await fn()) });
  } catch (e) {
    rows.push({ name, status: 'fail', detail: scrub((e as Error).message).slice(0, 220) });
  }
}
const skip = (name: string, detail: string) => rows.push({ name, status: 'skipped', detail });

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}
const count = (j: Record<string, unknown>) => {
  const d = j.data ?? j.banks ?? j.models ?? j;
  return Array.isArray(d) ? d.length : 0;
};

async function main() {
  await check('Bachs (payments)', ['BACHS_API_KEY'], async () => {
    const base = env('BACHS_BASE_URL') || 'https://sandbox-api.bachs.io';
    const key = env('BACHS_API_KEY');
    const j = await json(await fetch(`${base}/v1/reference/banks?country=NG`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: timeout(),
    }), 'bank list');
    const host = base.includes('sandbox') ? 'sandbox host' : 'LIVE host';
    const kind = key.startsWith('sk_live') ? 'live key' : key.startsWith('sk_sandbox') ? 'sandbox key' : 'unrecognised key prefix';
    return `${host}, ${kind}; bank list: ${count(j)} banks${env('BACHS_ACCOUNT_ID') ? '' : '; BACHS_ACCOUNT_ID is not set'}${env('BACHS_WEBHOOK_SECRET') ? '' : '; BACHS_WEBHOOK_SECRET is not set'}`;
  });

  await check('Sling (SMS, notifications)', ['SLING_API_TOKEN'], async () => {
    const base = env('SLING_BASE_URL') || 'https://app.sling.com.ng/api/v2';
    const j = await json(await fetch(`${base}/balance`, {
      headers: { Authorization: `Bearer ${env('SLING_API_TOKEN')}`, Accept: 'application/json' }, signal: timeout(),
    }), 'balance');
    const d = (j.data as Record<string, unknown> | undefined) ?? j;
    const balance = d.balance ?? d.units;
    const currency = String(d.currency ?? '').replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)));
    return `token accepted; balance ${balance ?? 'not in response'} ${currency}`.trim()
      + `${env('SLING_WEBHOOK_SECRET') ? '' : '; SLING_WEBHOOK_SECRET is not set (delivery receipts are refused in production)'}`;
  });

  await check('Prembly (KYC/KYB)', ['PREMBLY_SECRET_KEY|PREMBLY_API_KEY'], async () => {
    const environment = env('PREMBLY_ENVIRONMENT') || 'sandbox';
    if (environment !== 'live') return 'sandbox: wallet endpoint is live-only; verification not tested';
    const base = (env('PREMBLY_BASE_URL') || 'https://api.prembly.com').replace(/\/$/, '');
    const res = await fetch(`${base}/api/v1/wallet/`, {
      method: 'GET', signal: timeout(),
      headers: { 'X-API-Key': env('PREMBLY_SECRET_KEY') || env('PREMBLY_API_KEY'), Accept: 'application/json' },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 || res.status === 403) throw new Error(`keys refused (HTTP ${res.status}): ${String(body.detail ?? body.message ?? '')}`);
    if (!res.ok) throw new Error(`wallet check: HTTP ${res.status}`);
    return `secret key accepted by non-billable wallet endpoint (${environment} configuration)`
      + `${env('KYC_PROVIDER') === 'prembly' ? '' : `; KYC_PROVIDER=${env('KYC_PROVIDER') || 'prembly'} (set it to prembly to use these keys)`}`;
  });

  await check('Email (SMTP relay)', ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], async () => {
    const port = Number(env('SMTP_PORT') || 465);
    const transport = nodemailer.createTransport({
      host: env('SMTP_HOST'), port, secure: (process.env.SMTP_SECURE ?? (port === 465 ? 'true' : 'false')) !== 'false',
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') }, connectionTimeout: 10_000, socketTimeout: 12_000,
    });
    await transport.verify(); // connect + authenticate only, nothing is sent
    transport.close();
    return `login accepted on port ${port}`;
  });

  await check('Gemini (campaign copy)', ['GEMINI_API_KEY'], async () => {
    const j = await json(await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': env('GEMINI_API_KEY') }, signal: timeout(),
    }), 'model list');
    const want = env('GEMINI_MODEL') || 'gemini-3.8-flash';
    const names = ((j.models as { name?: string }[] | undefined) ?? []).map((m) => String(m.name).replace(/^models\//, ''));
    return `key accepted; ${names.length} models visible; ${want} ${names.includes(want) ? 'is available' : 'is NOT in the list'}`;
  });

  await check('Mapbox (geocoding)', ['MAPBOX_ACCESS_TOKEN'], async () => {
    const j = await json(await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent('Ewet Housing, Uyo')}.json?limit=1&country=ng&access_token=${env('MAPBOX_ACCESS_TOKEN')}`, { signal: timeout() }), 'geocode');
    const f = (j.features as { place_name?: string }[] | undefined)?.[0];
    return f ? `token accepted; "Ewet Housing, Uyo" → ${f.place_name}` : 'token accepted; no result for the test address';
  });

  await check('WhatsApp Cloud API (Meta)', ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'], async () => {
    const v = env('WHATSAPP_GRAPH_VERSION') || 'v26.0';
    const j = await json(await fetch(`https://graph.facebook.com/${v}/${env('WHATSAPP_PHONE_NUMBER_ID')}?fields=display_phone_number,verified_name,quality_rating,name_status,health_status`, {
      headers: { Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}` }, signal: timeout(),
    }), 'phone number');
    const dbg = await json(await fetch(`https://graph.facebook.com/${v}/debug_token?input_token=${encodeURIComponent(env('WHATSAPP_ACCESS_TOKEN'))}&access_token=${encodeURIComponent(env('WHATSAPP_ACCESS_TOKEN'))}`, { signal: timeout() }), 'token check');
    const exp = Number((dbg.data as { expires_at?: number } | undefined)?.expires_at ?? 0);
    const hs = (j.health_status as { can_send_message?: string } | undefined)?.can_send_message;
    const ns = j.name_status ? `, name ${String(j.name_status)}${j.name_status !== 'APPROVED' ? ' (Meta 131037 blocks outbound until display name is APPROVED)' : ''}` : '';
    return `${String(j.verified_name ?? '?')} ${String(j.display_phone_number ?? '')}, quality ${String(j.quality_rating ?? '?')}${ns}${hs ? `, send ${hs}` : ''}`
      + `; token ${exp === 0 ? 'never expires' : `EXPIRES ${new Date(exp * 1000).toISOString()} (use a permanent System User token)`}`
      + `${env('WHATSAPP_APP_SECRET') ? '' : '; WHATSAPP_APP_SECRET is not set (webhooks are refused in production)'}`
      + `${/^v2[0-1]\./.test(v) ? `; ${v} is retiring, set WHATSAPP_GRAPH_VERSION=v26.0` : ''}`;
  });

  await check('WhatsApp message templates', ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BUSINESS_ACCOUNT_ID'], async () => {
    const v = env('WHATSAPP_GRAPH_VERSION') || 'v26.0';
    const j = await json(await fetch(`https://graph.facebook.com/${v}/${env('WHATSAPP_BUSINESS_ACCOUNT_ID')}/message_templates?fields=name,status&limit=100`, {
      headers: { Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}` }, signal: timeout(),
    }), 'template list');
    const list = (j.data as { name: string; status: string }[] | undefined) ?? [];
    const ours = ['kendibo_job_offer', 'kendibo_vendor_accepted', 'kendibo_request_update']
      .map((n) => `${n}: ${list.find((t) => t.name === n)?.status ?? 'not submitted'}`);
    return `${list.length} template(s) on the account; ${ours.join(', ')}`;
  });

  await check('Facebook Login (same Meta app)', ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET|WHATSAPP_APP_SECRET'], async () => {
    const v = env('WHATSAPP_GRAPH_VERSION') || 'v26.0';
    const appToken = `${env('FACEBOOK_APP_ID')}|${env('FACEBOOK_APP_SECRET') || env('WHATSAPP_APP_SECRET')}`;
    const j = await json(await fetch(`https://graph.facebook.com/${v}/${env('FACEBOOK_APP_ID')}?fields=name&access_token=${encodeURIComponent(appToken)}`, { signal: timeout() }), 'app check');
    return `app id and secret accepted (${String(j.name ?? 'app')})`;
  });

  await check('Anthropic (WhatsApp AI)', ['ANTHROPIC_API_KEY'], async () => {
    const j = await json(await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, signal: timeout(),
    }), 'model list');
    const want = env('WHATSAPP_AI_MODEL') || 'claude-opus-5-5';
    const ids = ((j.data as { id?: string }[] | undefined) ?? []).map((m) => String(m.id));
    return `key accepted; ${want} ${ids.includes(want) ? 'is available' : 'is not in the first page of models'}`;
  });

  await check('Google Maps (WhatsApp map page)', ['GOOGLE_MAPS_BROWSER_KEY'], async () =>
    'set; it is a browser key restricted to the page, so it is checked by opening /w/location, not from here');

  await check('Firebase push (FCM v1)', ['FIREBASE_SERVICE_ACCOUNT_JSON|GOOGLE_APPLICATION_CREDENTIALS'], async () => {
    if (!env('FIREBASE_SERVICE_ACCOUNT_JSON')) return 'GOOGLE_APPLICATION_CREDENTIALS path set';
    const sa = JSON.parse(env('FIREBASE_SERVICE_ACCOUNT_JSON')) as { project_id?: string; client_email?: string };
    return `service account for project ${sa.project_id ?? '?'} parses`;
  });

  await check('Google sign-in client IDs', ['GOOGLE_CLIENT_IDS'], async () => {
    const ids = env('GOOGLE_CLIENT_IDS').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !/\.apps\.googleusercontent\.com$/.test(id));
    if (bad.length) throw new Error(`${bad.length} of ${ids.length} ids are not *.apps.googleusercontent.com`);
    return `${ids.length} client id(s), format ok`;
  });

  if (env('WATCHUP_API_KEY')) skip('WatchUp (observability)', 'key set; not called, a check would post an event into the production project');
  else rows.push({ name: 'WatchUp (observability)', status: 'not set', detail: 'missing WATCHUP_API_KEY' });

  if ((env('STORAGE_DRIVER') || 'local') === 'ftp') {
    skip('Media storage (FTP)', `not exercised: FTP_SECURE=${env('FTP_SECURE') || 'false'}${env('FTP_SECURE') === 'true' ? '' : ' sends the FTP password unencrypted; switch to FTPS or S3 first'}`);
  } else {
    rows.push({ name: 'Media storage', status: 'skipped', detail: `driver ${env('STORAGE_DRIVER') || 'local'}; not exercised` });
  }
  skip('Database / Redis', `${env('DATABASE_URL') ? 'DATABASE_URL set' : 'DATABASE_URL empty'}${env('REDIS_URL') ? ', REDIS_URL set' : ', REDIS_URL empty'}; never contacted by this check`);

  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.status.toUpperCase().padEnd(8)} ${r.detail}`);
  const failed = rows.filter((r) => r.status === 'fail').length;
  console.log(`\n${rows.filter((r) => r.status === 'ok').length} ok, ${failed} failed, ${rows.filter((r) => r.status === 'not set').length} not set, ${rows.filter((r) => r.status === 'skipped').length} skipped`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(scrub(String(e)));
  process.exitCode = 1;
});
