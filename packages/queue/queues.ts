// Queue package — BullMQ on real Redis, in-process otherwise.
// REDIS_URL empty/unset (local default) -> pure memory mode: NO sockets are
// opened, so tests/CLIs exit cleanly. Set REDIS_URL (Pxxl managed Redis) for
// durable BullMQ with retries, backoff, DLQ semantics.
import { Queue, Worker, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

export type QueueName = 'critical' | 'payments' | 'dispatch' | 'notifications' | 'media' | 'analytics' | 'maintenance' | 'exports' | 'bulk';
const queues = new Map<QueueName, Queue>();
let redis: IORedis | null = null;
let redisWanted = false;
const memoryHandlers = new Map<string, (job: { name: string; data: unknown }) => Promise<void>>();

function connection(): IORedis | null {
  if (redis) return redis;
  if (!redisWanted) {
    if (!process.env.REDIS_URL) return null; // memory mode: open nothing
    redisWanted = true;
  }
  try {
    const r = new IORedis(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      retryStrategy: () => null, // fail fast; caller falls back to memory
    });
    r.on('error', () => {});
    redis = r;
    return r;
  } catch { return null; }
}

export function getQueue(name: QueueName): Queue | null {
  const c = connection();
  if (!c) return null;
  let q = queues.get(name);
  if (!q) { q = new Queue(name, { connection: c }); queues.set(name, q); }
  return q;
}

export async function enqueue(name: QueueName, jobName: string, data: unknown, opts: JobsOptions = {}) {
  const fallback = async () => {
    const h = memoryHandlers.get(`${name}:${jobName}`) ?? memoryHandlers.get(jobName);
    if (h) await h({ name: jobName, data });
    return { id: `mem_${Date.now()}` };
  };
  const q = getQueue(name);
  if (!q) return fallback();
  const idempotencyKey = (data as { idempotencyKey?: string } | null)?.idempotencyKey;
  try {
    return await q.add(jobName, data, {
      attempts: 5, backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000, jobId: idempotencyKey, ...opts,
    });
  } catch {
    return fallback(); // Redis blipped -> degrade, never hang the request
  }
}

export function registerHandler(queue: QueueName | '*', jobName: string, handler: (job: { name: string; data: unknown }) => Promise<void>) {
  memoryHandlers.set(`${queue}:${jobName}`, handler);
  const c = connection();
  if (!c || queue === '*') return;
  const q = getQueue(queue);
  if (!q) return;
  try {
    const w = new Worker(queue, async (job) => { if (job.name === jobName) await handler(job as { name: string; data: unknown }); }, { connection: c });
    w.on('error', () => {});
  } catch { /* memory mode */ }
}

/** Close sockets so CLIs/tests exit. Safe to call in memory mode. */
export async function shutdownQueues(): Promise<void> {
  for (const [, qu] of queues) { try { await qu.close(); } catch { /* ignore */ } }
  queues.clear();
  if (redis) { try { redis.disconnect(); } catch { /* ignore */ } redis = null; }
}
