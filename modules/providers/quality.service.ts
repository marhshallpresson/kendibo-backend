// Provider verification levels (§42) + quality metrics (§43) + checklists (§49) + emergency (§50).
// All persisted: verify_level on provider.provider, metrics in provider.quality,
// completions in booking.checklist_done, emergencies in outbox + memory ref.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export type VerifyLevel = 'pending' | 'under_review' | 'verified' | 'specialist_verified' | 'suspended' | 'restricted' | 'deactivated';
export const verificationService = {
  async set(providerId: string, level: VerifyLevel, categories?: string[]) {
    await q(`UPDATE provider.provider SET verify_level=$2 WHERE id=$1`, [providerId, level]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('provider.verify',$1)`,
      [JSON.stringify({ providerId, level, categories })]);
    emit('provider.verified', { providerId, level });
    return { level, categories, at: new Date().toISOString() };
  },
  async get(providerId: string) {
    const rows = await q<{ verify_level: string }>(`SELECT verify_level FROM provider.provider WHERE id=$1`, [providerId]);
    return { level: ((rows[0]?.verify_level ?? 'pending') as VerifyLevel), at: new Date().toISOString() };
  },
  async bookable(providerId: string): Promise<boolean> {
    const l = (await this.get(providerId)).level;
    return l === 'verified' || l === 'specialist_verified';
  },
};

export interface Quality { responseRate: number; acceptanceRate: number; onTime: number; completion: number; cancellations: number; rating: number; disputes: number; warranties: number; reschedules: number }
const DEFAULTS: Quality = { responseRate: 1, acceptanceRate: 1, onTime: 1, completion: 1, cancellations: 0, rating: 5, disputes: 0, warranties: 0, reschedules: 0 };
export const qualityService = {
  async record(providerId: string, patch: Partial<Quality>): Promise<Quality> {
    const cur = await this.get(providerId);
    const next = { ...(cur ?? DEFAULTS), ...patch };
    const exists = await q(`SELECT 1 FROM provider.quality WHERE provider_id=$1`, [providerId]);
    if (exists.length === 0) {
      await q(`INSERT INTO provider.quality (provider_id, response_rate, acceptance_rate, on_time, completion, cancellations, disputes, warranties, reschedules)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [providerId, next.responseRate, next.acceptanceRate, next.onTime, next.completion, next.cancellations, next.disputes, next.warranties, next.reschedules]);
    } else {
      await q(`UPDATE provider.quality SET response_rate=$2, acceptance_rate=$3, on_time=$4, completion=$5, cancellations=$6, disputes=$7, warranties=$8, reschedules=$9 WHERE provider_id=$1`,
        [providerId, next.responseRate, next.acceptanceRate, next.onTime, next.completion, next.cancellations, next.disputes, next.warranties, next.reschedules]);
    }
    return next;
  },
  async get(providerId: string): Promise<Quality | null> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.quality WHERE provider_id=$1`, [providerId]);
    const r = rows[0];
    if (!r) return null;
    return {
      responseRate: Number(r.response_rate), acceptanceRate: Number(r.acceptance_rate), onTime: Number(r.on_time),
      completion: Number(r.completion), cancellations: Number(r.cancellations), rating: 5,
      disputes: Number(r.disputes), warranties: Number(r.warranties), reschedules: Number(r.reschedules),
    };
  },
  async penalizeReschedule(providerId: string) {
    const q0 = (await this.get(providerId)) ?? DEFAULTS;
    return this.record(providerId, { reschedules: q0.reschedules + 1, onTime: Math.max(0, q0.onTime - 0.05) });
  },
};

const CHECKLISTS: Record<string, string[]> = {
  'AC Services': ['inspect outdoor unit', 'inspect indoor unit', 'clean filters', 'inspect drain', 'inspect electrical connections', 'test cooling', 'record findings', 'capture before/after', 'customer confirmation'],
  Cleaning: ['dust surfaces', 'vacuum/mop floors', 'clean bathrooms', 'capture before/after', 'customer confirmation'],
};
export const checklistService = {
  forCategory(category: string): string[] { return CHECKLISTS[category] ?? ['perform service', 'capture evidence', 'customer confirmation']; },
  async complete(jobId: string, item: string): Promise<string[]> {
    try { await q(`INSERT INTO booking.checklist_done (job_id, item) VALUES ($1,$2)`, [jobId, item]); } catch { /* dup */ }
    return this.done(jobId);
  },
  async done(jobId: string): Promise<string[]> {
    try {
      const rows = await q<{ item: string }>(`SELECT item FROM booking.checklist_done WHERE job_id=$1`, [jobId]);
      return rows.map((r) => r.item);
    } catch { return []; }
  },
  async satisfied(jobId: string, category: string): Promise<boolean> {
    const done = new Set(await this.done(jobId));
    return this.forCategory(category).every((i) => done.has(i));
  },
};

export interface EmergencyJob { id: string; jobId: string; kind: string; escalated: boolean; createdAt: string }
export const emergencyService = {
  async create(jobId: string, kind: string): Promise<EmergencyJob> {
    const e: EmergencyJob = { id: `sos_${Date.now().toString(36)}`, jobId, kind, escalated: false, createdAt: new Date().toISOString() };
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('emergency.sos',$1)`, [JSON.stringify(e)]);
    emit('sos.triggered', { jobId, kind });
    return e;
  },
  async escalate(id: string) {
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('emergency.escalated',$1)`, [JSON.stringify({ id })]);
    return { id, escalated: true };
  },
};
