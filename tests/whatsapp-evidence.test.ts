// Job evidence: WhatsApp photos/videos/documents and app uploads, stored with
// sha256 + mime + size, attached to the customer's request/booking, readable
// only by the parties and admins, hideable (never deletable) by admins.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

process.env.NODE_ENV = 'test';
type InjectRes = { statusCode: number; json: () => any };
let app: { inject: (opts: any) => Promise<InjectRes>; close?: () => Promise<void> };

// Fake Graph media store: id -> what Meta would serve. Mirrors the real
// client: the precheck runs on Meta's declared type/size before any download.
const graph = new Map<string, { mime: string; bytes: Buffer }>();
const jpeg = (size = 4096) => { const b = Buffer.alloc(size); b.set([0xff, 0xd8, 0xff, 0xe0], 0); return b; };

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  const { setMediaFetcher } = await import('../modules/media/evidence.service.js');
  setMediaFetcher(async (id, precheck) => {
    const f = graph.get(id);
    if (!f) return { ok: false, reason: 'unavailable' };
    const refused = precheck(f.mime, f.bytes.length);
    if (refused) return { ok: false, reason: refused, mime: f.mime };
    return { ok: true, bytes: f.bytes, mime: f.mime };
  });
});
after(async () => {
  const { setMediaFetcher } = await import('../modules/media/evidence.service.js');
  setMediaFetcher(null);
  await app?.close?.().catch(() => {});
});

const phone = () => `23481${Math.floor(1e7 + Math.random() * 8e7)}`;
const user = async (role: string, phoneNo?: string) =>
  String((await q<{ id: string }>(`INSERT INTO identity.users (email, phone, role) VALUES ($1,$2,$3) RETURNING id`,
    [`${role.toLowerCase()}-${randomUUID()}@kendibo.local`, phoneNo ? `+${phoneNo}` : null, role]))[0].id);
const auth = (id: string) => ({ authorization: `Bearer ${signAccess(id, [])}` });
const replies = async (waId: string) =>
  (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [waId])).map((r) => String(r.content));
const evidenceBy = (userId: string) => q<Record<string, unknown>>(`SELECT * FROM media.evidence WHERE uploader_user_id=$1`, [userId]);
async function inbound(from: string, type: 'image' | 'video' | 'document', mediaId: string, extra: Record<string, unknown> = {}) {
  const { handleInbound } = await import('../modules/whatsapp/whatsapp.bot.js');
  await handleInbound({ id: `wamid.${randomUUID()}`, from, type, [type]: { id: mediaId, ...extra } } as never);
}
async function openRequest(userId: string, waId: string) {
  const { requestService } = await import('../modules/requests/request.service.js');
  return requestService.create(userId, { categoryId: 'ac', title: 'AC leaking', lat: 5.0377, lng: 7.9128, contactPhone: `+${waId}`, idempotencyKey: `t_${randomUUID()}`, source: 'whatsapp' });
}

