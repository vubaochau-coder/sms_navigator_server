import { z } from 'zod';
import { parseFlexibleTimestamp } from '../utils/time.js';

/**
 * Accepts an ISO 8601 string, epoch seconds or epoch milliseconds and
 * normalizes everything to an ISO 8601 UTC string, so the Android worker
 * (which still sends epoch seconds) keeps working unchanged.
 */
const sentAtSchema = z
  .union([z.number(), z.string()], { required_error: 'sent_at timestamp is required' })
  .transform((val, ctx) => {
    const ms = parseFlexibleTimestamp(val);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sent_at must be an ISO 8601 datetime or an epoch timestamp (seconds or milliseconds)'
      });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

export const relayPayloadSchema = z.object({
  pair_id: z
    .string({ required_error: 'pair_id is required' })
    .min(3, 'pair_id must be at least 3 characters'),
  message_id: z.string().min(1).max(256).optional(),
  encrypted_payload: z
    .string({ required_error: 'encrypted_payload is required' })
    .min(1, 'encrypted_payload cannot be empty'),
  iv: z
    .string({ required_error: 'iv is required' })
    .min(1, 'iv cannot be empty'),
  sent_at: sentAtSchema,
  ttl_seconds: z.number().int().positive().max(3600).default(300)
});
