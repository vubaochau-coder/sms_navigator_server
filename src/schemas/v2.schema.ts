import { z } from 'zod';

/** X25519 identity key: exactly 32 bytes once base64-decoded. */
const x25519PublicKeySchema = z.string().refine(
  (value) => {
    try {
      const buffer = Buffer.from(value, 'base64');
      return buffer.length === 32;
    } catch {
      return false;
    }
  },
  'public_key must be a 32-byte X25519 key encoded in base64'
);

const isoTimestampSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  'must be a valid ISO 8601 timestamp'
);

export const deviceRegisterV2Schema = z.object({
  public_key: x25519PublicKeySchema,
  device_name: z.string().trim().min(1).max(100).optional(),
  platform: z.enum(['android', 'ios', 'web', 'unknown']).optional().default('unknown'),
  device_id: z.string().uuid().optional()
});

export const deviceNameV2Schema = z.object({
  device_name: z.string().trim().min(1, 'device_name cannot be empty').max(100)
});

export const channelCreateSchema = z.object({
  channel_name: z.string().trim().min(1, 'channel_name cannot be empty').max(100)
});

export const channelIdQuerySchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required')
});

export const channelSessionCreateSchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required')
});

export const pairingRequestClaimSchema = z.object({
  token: z.string().min(16, 'pairing token is required'),
  encrypted_device_name: z.string().max(512).optional()
});

export const channelRequestsQuerySchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required'),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional().default('PENDING')
});

const envelopeItemSchema = z.object({
  device_id: z.string().min(1),
  encrypted_key: z.string().min(1),
  iv: z.string().min(1),
  sender_ephemeral_pubkey: z.string().min(1)
});

export const pairingApproveSchema = z.object({
  channel_id: z.string().min(1),
  request_id: z.string().min(1),
  new_epoch: z.number().int().positive(),
  envelopes: z.array(envelopeItemSchema).min(1, 'envelopes array cannot be empty')
});

export const pairingRejectSchema = z.object({
  channel_id: z.string().min(1),
  request_id: z.string().min(1)
});

export const pairingCancelSchema = z.object({
  channel_id: z.string().min(1),
  request_id: z.string().min(1)
});

export const keyEnvelopeQuerySchema = z.object({
  channel_id: z.string().min(1),
  epoch: z.coerce.number().int().positive()
});

export const messageSendV2Schema = z.object({
  channel_id: z.string().min(1),
  request_epoch: z.number().int().positive(),
  ciphertext: z.string().min(1, 'ciphertext is required'),
  iv: z.string().min(1, 'iv is required'),
  sender_ephemeral_pubkey: z.string().min(1, 'sender_ephemeral_pubkey is required'),
  sent_at: isoTimestampSchema,
  expires_at: isoTimestampSchema.optional()
});

export const messagesFetchQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  tz_offset: z.coerce.number().min(-14 * 60).max(14 * 60).optional().default(0) // minutes east of UTC
});

export const channelRevokeSchema = z.object({
  channel_id: z.string().min(1),
  target_device_ids: z.array(z.string().min(1)).min(1, 'target_device_ids must contain at least 1 device'),
  new_epoch: z.number().int().positive(),
  envelopes: z.array(envelopeItemSchema).min(1, 'envelopes array cannot be empty')
});
