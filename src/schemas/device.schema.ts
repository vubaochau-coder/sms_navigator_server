import { z } from 'zod';

export const deviceRegisterSchema = z.object({
  device_id: z.string().min(3, 'device_id must be at least 3 characters').max(128).optional(),
  device_name: z.string().max(128).optional(),
  platform: z.enum(['android', 'ios', 'other']).optional()
});

export const deviceFcmTokenSchema = z.object({
  fcm_token: z
    .string({ required_error: 'fcm_token is required' })
    .min(10, 'fcm_token is invalid')
});
