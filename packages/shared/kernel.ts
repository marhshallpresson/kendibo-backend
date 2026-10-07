// Shared kernel: UUIDv7 ids, UTC timestamps, structured errors, cursor pagination.
import { randomUUID } from 'node:crypto';

export function newId(prefix = 'id'): string {
  // UUIDv7-style: time-ordered prefix + random. Good enough until pg pgcrypto.
  return `${prefix}_${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
}
export function nowIso(): string { return new Date().toISOString(); }

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) {
    super(message);
  }
}
export function err(code: string, message: string, status = 400, retryable = false) {
  return new ApiError(code, message, status, retryable);
}

export interface Page<T> { items: T[]; nextCursor: string | null; }
export function paginate<T>(all: T[], cursor: string | undefined, limit: number, key: (t: T) => string): Page<T> {
  const start = cursor ? all.findIndex((t) => key(t) === cursor) + 1 : 0;
  const items = all.slice(Math.max(0, start), Math.max(0, start) + limit);
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === limit && last ? key(last) : null };
}
