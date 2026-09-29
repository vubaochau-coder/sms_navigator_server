import { z } from 'zod';

export const pairConfirmSchema = z.object({
  pair_id: z
    .string({ required_error: 'pair_id is required' })
    .min(3, 'pair_id must be at least 3 characters')
    .max(128, 'pair_id too long'),
  fcm_token: z
    .string({ required_error: 'fcm_token is required' })
    .min(10, 'fcm_token is invalid'),
  device_name: z.string().optional(),
  platform: z.enum(['android', 'ios', 'other']).optional()
});

export const pairIdParamSchema = z.object({
  pairId: z.string().min(3).max(128)
});
