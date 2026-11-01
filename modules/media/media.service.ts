// Media pipeline — presign -> quarantine -> scan -> magic-byte -> sha256 -> promote -> signed URL.
// Delegated by need: kind -> folder (avatar->avatars, photo->photos, video->videos, doc->docs),
// each with quarantine/ + clean/. Registry in media.asset; quarantine never readable.
import crypto from 'node:crypto';
import { newId } from '../../packages/shared/kernel.js';
import { objectStore, folderForKind, type MediaFolder, type MediaKind } from '../../packages/storage/object.store.js';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface MediaAsset { id: string; sha256: string; status: 'quarantined' | 'clean' | 'rejected'; url?: string; folder?: string; mime?: string }

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/pdf', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'];

/**
 * Magic-byte sniff — a client-declared MIME is untrusted. Returns true when
 * the buffer actually starts with the expected format's signature.
 */
function magicBytesMatch(bytes: Buffer, mime: string): boolean {
  if (bytes.length < 8) return false;
  switch (mime) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case 'video/mp4':
      // ISO BMFF: bytes 4..7 == 'ftyp'
      return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    case 'image/webp':
      return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    case 'audio/ogg':
      return bytes.toString('ascii', 0, 4) === 'OggS';
    case 'audio/mpeg':
      return bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case 'audio/mp4':
      return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    case 'audio/aac':
      return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    case 'audio/amr':
      return bytes.toString('ascii', 0, 5) === '#!AMR';
    case 'application/pdf':
      return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    default:
      return false;
  }
}

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
    if (!ALLOWED_MIME.includes(mime) || !magicBytesMatch(bytes, mime)) {
      await q(`UPDATE media.asset SET status='rejected' WHERE id=$1`, [assetId]);
      return { id: assetId, sha256: '', status: 'rejected', folder };
    }
    await objectStore.putQuarantine(folder, assetId, bytes, mime);
    await objectStore.promote(folder, assetId, mime);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    // This URL is persisted into profile/evidence rows and served by RN <Image>
    // (which cannot attach an Authorization header), so it must outlive the
    // default 1h TTL — otherwise avatars and evidence 404 a day after upload.
    const url = await objectStore.signedUrl(assetId, 60 * 60 * 24 * 365 * 10);
    await q(`UPDATE media.asset SET sha256=$2, status='clean', url=$3, mime=$4 WHERE id=$1`, [assetId, sha256, url, mime]);
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
      mime: (r.mime as string) ?? undefined,
    };
  },
  /** Serve path: reads from the asset's own folder (local or FTP). */
  async readAsset(assetId: string): Promise<{ bytes: Buffer; mime: string }> {
    const a = await this.get(assetId);
    if (!a || a.status !== 'clean') throw new Error('NOT_FOUND');
    const mime = a.mime ?? 'image/jpeg';
    const bytes = await objectStore.readClean((a.folder ?? 'photos') as MediaFolder, assetId, mime);
    return { bytes, mime };
  },
};
