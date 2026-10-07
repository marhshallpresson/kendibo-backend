// Business-event emitter — one-line domain telemetry. Fail-open by design:
// no key, no network, or a throwing client must never break the caller.
import { observability } from './watchup.adapter.js';

export function emit(event: string, props?: Record<string, unknown>): void {
  try {
    observability.track(event, props);
  } catch {
    /* fail open */
  }
}
