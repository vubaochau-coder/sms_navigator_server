import { z } from 'zod';

export const pairInitSchema = z.object({
  pair_id: z.string().min(3, 'pair_id must be at least 3 characters').max(128).optional()
});

export const pairConfirmSchema = z.object({
  pair_id: z
    .string({ required_error: 'pair_id is required' })
    .min(3, 'pair_id must be at least 3 characters')
    .max(128, 'pair_id too long'),
  // Optional: QR-based pairing confirms without the 6-digit code.
  // When provided (legacy flow), it must still be exactly 6 digits.
  pairing_code: z
    .string()
    .regex(/^\d{6}$/, 'pairing_code must be exactly 6 digits')
    .optional(),
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
