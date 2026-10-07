/**
 * Entity types for the Channel 1-to-N E2EE architecture.
 * Source of truth: SRD_DATABASE.md v1.6 + SERVER_API_SPEC.md v1.5.
 */

export const KEK_ALG = 'X25519-ECDH-HKDF-SHA256/AES-256-GCM' as const;

export type ChannelRole = 'OWNER' | 'MEMBER';
export type MemberStatus = 'ACTIVE' | 'REVOKED';
export type ChannelStatus = 'ACTIVE' | 'ARCHIVED';
export type SessionStatus = 'UNUSED' | 'CLAIMED' | 'EXPIRED';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** SRD 3.1 — devices/{deviceId}. */
export interface DeviceV2Entity {
  device_id: string;
  device_token_hash: string; // SHA-256 of the raw bearer token
  device_name: string;
  platform: 'android' | 'ios';
  public_key: string; // base64 X25519, set once per install (SRD 3.1)
  fcm_token?: string;
  registered_at: string;
  last_seen_at?: string;
}

/** SRD 3.2 — channels/{channelId}. */
export interface ChannelEntity {
  channel_id: string;
  owner_device_id: string;
  name: string;
  current_epoch: number; // = 1 at create; advances only via T0/T2/T4 (KL5)
  membership_version: number; // = 1 at create; +1 per membership mutation
  sequence_counter: number; // starts at 0; atomic increment on accept (N6)
  member_count: number; // denormalized; source of truth is channel_members
  status: ChannelStatus;
  created_at: string;
  updated_at: string;
}

/** SRD 3.3 — channel_members/{channelId}__{deviceId}. */
export interface ChannelMemberEntity {
  channel_id: string;
  device_id: string;
  device_name: string; // display copy, fan-out on rename (API spec §3.3)
  public_key: string; // identity key at approval time
  status: MemberStatus;
  joined_epoch: number; // epoch of first provisioning (T2: = new_epoch)
  provisioned_epoch: number; // highest epoch provisioned an envelope for
  joined_at: string;
  revoked_at?: string;
}

/** SRD 3.4 — pairing_sessions/{sessionId} (QR single-use, TTL 10 min). */
export interface PairingSessionEntity {
  session_id: string;
  channel_id: string;
  pairing_token_hash: string; // SHA-256 of the raw 128-bit pairing token
  status: SessionStatus;
  claimed_by_device_id?: string;
  request_id?: string;
  expires_at: string;
  created_at: string;
}

/** SRD 3.5 — pairing_requests/{requestId}. */
export interface PairingRequestEntity {
  request_id: string;
  channel_id: string;
  session_id: string;
  requester_device_id: string;
  requester_device_name: string;
  requester_public_key: string;
  owner_device_name?: string;
  status: RequestStatus;
  decided_by?: string;
  decided_at?: string;
  created_at: string;
  terminal_at?: string;
}

/** SRD 3.6 — channel_key_envelopes/{channelId}__{deviceId}__{epoch}. */
export interface ChannelKeyEnvelopeEntity {
  channel_id: string;
  device_id: string; // includes the Owner (self-envelope, KL4)
  key_epoch: number;
  wrapped_key: string; // base64: AES-256-GCM(CK, KEK_B, nonce, env AAD)
  nonce: string; // base64, 12 bytes
  kek_alg: string;
  created_at: string;
  fetched_at?: string; // stamped on first idempotent fetch
}

/** SRD 3.7 — channel_messages/{messageId}. */
export interface ChannelMessageEntity {
  message_id: string;
  channel_id: string;
  sequence_number: number; // server-assigned, unique per channel (N6)
  ciphertext: string; // base64: AES-256-GCM(plaintext, CK_epoch, msg AAD)
  nonce: string; // base64, 12 bytes
  key_epoch: number; // must equal channels.current_epoch at accept (KL7)
  sender_device_id: string; // == owner_device_id in v1
  sent_at: string; // device A clock
  server_received_at: string; // retention 30 days
}

/** Package Pattern schema (API spec §8). */
export interface PackageEnvelopeInput {
  device_id: string;
  key_epoch: number;
  wrapped_key: string;
  nonce: string;
  kek_alg: string;
}

export interface PackageInput {
  base_epoch: number;
  base_membership_version: number;
  envelopes: PackageEnvelopeInput[];
}
