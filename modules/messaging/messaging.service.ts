// Messaging — Postgres-backed conversations + messages. Phone numbers stay masked.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface Message { id: string; jobId: string; from: string; body: string; at: string; read: boolean }

async function conversationFor(jobId: string): Promise<string> {
  const rows = await q<{ id: string }>(`SELECT id FROM messaging.conversation WHERE job_id=$1`, [jobId]);
  if (rows[0]) return rows[0].id;
  const ins = await q<{ id: string }>(`INSERT INTO messaging.conversation (job_id) VALUES ($1) RETURNING id`, [jobId]);
  return ins[0].id;
}

export const messagingService = {
  async send(jobId: string, from: string, body: string): Promise<Message> {
    if (body.length > 2000) throw new Error('MESSAGE_TOO_LONG');
    const conv = await conversationFor(jobId);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO messaging.message (conversation_id, job_id, sender, body) VALUES ($1,$2,$3,$4) RETURNING *`,
      [conv, jobId, from, body],
    );
    const r = rows[0];
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('message.created',$1)`,
      [JSON.stringify({ jobId, messageId: String(r.id) })]);
    const msg = { id: String(r.id), jobId, from, body, at: String(r.created_at), read: false };
    emit('message.sent', { messageId: msg.id, jobId, from });
    return msg;
  },
  async list(jobId: string, cursor?: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT m.id, m.job_id, m.sender AS "from", m.body, m.created_at AS at, m.read
       FROM messaging.message m JOIN messaging.conversation c ON c.id=m.conversation_id
       WHERE c.job_id=$1 ORDER BY m.created_at LIMIT 30`, [jobId],
    );
    void cursor;
    return { items: rows, nextCursor: null as string | null };
  },
  async markRead(jobId: string, id: string) {
    const rows = await q<Record<string, unknown>>(
      `UPDATE messaging.message SET read=TRUE WHERE id=$1 AND job_id=$2 RETURNING *`, [id, jobId],
    );
    return rows[0] ?? null;
  },
};
