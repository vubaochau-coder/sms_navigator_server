import { z } from 'zod';

/**
 * Device A initiates a pairing session. The server generates the pair_id and
 * the one-time pairing_key, so the request body carries nothing required.
 */
export const pairInitSchema = z.object({}).passthrough();

export const pairConfirmSchema = z.object({
  // Proof of possession: the one-time key embedded in the QR payload.
  // Without it an authenticated attacker cannot hijack the pairing slot.
  pairing_key: z
    .string({ required_error: 'pairing_key is required' })
    .min(16, 'pairing_key is invalid')
    .max(128, 'pairing_key too long'),
  fcm_token: z
    .string()
    .min(5, 'fcm_token is invalid')
    .optional(),
  device_name: z.string().optional(),
  platform: z.enum(['android', 'ios', 'other']).optional()
});

export const pairIdParamSchema = z.object({
  pairId: z.string().min(3).max(128)
});
