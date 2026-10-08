// FTP storage driver — self-hosted media (ADR-001). Same interface as the
// local driver: quarantine/ + clean/ prefixes under FTP_BASE_DIR.
// Throws FTP_NOT_CONFIGURED when FTP_* env is absent so boot stays green and
// the failure surfaces at request time with a clear code.
import { Readable } from 'node:stream';
import { Client } from 'basic-ftp';

export interface FtpConfig {
  host: string;
  user: string;
  password: string;
  port: number;
  secure: boolean | 'implicit';
  baseDir: string;
}

export function ftpConfig(): FtpConfig | null {
  const host = process.env.FTP_HOST ?? '';
  const user = process.env.FTP_USER ?? '';
  const password = process.env.FTP_PASS ?? '';
  if (!host || !user || !password) return null;
  const port = Number(process.env.FTP_PORT ?? 21) || 21;
  const sec = String(process.env.FTP_SECURE ?? 'false').toLowerCase();
  return {
    host, user, password, port,
    secure: sec === 'implicit' ? 'implicit' : sec === 'true',
    baseDir: (process.env.FTP_BASE_DIR ?? 'kendibo-media').replace(/\\/g, '/').replace(/\/+$/, ''),
  };
}

async function withClient<T>(fn: (client: Client, cfg: FtpConfig) => Promise<T>): Promise<T> {
  const cfg = ftpConfig();
  if (!cfg) throw new Error('FTP_NOT_CONFIGURED');
  const client = new Client(5000);
  try {
    await client.access({
      host: cfg.host, user: cfg.user, password: cfg.password,
      port: cfg.port, secure: cfg.secure,
    });
    return await fn(client, cfg);
  } finally {
    client.close();
  }
}

const qkey = (folder: string, assetId: string): string => `${folder}/quarantine/${assetId}`;
const ckey = (folder: string, assetId: string): string => `${folder}/clean/${assetId}`;

export const ftpStore = {
  async putQuarantine(folder: string, assetId: string, bytes: Buffer): Promise<void> {
    await withClient(async (client, cfg) => {
      const dir = `${cfg.baseDir}/${folder}/quarantine`;
      await client.ensureDir(dir);
      await client.uploadFrom(Readable.from(bytes), `${dir}/${assetId}`);
    });
  },
  async promote(folder: string, assetId: string): Promise<void> {
    await withClient(async (client, cfg) => {
      const dir = `${cfg.baseDir}/${folder}/clean`;
      await client.ensureDir(dir);
      await client.rename(`${cfg.baseDir}/${qkey(folder, assetId)}`, `${dir}/${assetId}`);
    });
  },
  async readClean(folder: string, assetId: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await withClient(async (client, cfg) => {
      const { Writable } = await import('node:stream');
      const sink = new Writable({
        write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
      });
      await client.downloadTo(sink, `${cfg.baseDir}/${ckey(folder, assetId)}`);
    });
    return Buffer.concat(chunks);
  },
};
