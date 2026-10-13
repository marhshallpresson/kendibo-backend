// Providers — Postgres-backed. Offers live in dispatch.assignment
// (partial UNIQUE: one accepted per job). Offline sync dedupes in SQL.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface Provider { id: string; userId: string; kycStatus: string; skills: string[]; online: boolean; lat?: number; lng?: number }

async function skillsOf(id: string): Promise<string[]> {
  const rows = await q<{ service_id: string }>(
    `SELECT s.requires_skill AS service_id FROM provider.skill k JOIN catalog.service s ON s.id=k.service_id WHERE k.provider_id=$1`, [id],
  );
  void rows;
  const direct = await q<{ service_id: string }>(`SELECT service_id FROM provider.skill WHERE provider_id=$1`, [id]);
  const names = new Set<string>();
  for (const d of direct) {
    const svc = await q<{ requires_skill: string }>(`SELECT requires_skill FROM catalog.service WHERE id=$1`, [d.service_id]);
    if (svc[0]?.requires_skill) names.add(svc[0].requires_skill);
    else names.add(d.service_id);
  }
  return [...names];
}
const toProvider = async (r: Record<string, unknown>): Promise<Provider> => ({
  id: String(r.id), userId: String(r.user_id), kycStatus: String(r.kyc_status),
  skills: await skillsOf(String(r.id)), online: Boolean(r.online),
  lat: r.lat as number ?? undefined, lng: r.lng as number ?? undefined,
});

