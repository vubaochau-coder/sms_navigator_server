import { z } from 'zod';

/**
 * Device A initiates a pairing session. The server generates the pair_id and
 * the one-time pairing_key, so the request body carries only the sender's
 * X25519 public key for the ECDH handshake.
 */
export const pairInitSchema = z.object({
  sender_pubkey: z
    .string({ required_error: 'sender_pubkey is required' })
    .min(32, 'sender_pubkey is invalid')
    .max(128, 'sender_pubkey too long')
});

export const pairConfirmSchema = z.object({
  // Proof of possession: the one-time key embedded in the QR payload.
  // Without it an authenticated attacker cannot hijack the pairing slot.
  pairing_key: z
    .string({ required_error: 'pairing_key is required' })
    .min(16, 'pairing_key is invalid')
    .max(128, 'pairing_key too long'),
  // X25519 public key (base64) for the ECDH handshake - required so the
  // shared secret is never transported through the server.
  receiver_pubkey: z
    .string({ required_error: 'receiver_pubkey is required' })
    .min(32, 'receiver_pubkey is invalid')
    .max(128, 'receiver_pubkey too long'),
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
