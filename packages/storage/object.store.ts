// Object store — provider-neutral. Drivers, one interface:
//
//   STORAGE_DRIVER=local  -> ./storage/{quarantine,clean}/ (dev, single container)
//   STORAGE_DRIVER=ftp    -> self-hosted FTP ({FTP_BASE_DIR}/quarantine|clean) — ACTIVE (ADR-001)
//   STORAGE_DRIVER=s3     -> PAUSED (ADR-001). S3-compatible code retained for a
//                            future flip, but presign refuses while paused.
//
// Flow (all drivers): presign -> PUT bytes -> quarantine -> scan/promote ->
// signed GET. Quarantine is never publicly readable.
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ftpStore } from './ftp.store.js';

export interface PresignedUpload { assetId: string; uploadUrl: string; maxBytes: number; }
const MAX_BYTES = 25 * 1024 * 1024;
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
const qkey = (assetId: string) => `quarantine/${assetId}`;
const ckey = (assetId: string) => `clean/${assetId}`;

function localDir(kind: 'quarantine' | 'clean'): string {
  const d = join(ROOT, kind);
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
  async presign(assetId: string, ttlSec = 900): Promise<PresignedUpload> {
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') return { assetId, uploadUrl: `store://quarantine/${assetId}`, maxBytes: MAX_BYTES };
    return { assetId, uploadUrl: `store://quarantine/${assetId}`, maxBytes: MAX_BYTES };
  },
  async putQuarantine(assetId: string, bytes: Buffer): Promise<void> {
    if (bytes.length > MAX_BYTES) throw new Error('FILE_TOO_LARGE');
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') { await ftpStore.putQuarantine(assetId, bytes); return; }
    writeFileSync(join(localDir('quarantine'), assetId), bytes);
  },
  async promote(assetId: string): Promise<void> {
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') { await ftpStore.promote(assetId); return; }
    const src = join(localDir('quarantine'), assetId);
    if (!existsSync(src)) throw new Error('NOT_UPLOADED');
    renameSync(src, join(localDir('clean'), assetId));
  },
  async readClean(assetId: string): Promise<Buffer> {
    if (DRIVER === 's3') paused();
    if (DRIVER === 'ftp') return ftpStore.readClean(assetId);
    const p = join(localDir('clean'), assetId);
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