export const providerService = {
  async onboard(userId: string): Promise<Provider> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO provider.provider (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING *`, [userId],
    );
    if (rows[0]) return toProvider(rows[0]);
    return (await this.byUserId(userId))!;
  },
  async addSkill(id: string, skill: string) {
    // skill here is a requires_skill tag; link a matching service if one exists
    const svc = await q<{ id: string }>(`SELECT id FROM catalog.service WHERE requires_skill=$1 LIMIT 1`, [skill]);
    const serviceId = svc[0]?.id ?? skill;
    const exists = await q(`SELECT 1 FROM provider.skill WHERE provider_id=$1 AND service_id=$2`, [id, serviceId]);
    if (exists.length === 0) {
      try { await q(`INSERT INTO provider.skill (provider_id, service_id) VALUES ($1,$2)`, [id, serviceId]); } catch { /* lost race */ }
    }
    return this.byId(id);
  },
  async verifyKyc(id: string) {
    await q(`UPDATE provider.provider SET kyc_status='VERIFIED', verify_level='verified' WHERE id=$1`, [id]);
    return this.byId(id);
  },
  async setOnline(id: string, online: boolean, lat?: number, lng?: number) {
    const rows = await q<Record<string, unknown>>(
      `UPDATE provider.provider SET online=$2, lat=COALESCE($3,lat), lng=COALESCE($4,lng) WHERE id=$1 RETURNING *`,
      [id, online, lat ?? null, lng ?? null],
    );
    if (!rows[0]) throw new Error('NOT_FOUND');
    return toProvider(rows[0]);
  },
  async updateLocation(id: string, lat: number, lng: number) {
    await q(`UPDATE provider.provider SET lat=$2, lng=$3 WHERE id=$1`, [id, lat, lng]);
    await q(`INSERT INTO geo.provider_location (provider_id, lat, lng) VALUES ($1,$2,$3)`, [id, lat, lng]);
    return { ok: true, at: new Date().toISOString() };
  },
  async offer(jobId: string, providerId: string, expiresAt?: Date) {
    let rows = await q<Record<string, unknown>>(
      `INSERT INTO dispatch.assignment (job_id, provider_id, expires_at) VALUES ($1,$2,$3) RETURNING *`, [jobId, providerId, expiresAt ?? null],
    ).catch(() => undefined);
    if (!rows || rows.length === 0) {
      // Already assigned before (auto-dispatch or a prior declined/expired
      // offer): reactivate it. Look up by provider_id (indexed UUID) and match
      // the job in JS — pg-mem misses direct TEXT job_id lookups locally.
      const mine = await q<Record<string, unknown>>(
        `SELECT * FROM dispatch.assignment WHERE provider_id=$1`, [providerId],
      );
      const existing = mine.find((r) => String(r.job_id) === jobId);
      if (existing) {
        rows = await q<Record<string, unknown>>(
          `UPDATE dispatch.assignment SET status='offered', expires_at=$2 WHERE id=$1 RETURNING *`, [existing.id, expiresAt ?? null],
        );
      }
    }
    if (!rows || rows.length === 0) throw new Error('OFFER_FAILED');
    const r = rows[0];
    return { id: String(r.id), jobId: String(r.job_id), providerId: String(r.provider_id), status: String(r.status), createdAt: String(r.created_at), expiresAt: r.expires_at ? String(r.expires_at) : null };
  },
  async respondToOffer(offerId: string, accept: boolean) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM dispatch.assignment WHERE id=$1`, [offerId]);
    const o = rows[0];
    if (!o || String(o.status) !== 'offered') throw new Error('OFFER_GONE');
    if (accept) {
      // job_id via subselect: identical rows on real Postgres, and works around
      // pg-mem missing rows on constant/prefixed-index TEXT lookups in local dev.
      await q(`UPDATE dispatch.assignment SET status='expired' WHERE job_id=(SELECT job_id FROM dispatch.assignment WHERE id=$1) AND status='offered' AND id!=$1`, [offerId]);
      try {
        await q(`UPDATE dispatch.assignment SET status='accepted' WHERE id=$1`, [offerId]);
      } catch {
        throw new Error('OFFER_TAKEN'); // partial unique: another provider won
      }
      emit('provider.offer_accepted', { offerId, jobId: String(o.job_id), providerId: String(o.provider_id) });
      return { ...o, status: 'accepted' };
    }
    await q(`UPDATE dispatch.assignment SET status='declined' WHERE id=$1`, [offerId]);
    return { ...o, status: 'declined' };
  },
  async offersFor(providerId: string) {
    // Capped + indexed (idx_assignment_provider_status): the provider app
    // polls this every 5s — unbounded history made every poll heavier.
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM dispatch.assignment WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 50`, [providerId]);
    return rows;
  },
  async byId(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE id=$1`, [id]);
    return rows[0] ? toProvider(rows[0]) : null;
  },
  async byUserId(userId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE user_id=$1 LIMIT 1`, [userId]);
    return rows[0] ? toProvider(rows[0]) : null;
  },
  /** Storefront gallery, ordered for display. */
  async gallery(providerId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT id, asset_id, caption, position, created_at
         FROM provider.gallery WHERE provider_id=$1
        ORDER BY position ASC, created_at ASC`, [providerId],
    );
    return rows.map((r) => ({
      id: String(r.id), assetId: String(r.asset_id), caption: r.caption ? String(r.caption) : null,
      position: Number(r.position ?? 0), createdAt: String(r.created_at),
    }));
  },
  /** Attach an already-clean media asset to the gallery. Idempotent per asset. */
  async galleryAdd(providerId: string, assetId: string, caption?: string) {
    const asset = await q<Record<string, unknown>>(`SELECT status FROM media.asset WHERE id=$1`, [assetId]);
    if (!asset[0]) throw new Error('ASSET_NOT_FOUND');
    if (String(asset[0].status) !== 'clean') throw new Error('ASSET_NOT_CLEAN');
    const next = await q<{ pos: number | null }>(
      `SELECT MAX(position) AS pos FROM provider.gallery WHERE provider_id=$1`, [providerId],
    );
    const position = (next[0]?.pos ?? -1) + 1;
    try {
      await q(
        `INSERT INTO provider.gallery (provider_id, asset_id, caption, position)
         VALUES ($1,$2,$3,$4)`,
        [providerId, assetId, caption ?? null, position],
      );
    } catch {
      return { duplicate: true }; // UNIQUE (provider_id, asset_id) — already attached
    }
    return this.gallery(providerId);
  },
  async galleryRemove(providerId: string, entryId: string) {
    // Scoped by provider_id so a caller can only detach their own entries.
    const rows = await q<{ id: string }>(
      `DELETE FROM provider.gallery WHERE id=$1 AND provider_id=$2 RETURNING id`,
      [entryId, providerId],
    );
    if (rows.length === 0) throw new Error('NOT_FOUND');
    return { ok: true };
  },
  async allOnline(): Promise<Provider[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE online=TRUE`);
    return Promise.all(rows.map(toProvider));
  },
  /** Offline-first sync: idempotent per (job, clientEventId) via recorded applications. */
  async sync(commands: { clientEventId: string; command: string; jobId: string }[]) {
    // dedupe key persisted in outbox_event payload probe
    const out: { clientEventId: string; status: 'applied' | 'duplicate' | 'rejected'; reason?: string }[] = [];
    for (const c of commands) {
      const seen = await q(`SELECT id FROM outbox_event WHERE topic='offline.cmd' AND payload=$1`, [JSON.stringify({ jobId: c.jobId, clientEventId: c.clientEventId })]);
      if (seen.length > 0) { out.push({ clientEventId: c.clientEventId, status: 'duplicate' }); continue; }
      await q(`INSERT INTO outbox_event (topic, payload) VALUES ('offline.cmd',$1)`, [JSON.stringify({ jobId: c.jobId, clientEventId: c.clientEventId, command: c.command })]);
      out.push({ clientEventId: c.clientEventId, status: 'applied' });
    }
    return out;
  },
};
