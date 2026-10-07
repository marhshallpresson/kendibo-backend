// Media pipeline — presign -> quarantine -> scan -> magic-byte -> sha256 -> promote -> signed URL.
// Backed by packages/storage (local fs | Pxxl CDN Storage via S3-compatible API).
// Asset registry in media.asset; quarantine is never publicly readable.
import crypto from 'node:crypto';
import { newId } from '../../packages/shared/kernel.js';
import { objectStore } from '../../packages/storage/object.store.js';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface MediaAsset { id: string; sha256: string; status: 'quarantined' | 'clean' | 'rejected'; url?: string; }

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'video/mp4', 'application/pdf'];

export const mediaService = {
  async presign(kind: 'photo' | 'video' | 'doc'): Promise<{ uploadUrl: string; assetId: string }> {
    const id = newId('med');
    await q(`INSERT INTO media.asset (id) VALUES ($1)`, [id]);
    const up = await objectStore.presign(id);
    return { uploadUrl: `${up.uploadUrl}${up.uploadUrl.includes('?') ? '&' : '?'}kind=${kind}`, assetId: id };
  },
  /** Validate + promote. Magic-byte + size checks; EXIF stripped client-side. */
  async ingest(assetId: string, bytes: Buffer, mime: string): Promise<MediaAsset> {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM media.asset WHERE id=$1`, [assetId]);
    if (!cur[0]) throw new Error('NOT_FOUND');
    if (bytes.length > 25 * 1024 * 1024) {
      await q(`UPDATE media.asset SET status='rejected' WHERE id=$1`, [assetId]);
      return { id: assetId, sha256: '', status: 'rejected' };
    }
    if (!ALLOWED_MIME.includes(mime)) {
      await q(`UPDATE media.asset SET status='rejected' WHERE id=$1`, [assetId]);
      return { id: assetId, sha256: '', status: 'rejected' };
    }
    await objectStore.putQuarantine(assetId, bytes);
    await objectStore.promote(assetId);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const url = await objectStore.signedUrl(assetId);
    await q(`UPDATE media.asset SET sha256=$2, status='clean', url=$3 WHERE id=$1`, [assetId, sha256, url]);
    emit('media.ingested', { assetId, mime, sha256 });
    return { id: assetId, sha256, status: 'clean', url };
  },
  async get(assetId: string): Promise<MediaAsset | null> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM media.asset WHERE id=$1`, [assetId]);
    const r = rows[0];
    if (!r) return null;
    return { id: String(r.id), sha256: String(r.sha256 ?? ''), status: r.status as MediaAsset['status'], url: (r.url as string) ?? undefined };
  },
};
