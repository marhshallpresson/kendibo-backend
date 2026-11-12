// Full service catalogue (051): landing-page groups and trades, products,
// provider-made categories that go live at once, admin merge, skills that
// enroll by category id, and the WhatsApp catalogue (groups, paging, keywords).
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { providerService } from '../modules/providers/provider.service.js';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';
import { onEmit } from '../packages/observability/emit.js';

process.env.NODE_ENV = 'test';
type Res = { statusCode: number; json: () => any; body: string };
let app: { inject: (opts: unknown) => Promise<Res>; close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  const { flushAdminAlerts } = await import('../modules/notifications/admin-alerts.service.js');
  await flushAdminAlerts().catch(() => {});
  await app?.close?.().catch(() => {});
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function provider(name: string) {
  const uid = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,$2) RETURNING id`, [`pro-${randomUUID()}@kendibo.local`, name]))[0].id);
  const p = await providerService.onboard(uid);
  return { id: p.id, token: signAccess(uid, []) };
}

describe('catalogue from the landing page', () => {
  it('lists at least 66 active categories in 8 groups, with group, kind, icon and keywords', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/categories' });
    assert.equal(res.statusCode, 200, res.body);
    const cats = res.json().data as any[];
    assert.ok(cats.length >= 66, `only ${cats.length}`);
    assert.equal(new Set(cats.map((c) => c.group)).size, 8);
    const borehole = cats.find((c) => c.id === 'borehole');
    assert.equal(borehole.name, 'Borehole Drilling, Flushing & Submersible Pump Repair');
    assert.equal(borehole.group, 'plumbing-water');
    assert.equal(borehole.groupName, 'Plumbing, Water Treatment & Borehole');
    assert.equal(borehole.kind, 'service');
    assert.equal(borehole.isNew, false);
    assert.ok(borehole.iconName);
    assert.ok(borehole.keywords.includes('borehole'));
    // The original 8 ids are kept and placed in their groups (no duplicates).
    const ac = cats.find((c) => c.id === 'ac');
    assert.equal(ac.group, 'ac-appliances');
    assert.match(ac.name, /^Air Conditioning Installation, Gas Refill & Servicing/);
    assert.ok(!cats.some((c) => c.id !== 'ac' && /Air Conditioning Installation/.test(c.name)));
    assert.equal(cats.filter((c) => c.kind === 'service').length, 58);

    const products = (await app.inject({ method: 'GET', url: '/v1/categories?kind=product' })).json().data as any[];
    assert.equal(products.length, 8);
    assert.ok(products.every((c) => c.kind === 'product' && c.group === 'home-products'));
  });

  it('GET /v1/categories/grouped returns ordered groups with their categories (public)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/categories/grouped' });
    assert.equal(res.statusCode, 200, res.body);
    const groups = res.json().data as any[];
    assert.deepEqual(groups.map((g) => g.id), ['cleaning-pest', 'electrical-power', 'plumbing-water', 'ac-appliances', 'carpentry-interior', 'building-outdoor', 'smart-security-domestic', 'home-products']);
    assert.deepEqual(groups.map((g) => g.categories.length), [12, 7, 6, 6, 10, 8, 9, 8]);
    const g = groups[0];
    for (const k of ['id', 'name', 'kind', 'iconName', 'categories']) assert.ok(k in g, `missing ${k}`);
    assert.equal(g.name, 'Cleaning, Housekeeping & Pest Control');
    assert.equal(g.categories[0].id, 'cleaning');
    assert.equal(groups[7].kind, 'product');
    const services = (await app.inject({ method: 'GET', url: '/v1/categories/grouped?kind=service' })).json().data as any[];
    assert.equal(services.length, 7);
  });

  it('GET /v1/services returns the category id (and its name separately)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/services?category=ac' });
    const svcs = res.json().data as any[];
    assert.ok(svcs.length >= 1);
    for (const s of svcs) {
      assert.equal(s.category, 'ac');
      assert.equal(s.categoryId, 'ac');
      assert.match(s.categoryName, /Air Conditioning/);
    }
    const one = (await app.inject({ method: 'GET', url: `/v1/services/${svcs[0].id}` })).json().data;
    assert.equal(one.category, 'ac');
  });
});

describe('provider-made categories', () => {
  it('a near-duplicate name gets a suggestion and creates nothing', async () => {
    const p = await provider('Eye Guard Security');
    const before = (await q(`SELECT id FROM catalog.category`)).length;
    for (const name of ['CCTV installation', 'Borehole drilling', 'Generator repair', 'AC repair']) {
      const res = await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().data.status, 'suggest', name);
      assert.ok(res.json().data.suggestion.id, name);
    }
    const res = await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name: 'cctv' } });
    assert.equal(res.json().data.suggestion.id, 'cctv');
    assert.equal((await q(`SELECT id FROM catalog.category`)).length, before);
  });

  it('"Add anyway" (force) skips similar-name suggestions but never duplicates an exact name', async () => {
    const p = await provider('Lagos Smart Locks');
    const forced = await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name: 'CCTV installation', force: true } });
    assert.equal(forced.statusCode, 200, forced.body);
    assert.notEqual(forced.json().data.status, 'suggest', 'a similar name is created when the provider insists');
    const exact = await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name: 'cctv', force: true } });
    assert.equal(exact.json().data.status, 'suggest');
    assert.equal(exact.json().data.suggestion.id, 'cctv', 'an exact existing name is always reused');
  });

  it('a new trade goes live at once, flagged new, proposer enrolled, ops alerted', async () => {
    const events: { event: string; props: Record<string, unknown> }[] = [];
    onEmit((event, props) => { if (event === 'category.provider_created') events.push({ event, props }); });
    const p = await provider('Ada Interiors');
    const res = await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name: 'Interior designer', description: 'Room styling and furniture sourcing' } });
    assert.equal(res.statusCode, 200, res.body);
    const out = res.json().data;
    assert.equal(out.live, true);
    assert.equal(out.isNew, true);
    assert.equal(out.status, 'pending', 'kept for review');
    const id = String(out.categoryId);

    const cats = (await app.inject({ method: 'GET', url: '/v1/categories' })).json().data as any[];
    const c = cats.find((x) => x.id === id);
    assert.ok(c, 'listed straight away');
    assert.equal(c.isNew, true);
    assert.equal(c.group, 'other');
    const row = (await q<Record<string, unknown>>(`SELECT created_via, added_by_provider FROM catalog.category WHERE id=$1`, [id]))[0];
    assert.equal(row.created_via, 'provider');
    assert.equal(String(row.added_by_provider), p.id);
    assert.ok((await q(`SELECT 1 FROM catalog.category_rule WHERE category_id=$1`, [id]))[0], 'has a rule');
    assert.ok((await q(`SELECT 1 FROM provider.category_enrollment WHERE provider_id=$1 AND category_id=$2`, [p.id, id]))[0], 'proposer enrolled');
    assert.equal(events.length, 1);
    assert.equal(events[0].props.categoryId, id);
    const grouped = (await app.inject({ method: 'GET', url: '/v1/categories/grouped' })).json().data as any[];
    assert.ok(grouped.find((g) => g.id === 'other')?.categories.some((x: any) => x.id === id));

    // Ops approve: kept, no longer "new".
    const { categoryRulesService } = await import('../modules/vendors/category-rules.service.js');
    const pending = await categoryRulesService.proposals('pending');
    const prop = pending.find((x) => x.resolvedCategoryId === id)!;
    const d = await categoryRulesService.decide(prop.id, 'approve', 'admin-test');
    assert.equal(d.status, 'approved');
    assert.equal((await q<{ is_new: boolean }>(`SELECT is_new FROM catalog.category WHERE id=$1`, [id]))[0].is_new, false);
  });

  it('admin merge moves offerings, requests, enrollments and skills to the target, then hides the source', async () => {
    const p = await provider('Splash Pools');
    const res = await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name: 'Fish pond maintenance', groupId: 'cleaning-pest' } });
    const out = res.json().data;
    assert.equal(out.live, true, res.body);
    assert.equal(out.groupId, 'cleaning-pest');
    const src = String(out.categoryId);
    await q(`INSERT INTO provider.offering (provider_id, category_id, name, price_kobo) VALUES ($1,$2,'Pond clean',1500000)`, [p.id, src]);
    await providerService.addSkill(p.id, src);
    const cu = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Ada') RETURNING id`, [`cust-${randomUUID()}@kendibo.local`]))[0].id);
    const { requestService } = await import('../modules/requests/request.service.js');
    const r = await requestService.create(cu, { categoryId: src, title: 'Clean my fish pond', idempotencyKey: randomUUID() });

    const { categoryRulesService } = await import('../modules/vendors/category-rules.service.js');
    const prop = (await categoryRulesService.proposals('pending')).find((x) => x.resolvedCategoryId === src)!;
    const d = await categoryRulesService.decide(prop.id, 'merge', 'admin-test', { mergeInto: 'pool-cleaning' });
    assert.equal(d.status, 'merged');
    assert.equal(d.categoryId, 'pool-cleaning');
    const off = await q<{ category_id: string }>(`SELECT category_id FROM provider.offering WHERE provider_id=$1`, [p.id]);
    assert.deepEqual(off.map((o) => o.category_id), ['pool-cleaning']);
    const req = await q<{ category_id: string }>(`SELECT category_id FROM booking.service_request WHERE id=$1`, [r.id]);
    assert.equal(req[0].category_id, 'pool-cleaning');
    const enr = await q<{ category_id: string }>(`SELECT category_id FROM provider.category_enrollment WHERE provider_id=$1`, [p.id]);
    assert.deepEqual(enr.map((e) => e.category_id), ['pool-cleaning']);
    const sk = await q<{ skill: string }>(`SELECT COALESCE(skill_tag, service_id) AS skill FROM provider.skill WHERE provider_id=$1`, [p.id]);
    assert.deepEqual(sk.map((s) => s.skill), ['pool-cleaning']);
    assert.equal((await q<{ active: boolean }>(`SELECT active FROM catalog.category WHERE id=$1`, [src]))[0].active, false);
    const cats = (await app.inject({ method: 'GET', url: '/v1/categories' })).json().data as any[];
    assert.ok(!cats.some((c) => c.id === src), 'merged source is hidden');
  });

  it('admin reject deactivates the category and hides its listings', async () => {
    const p = await provider('Odd Trade Ltd');
    const out = (await app.inject({ method: 'POST', url: '/v1/provider/categories/propose', headers: bearer(p.token), payload: { name: 'Aquarium design' } })).json().data;
    const id = String(out.categoryId);
    await q(`INSERT INTO provider.offering (provider_id, category_id, name, price_kobo) VALUES ($1,$2,'Tank setup',2000000)`, [p.id, id]);
    const { categoryRulesService } = await import('../modules/vendors/category-rules.service.js');
    const prop = (await categoryRulesService.proposals('pending')).find((x) => x.resolvedCategoryId === id)!;
    assert.equal((await categoryRulesService.decide(prop.id, 'reject', 'admin-test', { note: 'not a home service' })).status, 'rejected');
    assert.equal((await q<{ active: boolean }>(`SELECT active FROM catalog.category WHERE id=$1`, [id]))[0].active, false);
    assert.equal((await q<{ active: boolean }>(`SELECT active FROM provider.offering WHERE provider_id=$1`, [p.id]))[0].active, false);
  });
});

