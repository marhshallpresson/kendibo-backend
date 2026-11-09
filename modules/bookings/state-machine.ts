// COMPAT MODULE — recreated locally because the original was missing from this
// checkout (imported by modules/providers/provider.service.ts). It delegates to
// the job engine, which owns the real transition table. Replace with the
// version from marhshallpresson/kendibo-backend when the repo is synced.
import { transition as machineTransition, type JobStatus, type JobEvent } from '../job-engine/job.machine.js';

export type { JobStatus };

/** Same contract as job.machine.transition; the optional 5th argument is the
 *  client's offline-sync event id, recorded on the event for de-duplication. */
export function transition(jobId: string, from: JobStatus, to: JobStatus, actor: string, clientEventId?: string): Promise<JobEvent> {
  return machineTransition(jobId, from, to, actor, clientEventId ? { reason: `client_event:${clientEventId}`, clientEventId } : undefined);
}
