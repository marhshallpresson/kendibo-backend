// Device registry — Postgres-backed (identity.device). Push targets for the
// notification channel router. Blueprint §14.
import { q } from '../../packages/database/db.js';

export interface Device { id: string; userId: string; platform: 'android' | 'ios' | 'web'; pushToken: string; channel?: string; createdAt: string }
const toDevice = (r: Record<string, unknown>): Device => ({
  id: String(r.id), userId: String(r.user_id), platform: r.platform as Device['platform'],
  pushToken: String(r.push_token), channel: (r.channel as string) ?? undefined, createdAt: String(r.created_at),
});

export const deviceService = {
  async register(userId: string, platform: Device['platform'], pushToken: string, channel?: string): Promise<Device> {
    const existing = await q<Record<string, unknown>>(`SELECT * FROM identity.device WHERE push_token=$1`, [pushToken]);
    if (existing[0]) {
      const upd = await q<Record<string, unknown>>(
        `UPDATE identity.device SET user_id=$2, channel=$3 WHERE id=$1 RETURNING *`, [String(existing[0].id), userId, channel ?? null],
      );
      return toDevice(upd[0]);
    }
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO identity.device (user_id, platform, push_token, channel) VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, platform, pushToken, channel ?? null],
    );
    return toDevice(rows[0]);
  },
  async remove(id: string): Promise<boolean> {
    const rows = await q(`DELETE FROM identity.device WHERE id=$1 RETURNING id`, [id]);
    return rows.length > 0;
  },
  async tokensFor(userId: string): Promise<string[]> {
    const rows = await q<{ push_token: string }>(`SELECT push_token FROM identity.device WHERE user_id=$1`, [userId]);
    return rows.map((r) => r.push_token);
  },
  async sessionsFor(userId: string): Promise<Device[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM identity.device WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return rows.map(toDevice);
  },
};
