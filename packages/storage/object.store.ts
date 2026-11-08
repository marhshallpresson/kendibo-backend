// Object store — provider-neutral. Drivers, one interface:
//
//   STORAGE_DRIVER=local  -> ./storage/{folder}/{quarantine,clean}/ (dev, single container)
//   STORAGE_DRIVER=ftp    -> self-hosted FTP ({FTP_BASE_DIR}/{folder}/{quarantine,clean}) — ACTIVE (ADR-001)
//   STORAGE_DRIVER=s3     -> PAUSED (ADR-001). S3-compatible code retained for a
//                            future flip, but presign refuses while paused.
//
// Delegation by need: kind -> folder (avatar->avatars, photo->photos,
// video->videos, doc->docs). Quarantine is never publicly readable.
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ftpStore, storageKey } from './ftp.store.js';

export type MediaFolder = 'avatars' | 'photos' | 'videos' | 'docs';
export type MediaKind = 'avatar' | 'photo' | 'video' | 'doc';
export const folderForKind = (kind: MediaKind): MediaFolder =>
  kind === 'avatar' ? 'avatars' : kind === 'video' ? 'videos' : kind === 'doc' ? 'docs' : 'photos';

export interface PresignedUpload { assetId: string; uploadUrl: string; maxBytes: number; }
const MAX_BYTES = 25 * 1024 * 1024;
// Job evidence videos from WhatsApp may be up to 50 MB (callers set their own per-type limits).
const HARD_MAX_BYTES = 50 * 1024 * 1024;
const DRIVER = process.env.STORAGE_DRIVER ?? 'local';
const BUCKET = process.env.STORAGE_BUCKET ?? 'kendibo-media';
const SIGN_SECRET = process.env.MEDIA_SIGN_SECRET ?? 'dev-media-secret';
const ROOT = process.env.STORAGE_ROOT ?? join(process.cwd(), 'storage');

function s3(): S3Client {
  return new S3Client({
    region: process.env.STORAGE_REGION ?? 'auto',
    endpoint: process.env.STORAGE_ENDPOINT ?? 'https://storage.pxxl.app/s3',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY ?? '',
      secretAccessKey: process.env.STORAGE_SECRET_KEY ?? '',
    },
  });
}
const qkey = (folder: string, assetId: string) => `${folder}/quarantine/${assetId}`;
const ckey = (folder: string, assetId: string) => `${folder}/clean/${assetId}`;

function localDir(folder: string, kind: 'quarantine' | 'clean'): string {
  const d = join(ROOT, folder, kind);
  mkdirSync(d, { recursive: true });
  return d;
}
function apiSign(assetId: string, exp: number): string {
  return createHmac('sha256', SIGN_SECRET).update(`${assetId}.${exp}`).digest('hex');
}
/** API-signed GET path served by GET /v1/media/:id/file (local + ftp drivers). */
function apiSignedUrl(assetId: string, ttlSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `/v1/media/${assetId}/file?exp=${exp}&sig=${apiSign(assetId, exp)}`;
}

const paused = (): never => { throw new Error('STORAGE_PAUSED'); };

export const objectStore = {
  driver: DRIVER,
  async presign(assetId: string, folder: MediaFolder = 'photos', ttlSec = 900): Promise<PresignedUpload> {
    if (DRIVER === 's3') paused();
    void ttlSec;
    return { assetId, uploadUrl: `store://${folder}/quarantine/${assetId}`, maxBytes: MAX_BYTES };
  },
  async putQuarantine(folder: MediaFolder, assetId: string, bytes: Buffer, mime = 'image/jpeg'): Promise<void> {
    if (bytes.length > HARD_MAX_BYTES) throw new Error('FILE_TOO_LARGE');
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') { await ftpStore.putQuarantine(folder, assetId, bytes, mime); return; }
    writeFileSync(join(localDir(folder, 'quarantine'), storageKey(assetId, mime)), bytes);
  },
  async promote(folder: MediaFolder, assetId: string, mime = 'image/jpeg'): Promise<void> {
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') { await ftpStore.promote(folder, assetId, mime); return; }
    const src = join(localDir(folder, 'quarantine'), storageKey(assetId, mime));
    if (!existsSync(src)) throw new Error('NOT_UPLOADED');
    renameSync(src, join(localDir(folder, 'clean'), storageKey(assetId, mime)));
  },
  async readClean(folder: MediaFolder, assetId: string, mime = 'image/jpeg'): Promise<Buffer> {
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') return ftpStore.readClean(folder, assetId, mime);
    const p = join(localDir(folder, 'clean'), storageKey(assetId, mime));
    if (!existsSync(p)) throw new Error('NOT_FOUND');
    return readFileSync(p);
  },
  async signedUrl(assetId: string, ttlSec = 3600): Promise<string> {
    if (DRIVER === 's3') paused();
    return apiSignedUrl(assetId, ttlSec);
  },
  verifyLocalUrl(assetId: string, exp: string, sig: string): boolean {
    if (Date.now() / 1000 > Number(exp)) return false;
    try {
      const a = Buffer.from(apiSign(assetId, Number(exp)));
      const b = Buffer.from(sig);
      return a.length === b.length && a.every((v, i) => v === b[i]);
    } catch { return false; }
  },
  uploadToken(): string { return randomUUID(); },
};
