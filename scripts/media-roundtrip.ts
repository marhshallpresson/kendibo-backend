// Pentest: multipart upload round trip against a running API.
// Usage: boot the API first, then: tsx scripts/media-roundtrip.ts
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

const BASE = process.env.PENTEST_BASE ?? 'http://localhost:3000';
const FILE = process.env.PENTEST_FILE ?? 'C:/Users/user/Projects/Homes app/kendibo-app/assets/images/avatar-1.jpg';

async function main(): Promise<void> {
  const token = jwt.sign(
    { sub: 'pentest-user', permissions: [] },
    process.env.JWT_ACCESS_SECRET || 'dev-access-INSECURE-DEV-ONLY',
    { expiresIn: '15m' },
  );
  const bytes = readFileSync(FILE);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'avatar-1.jpg');
  form.append('kind', 'photo');
  const up = await fetch(`${BASE}/v1/media/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uj = (await up.json()) as { data?: { id: string; url?: string; sha256?: string }; error?: { code: string; message: string } };
  console.log('upload:', up.status, JSON.stringify(uj.data ?? uj.error));
  if (!uj.data?.url) throw new Error('UPLOAD_FAILED');
  const fileUrl = uj.data.url.startsWith('http') ? uj.data.url : `${BASE}${uj.data.url}`;
  const dl = await fetch(fileUrl, { headers: { Authorization: `Bearer ${token}` } });
  const back = Buffer.from(await dl.arrayBuffer());
  console.log('download:', dl.status, 'bytes:', back.length, 'match:', back.equals(bytes));
  if (dl.status !== 200 || !back.equals(bytes)) throw new Error('ROUNDTRIP_MISMATCH');
  console.log('ROUNDTRIP_OK');
}
void main().catch((e) => { console.error('ROUNDTRIP_FAIL:', (e as Error).message); process.exitCode = 1; });
