// Media pipeline — presign -> quarantine -> scan -> magic-byte -> sha256 -> promote -> signed URL.
// Delegated by need: kind -> folder (avatar->avatars, photo->photos, video->videos, doc->docs),
// each with quarantine/ + clean/. Registry in media.asset; quarantine never readable.
import crypto from 'node:crypto';
import { newId } from '../../packages/shared/kernel.js';
import { objectStore, folderForKind, type MediaFolder, type MediaKind } from '../../packages/storage/object.store.js';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface MediaAsset { id: string; sha256: string; status: 'quarantined' | 'clean' | 'rejected'; url?: string; folder?: string }

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'video/mp4', 'application/pdf'];

export const mediaService = {
  async presign(kind: MediaKind): Promise<{ uploadUrl: string; assetId: string; folder: MediaFolder }> {
    const id = newId('med');
    const folder = folderForKind(kind);
    await q(`INSERT INTO media.asset (id, folder) VALUES ($1,$2)`, [id, folder]);
    const up = await objectStore.presign(id, folder);
    return { uploadUrl: `${up.uploadUrl}${up.uploadUrl.includes('?') ? '&' : '?'}kind=${kind}`, assetId: id, folder };
  },
  /** Validate + promote. Magic-byte + size checks; EXIF stripped client-side. */
  async ingest(assetId: string, bytes: Buffer, mime: string): Promise<MediaAsset> {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM media.asset WHERE id=$1`, [assetId]);
    if (!cur[0]) throw new Error('NOT_FOUND');
    const folder = (String(cur[0].folder ?? 'photos')) as MediaFolder;
    if (bytes.length > 25 * 1024 * 1024) {
      await q(`UPDATE media.asset SET status='rejected' WHERE id=$1`, [assetId]);
      return { id: assetId, sha256: '', status: 'rejected', folder };
    }
    if (!ALLOWED_MIME.includes(mime)) {
      await q(`UPDATE media.asset SET status='rejected' WHERE id=$1`, [assetId]);
      return { id: assetId, sha256: '', status: 'rejected', folder };
    }
    await objectStore.putQuarantine(folder, assetId, bytes);
    await objectStore.promote(folder, assetId);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const url = await objectStore.signedUrl(assetId);
    await q(`UPDATE media.asset SET sha256=$2, status='clean', url=$3 WHERE id=$1`, [assetId, sha256, url]);
    emit('media.ingested', { assetId, mime, sha256, folder });
    return { id: assetId, sha256, status: 'clean', url, folder };
  },
  async get(assetId: string): Promise<MediaAsset | null> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM media.asset WHERE id=$1`, [assetId]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id), sha256: String(r.sha256 ?? ''), status: r.status as MediaAsset['status'],
      url: (r.url as string) ?? undefined, folder: r.folder ? String(r.folder) : undefined,
    };
  },
  /** Serve path: reads from the asset's own folder (local or FTP). */
  async readAsset(assetId: string): Promise<Buffer> {
    const a = await this.get(assetId);
    if (!a || a.status !== 'clean') throw new Error('NOT_FOUND');
    return objectStore.readClean((a.folder ?? 'photos') as MediaFolder, assetId);
  },
};
