// In-process payment reconciler. The BullMQ worker is not part of the production
// deployment (only the API process runs), so stuck 'pending' Paga payments are
// settled from here: every ~60s (jittered) one pass over a small batch with limited
// concurrency and per-payment backoff (see PaymentSettlement.reconcileTick). A
// Postgres advisory lock makes sure only one API process reconciles at a time.
// Off in tests; PAYMENT_RECONCILER=off disables it elsewhere.
import type { PaymentSettlement } from './settlement.js';

export interface ReconcilerOptions { enabled?: boolean; intervalMs?: number; batch?: number; concurrency?: number }

export function startPaymentReconciler(settlement: PaymentSettlement, opts: ReconcilerOptions = {}): { stop: () => void } {
  const enabled = opts.enabled ?? true;
  if (!enabled || process.env.NODE_ENV === 'test' || process.env.PAYMENT_RECONCILER === 'off') return { stop: () => {} };
  const interval = opts.intervalMs ?? Number(process.env.PAYMENT_RECONCILER_INTERVAL_MS || 60_000);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, interval * (0.85 + Math.random() * 0.3)); // jitter so replicas do not align
    timer.unref?.();
  };
  const run = async () => {
    try { await settlement.reconcileTick({ batch: opts.batch ?? 25, concurrency: opts.concurrency ?? 3 }); }
    catch (e) { console.error('[payments] reconcile pass failed:', (e as Error).message); }
    schedule();
  };
  schedule();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