describe('WhatsApp media evidence', () => {
  it('stores an inbound photo on the open request and acknowledges it', async () => {
    const wa = phone();
    const cu = await user('CUSTOMER', wa);
    const r = await openRequest(cu, wa);
    const bytes = jpeg(8192);
    graph.set('m-photo-1', { mime: 'image/jpeg', bytes });
    await inbound(wa, 'image', 'm-photo-1', { caption: 'Water dripping here' });

    const rows = await evidenceBy(cu);
    assert.equal(rows.length, 1);
    const e = rows[0];
    assert.equal(String(e.request_id), r.id);
    assert.equal(e.stage, 'request');
    assert.equal(e.uploader_role, 'customer');
    assert.equal(e.source, 'whatsapp');
    assert.equal(e.mime, 'image/jpeg');
    assert.equal(Number(e.size_bytes), 8192);
    assert.match(String(e.sha256), /^[0-9a-f]{64}$/);
    assert.equal(e.caption, 'Water dripping here');
    const asset = await q<{ status: string }>(`SELECT status FROM media.asset WHERE id=$1`, [e.asset_id]);
    assert.equal(asset[0]?.status, 'clean');
    const said = await replies(wa);
    assert.ok(said.some((t) => t.startsWith('Got it — your photo is saved to your request for AC Services (') && t.endsWith('Send more anytime.')), said.join(' | '));
  });

  it('refuses an oversize photo and a blocked document type, kindly, and stores nothing', async () => {
    const wa = phone();
    const cu = await user('CUSTOMER', wa);
    await openRequest(cu, wa);
    graph.set('m-big', { mime: 'image/jpeg', bytes: jpeg(11 * 1024 * 1024) });
    graph.set('m-zip', { mime: 'application/zip', bytes: Buffer.from('PK\u0003\u0004 not allowed') });
    await inbound(wa, 'image', 'm-big');
    await inbound(wa, 'document', 'm-zip', { filename: 'stuff.zip' });
    assert.equal((await evidenceBy(cu)).length, 0);
    const said = await replies(wa);
    assert.ok(said.some((t) => /too big/.test(t) && /10 MB/.test(t)), said.join(' | '));
    assert.ok(said.some((t) => /PDF, JPG, PNG, HEIC, MP4 or MOV/.test(t)), said.join(' | '));
  });

  it('keeps media as pending when there is no request, then attaches it to the next request', async () => {
    const wa = phone();
    const cu = await user('CUSTOMER', wa);
    graph.set('m-video', { mime: 'video/mp4', bytes: (() => { const b = Buffer.alloc(2048); b.write('ftypisom', 4, 'ascii'); return b; })() });
    await inbound(wa, 'video', 'm-video');
    let rows = await evidenceBy(cu);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].request_id, null);
    assert.equal(rows[0].booking_id, null);
    assert.equal(rows[0].kind, 'video');
    assert.ok((await replies(wa)).some((t) => /Is this for a new request\? Tell me what you need\./.test(t)));

    const r = await openRequest(cu, wa);
    rows = await evidenceBy(cu);
    assert.equal(String(rows[0].request_id), r.id, 'pending evidence joins the new request');
  });
});

