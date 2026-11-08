// Business-event emitter — one-line domain telemetry. Fail-open by design:
// no key, no network, or a throwing client must never break the caller.
import { observability } from './watchup.adapter.js';

type Listener = (event: string, props: Record<string, unknown>) => void;
const listeners: Listener[] = [];

/** In-process subscribers (e.g. admin email alerts). A listener must never throw into the caller. */
export function onEmit(listener: Listener): void {
  if (!listeners.includes(listener)) listeners.push(listener);
}

export function emit(event: string, props?: Record<string, unknown>): void {
  try {
    observability.track(event, props);
  } catch {
    /* fail open */
  }
  for (const l of listeners) {
    try { l(event, props ?? {}); } catch { /* fail open */ }
  }
}