describe('skills enroll by category id', () => {
  it('POST /v1/provider/skills with a category id enrolls the provider in it', async () => {
    const p = await provider('Deep Water Drillers');
    const res = await app.inject({ method: 'POST', url: '/v1/provider/skills', headers: bearer(p.token), payload: { skill: 'borehole' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await q(`SELECT 1 FROM provider.category_enrollment WHERE provider_id=$1 AND category_id='borehole'`, [p.id]))[0]);
    const { categoriesForSkills, providerSkillCategories } = await import('../modules/vendors/skill-categories.js');
    assert.deepEqual(await categoriesForSkills(['hvac']), ['ac'], 'skill tags still resolve through services');
    assert.deepEqual(await categoriesForSkills(['not-a-thing']), []);
    assert.deepEqual(await providerSkillCategories(p.id), ['borehole']);
  });
});

describe('WhatsApp catalogue', () => {
  it('lists groups first, then a group\'s trades with a "More…" row past 10', async () => {
    const { tradeGroupRows, tradeCategoryPage, trades } = await import('../modules/whatsapp/flow.js');
    const all = await trades();
    assert.ok(all.length >= 58, 'no LIMIT 10 any more');
    assert.ok(!all.some((t) => t.id.startsWith('prod-')), 'products are not booked over chat');
    const groups = await tradeGroupRows();
    assert.ok(groups.length <= 10);
    assert.ok(groups.some((g) => g.id === 'flow:grp:plumbing-water'));
    assert.ok(groups.every((g) => g.title.length <= 24));

    const p0 = await tradeCategoryPage('cleaning-pest', 0);
    assert.equal(p0.rows.length, 10);
    assert.equal(p0.hasMore, true);
    assert.equal(p0.rows[9].id, 'flow:grp:cleaning-pest:1');
    assert.match(p0.rows[9].title, /More/);
    assert.equal(p0.rows[0].id, 'cat:cleaning');
    const p1 = await tradeCategoryPage('cleaning-pest', 1);
    assert.equal(p1.rows.length, 3);
    assert.equal(p1.hasMore, false);
    const seen = new Set([...p0.rows, ...p1.rows].filter((r) => r.id.startsWith('cat:')).map((r) => r.id));
    assert.equal(seen.size, 12, 'every cleaning trade reachable once');
    const small = await tradeCategoryPage('plumbing-water', 0);
    assert.equal(small.rows.length, 6);
    assert.ok(small.rows.every((r) => r.id.startsWith('cat:') && r.title.length <= 24));
  });

  it('a group tap sends that group\'s trades and a trade tap sets it', async () => {
    const { handleFlowTap } = await import('../modules/whatsapp/flow.js');
    const draft = { id: randomUUID(), category_id: null, photo_asset_ids: [] } as never;
    const r = await handleFlowTap('flow:grp:plumbing-water', { waId: '2348000000001', userId: randomUUID(), d: draft, a: {} });
    assert.equal(r.sent, true);
    const more = await handleFlowTap('flow:grp:nope', { waId: '2348000000001', userId: randomUUID(), d: draft, a: {} });
    assert.ok(!more.sent, 'unknown group falls back to re-asking');
  });

  it('detects trades from catalogue keywords, refining the lexicon within a group', async () => {
    const { resolveTrade } = await import('../modules/whatsapp/flow.js');
    const { understand } = await import('../modules/whatsapp/nlu/index.js');
    const check = async (text: string) => resolveTrade(text, await understand(text));
    assert.equal(await check('my borehole pump spoil'), 'borehole');
    assert.equal(await check('I want to install CCTV for my compound'), 'cctv');
    assert.equal(await check('my inverter battery no dey charge'), 'solar-inverter');
    assert.equal(await check('we need fumigation this weekend'), 'pest');
    assert.equal(await check('my soakaway is full'), 'septic-evacuation');
    assert.equal(await check('my roof is leaking'), 'roofing');
    assert.equal(await check('my AC dey leak water'), 'ac', 'core trades unchanged');
    assert.equal(await check('Omo my frezzer is not working'), 'appliance');
    const vague = 'I need someone to fix something in my house';
    assert.equal(await check(vague), (await understand(vague)).trade, 'no keyword: nothing added');
  });

  it('the "/" menu lists the groups and session tags derive from the id', async () => {
    const { menuText } = await import('../modules/whatsapp/commands.js');
    const { trades } = await import('../modules/whatsapp/flow.js');
    const m = menuText(await trades());
    for (const g of ['Cleaning & Pest Control', 'Plumbing & Borehole', 'Security & Home Support']) assert.ok(m.includes(g), `${g}\n${m}`);
    for (const c of ['/book', '/cleaning', '/ac', '/plumbing']) assert.ok(m.includes(c), c);
    assert.ok(m.length < 4096);
    const { tagPrefix, TAG_RE } = await import('../modules/whatsapp/sessions.js');
    assert.equal(tagPrefix('ac'), 'AC');
    assert.equal(tagPrefix('borehole'), 'BOR');
    assert.equal(tagPrefix('solar-inverter'), 'SOI');
    for (const id of ['water-tank-cleaning', 'post-construction-cleaning', 'tv-mounting', 'interior-designer']) assert.match(`${tagPrefix(id)}-1234`, TAG_RE, id);
  });
});