describe('evidence API', () => {
  let bookingId = '';
  let customer = '';
  let provider = '';
  let admin = '';

  before(async () => {
    customer = await user('CUSTOMER');
    provider = await user('PROVIDER');
    admin = await user('SUPER_ADMIN');
    const pid = String((await q<{ id: string }>(`INSERT INTO provider.provider (user_id, business_name) VALUES ($1,'Ewet Cool Air') RETURNING id`, [provider]))[0].id);
    const svc = await q<{ id: string }>(`SELECT id FROM catalog.service WHERE id='svc_ac_general'`);
    bookingId = String((await q<{ id: string }>(
      `INSERT INTO booking.booking (user_id, service_id, address_id, status, price_kobo, price_snapshot, scheduled_at, idempotency_key)
       VALUES ($1,$2,NULL,'CONFIRMED',1500000,'{}'::jsonb, now(), $3) RETURNING id`, [customer, String(svc[0].id), `ev_${randomUUID()}`],
    ))[0].id);
    await q(`INSERT INTO dispatch.assignment (job_id, provider_id, status) VALUES ($1,$2,'accepted')`, [bookingId, pid]);
  });

  it('lets the assigned provider add before (existing asset) and after (multipart) photos', async () => {
    const h = auth(provider);
    const presign = await app.inject({ method: 'POST', url: '/v1/media/presign', headers: h, payload: { kind: 'photo' } });
    const assetId = presign.json().data.assetId;
    const ing = await app.inject({ method: 'POST', url: `/v1/media/${assetId}/ingest`, headers: h, payload: { dataBase64: jpeg(5000).toString('base64'), mime: 'image/jpeg' } });
    assert.equal(ing.json().data.status, 'clean');

    const noStage = await app.inject({ method: 'POST', url: `/v1/jobs/${bookingId}/evidence`, headers: h, payload: { assetId } });
    assert.equal(noStage.statusCode, 400, 'stage is required for providers');
    const before = await app.inject({ method: 'POST', url: `/v1/jobs/${bookingId}/evidence`, headers: h, payload: { stage: 'before', assetId, caption: 'Unit before service' } });
    assert.equal(before.statusCode, 201, JSON.stringify(before.json()));
    assert.equal(before.json().data.stage, 'before');
    assert.equal(before.json().data.sizeBytes, 5000);

    const boundary = `----kb${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="stage"\r\n\r\nafter\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="after.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg(6000),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const after = await app.inject({ method: 'POST', url: `/v1/jobs/${bookingId}/evidence`, headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(after.statusCode, 201, JSON.stringify(after.json()));
    assert.equal(after.json().data.stage, 'after');
    assert.equal(after.json().data.uploaderRole, 'provider');

    // The customer can't post on the provider's job route.
    const wrong = await app.inject({ method: 'POST', url: `/v1/jobs/${bookingId}/evidence`, headers: auth(customer), payload: { stage: 'before', assetId } });
    assert.equal(wrong.statusCode, 403);

    const list = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/evidence`, headers: auth(customer) });
    assert.equal(list.statusCode, 200);
    const items = list.json().data as { stage: string; url: string }[];
    assert.deepEqual(items.map((i) => i.stage).sort(), ['after', 'before']);
    assert.ok(items.every((i) => /^\/v1\/media\/[^/]+\/file\?exp=\d+&sig=[0-9a-f]+$/.test(i.url)), 'short-lived signed links');
  });

  it("doesn't let a stranger read or add evidence", async () => {
    const stranger = await user('CUSTOMER');
    const read = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/evidence`, headers: auth(stranger) });
    assert.equal(read.statusCode, 403);
    const add = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/evidence`, headers: auth(stranger), payload: { assetId: 'med_x' } });
    assert.equal(add.statusCode, 403);
    const anon = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/evidence` });
    assert.equal(anon.statusCode, 401);
    const adminList = await app.inject({ method: 'GET', url: `/v1/admin/evidence?bookingId=${bookingId}`, headers: auth(stranger) });
    assert.equal(adminList.statusCode, 403);
  });

  it('admin hide keeps the row (audited) but hides it from the parties', async () => {
    const all = await app.inject({ method: 'GET', url: `/v1/admin/evidence?bookingId=${bookingId}`, headers: auth(admin) });
    assert.equal(all.statusCode, 200);
    const target = (all.json().data as { id: string; stage: string }[]).find((r) => r.stage === 'after')!;

    const byCustomer = await app.inject({ method: 'POST', url: `/v1/admin/evidence/${target.id}/hide`, headers: auth(customer), payload: { reason: 'nope' } });
    assert.equal(byCustomer.statusCode, 403);
    const noReason = await app.inject({ method: 'POST', url: `/v1/admin/evidence/${target.id}/hide`, headers: auth(admin), payload: {} });
    assert.equal(noReason.statusCode, 400);
    const hide = await app.inject({ method: 'POST', url: `/v1/admin/evidence/${target.id}/hide`, headers: auth(admin), payload: { reason: 'Shows another customer\'s address' } });
    assert.equal(hide.statusCode, 200, JSON.stringify(hide.json()));

    for (const who of [customer, provider]) {
      const seen = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/evidence`, headers: auth(who) });
      assert.deepEqual((seen.json().data as { stage: string }[]).map((r) => r.stage), ['before']);
    }
    const adminView = await app.inject({ method: 'GET', url: `/v1/admin/evidence?bookingId=${bookingId}`, headers: auth(admin) });
    const hidden = (adminView.json().data as { id: string; hiddenReason: string | null; hiddenBy: string | null }[]).find((r) => r.id === target.id)!;
    assert.equal(hidden.hiddenReason, "Shows another customer's address");
    assert.equal(hidden.hiddenBy, admin);
    assert.equal((await q(`SELECT 1 FROM media.evidence WHERE id=$1`, [target.id])).length, 1, 'never deleted');
    const audit = await q<{ action: string }>(`SELECT action FROM audit.log WHERE actor=$1 AND action='evidence.hide'`, [admin]);
    assert.equal(audit.length, 1);

    // The dispute case file lists the evidence for the booking.
    const { disputeService } = await import('../modules/disputes/trust.service.js');
    const d = await disputeService.open(bookingId, 'customer', 'poor_quality', 'Still leaking');
    const full = await disputeService.get(d.id);
    assert.equal(full?.evidence.length, 2);
  });
});
