import { env } from '../config/env.js';

/**
 * Guard for destructive helpers (e.g. `clearAll`) that exist only so the test
 * suite can reset state. They must never run against production Firestore.
 */
export function assertNotProduction(operation: string): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(`${operation} is a test-only operation and is disabled in production`);
  }
}
