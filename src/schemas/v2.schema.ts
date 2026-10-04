import { z } from 'zod';
import { KEK_ALG } from '../types/v2.js';

/** Base64 string decoding to exactly `bytes` bytes. */
const base64OfLength = (bytes: number, label: string) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    `${label} must be base64 encoding ${bytes} bytes`
  );

/** X25519 identity key: exactly 32 bytes once base64-decoded. */
const x25519PublicKeySchema = base64OfLength(32, 'public_key');

/** 12-byte AES-GCM IV (SRD 3.6/3.7 nonce). */
const gcmNonceSchema = base64OfLength(12, 'nonce');

export const deviceRegisterV2Schema = z.object({
  device_id: z.string().uuid(),
  device_name: z.string().trim().min(1).max(128),
  platform: z.enum(['android', 'ios']),
  public_key: x25519PublicKeySchema,
  fcm_token: z.string().min(1).optional()
});

export const fcmTokenV2Schema = z.object({
  fcm_token: z.string().min(1)
});

/** PUT /devices/name — max 128 chars (API spec §3.3). */
export const deviceNameV2Schema = z.object({
  device_name: z.string().trim().min(1, 'device_name cannot be empty').max(128)
});

/** One envelope of a Package Pattern (API spec §8). */
export const packageEnvelopeSchema = z.object({
  device_id: z.string().min(1),
  key_epoch: z.number().int().positive(),
  wrapped_key: z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length > 0;
      } catch {
        return false;
      }
    },
    'wrapped_key must be a base64 string'
  ),
  nonce: gcmNonceSchema,
  kek_alg: z.literal(KEK_ALG)
});

export const packageSchema = z.object({
  base_epoch: z.number().int().positive(),
  base_membership_version: z.number().int().positive(),
  // Empty/short arrays are allowed here on purpose: the envelope-set check
  // belongs to the Package Pattern validator → 422 PACKAGE_INCOMPLETE (§8.3).
  envelopes: z.array(packageEnvelopeSchema)
});

/** POST /channels — T0 Owner package (API spec §4.1).
 * `channel_id` is optional and client-generated (UUID v4): the envelope AAD
 * binds (channel, epoch, device) per KL9, so the Owner must know the channel
 * id at wrap time — before the server commits. */
export const channelCreateSchema = z.object({
  channel_id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'name cannot be empty').max(100),
  package: packageSchema
});

export const channelIdQuerySchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required')
});

export const channelSessionCreateSchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required')
});

/** POST /pairing/requests — T1 claim (API spec §5.1). */
export const pairingRequestClaimSchema = z.object({
  session_id: z.string().min(1),
  pairing_token: z.string().min(1),
  device_name: z.string().trim().min(1).max(128)
});

export const channelRequestsQuerySchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required'),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional().default('PENDING')
});

/** POST /pairing/requests/approve — T2 Owner package with rotate (§5.4). */
export const pairingApproveSchema = z.object({
  request_id: z.string().min(1),
  package: packageSchema
});

/** POST /pairing/requests/reject + /cancel — T6 (§5.5, §5.6). */
export const pairingRequestIdSchema = z.object({
  request_id: z.string().min(1)
});

/** GET /channels/key-envelope — epoch optional (mode "latest", §6.1). */
export const keyEnvelopeQuerySchema = z.object({
  channel_id: z.string().min(1, 'channel_id is required'),
  epoch: z.coerce.number().int().positive().optional()
});

/** POST /channels/messages — T5 + T3 (§6.2). */
export const messageSendV2Schema = z.object({
  channel_id: z.string().min(1),
  request_epoch: z.number().int().positive(),
  ciphertext: z.string().min(1, 'ciphertext is required'),
  nonce: gcmNonceSchema
});

/** GET /messages — day-based channel-agnostic fetch (§6.3). */
export const messagesFetchQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format'),
  tz_offset: z.coerce.number().int().min(-14 * 60).max(14 * 60).optional().default(0)
});

/** POST /channels/revoke — T4 Owner package with rotate (§4.6). */
export const channelRevokeSchema = z.object({
  channel_id: z.string().min(1),
  revoke_device_ids: z.array(z.string().min(1)).min(1, 'revoke_device_ids must contain at least 1 device'),
  package: packageSchema
});
