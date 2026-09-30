import { z } from 'zod';

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
  sent_at: z
    .number({ required_error: 'sent_at timestamp is required' })
    .int()
    .positive(),
  ttl_seconds: z.number().int().positive().max(3600).default(300)
});
