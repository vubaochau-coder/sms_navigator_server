import { z } from 'zod';

export const pairInitSchema = z.object({
  pair_id: z.string().min(3, 'pair_id must be at least 3 characters').max(128).optional()
});

export const pairConfirmSchema = z.object({
  pair_id: z
    .string({ required_error: 'pair_id is required' })
    .min(3, 'pair_id must be at least 3 characters')
    .max(128, 'pair_id too long'),
  pairing_code: z
    .string({ required_error: 'pairing_code is required' })
    .regex(/^\d{6}$/, 'pairing_code must be exactly 6 digits'),
  fcm_token: z
    .string({ required_error: 'fcm_token is required' })
    .min(10, 'fcm_token is invalid'),
  device_name: z.string().optional(),
  platform: z.enum(['android', 'ios', 'other']).optional()
});

export const pairIdParamSchema = z.object({
  pairId: z.string().min(3).max(128)
});
