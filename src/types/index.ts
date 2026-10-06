export interface DeviceEntity {
  device_id: string;
  token_hash: string; // SHA-256 hex digest of the raw bearer token - plaintext token is never stored
  public_key?: string; // 32-byte X25519 public key (base64)
  device_name?: string;
  platform?: string;
  fcm_token?: string;
  created_at: string; // ISO 8601 UTC
  last_seen_at: string; // ISO 8601 UTC (SRD 3.1); legacy docs may still carry last_active_at
}

export interface PairEntity {
  pair_id: string;
  sender_device_id: string; // Device A - the only device allowed to relay OTP payloads
  sender_device_name?: string; // Device A name for Receiver UI display
  receiver_device_id?: string; // Device B - bound after successful pairing confirmation
  receiver_device_name?: string; // Device B name for Sender UI display
  is_active: boolean; // Sender toggle: true = active relay, false = paused by sender
  fcm_token?: string; // receiver FCM token registered at confirm time
  platform?: string; // receiver platform
  pairing_key_hash?: string; // SHA-256 hex of the QR pairing key - the plaintext key is never stored
  sender_pubkey?: string; // Device A X25519 public key (base64) for the ECDH handshake
  receiver_pubkey?: string; // Device B X25519 public key (base64) bound at confirm
  created_at: string; // ISO 8601 UTC
  paired_at?: string; // ISO 8601 UTC
  expires_at?: string; // ISO 8601 UTC
  last_active_at: string; // ISO 8601 UTC
}

export type MessageStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

/**
 * Document model of the `messages` collection (doc ID = message_id).
 * Serves both the polling queue (status PENDING) and the per-range relay history.
 */
export interface MessageEntity {
  message_id: string;
  pair_id: string;
  sender_device_id: string;
  receiver_device_ids?: string[];
  encrypted_payload: string;
  iv: string;
  sent_at: string; // ISO 8601 UTC
  relayed_at: string; // ISO 8601 UTC
  status: MessageStatus; // PENDING = waiting in polling queue, SUCCESS = fetched/pushed
  expire_at?: string; // ISO 8601 UTC (sent_at + ttl)
  sender_device_name?: string; // for RelayHistoryRecord contract
  receiver_device_name?: string; // for RelayHistoryRecord contract
  ttl_seconds?: number; // original payload TTL from the sender
}

export interface PairedReceiverItem {
  pair_id: string;
  receiver_device_id: string;
  device_name: string;
  platform: string;
  paired_at: string; // ISO 8601 UTC
  last_active_at: string; // ISO 8601 UTC
  is_active: boolean;
}

export interface PairedSenderItem {
  pair_id: string;
  sender_device_id: string;
  device_name: string;
  platform: string;
  paired_at: string; // ISO 8601 UTC
  last_active_at: string; // ISO 8601 UTC
  is_active: boolean; // Read-only for receiver: indicates if sender has active relay or paused it
}

/* eslint-disable @typescript-eslint/no-namespace -- standard Express Request augmentation */
declare global {
  namespace Express {
    interface Request {
      device?: DeviceEntity;
    }
  }
}

export interface DeviceRegisterRequest {
  device_id?: string;
  device_name?: string;
  platform?: string;
}

export interface DeviceFcmTokenRequest {
  fcm_token: string;
}

export interface PairConfirmRequest {
  pairing_key: string; // one-time secret from the QR payload - proof of possession
  receiver_pubkey: string; // X25519 public key (base64) for the ECDH handshake
  fcm_token?: string;
  device_name?: string;
  platform?: string;
}

/** Outcome of the transactional pairing confirmation. */
export type PairConfirmOutcome =
  | { status: 'NOT_FOUND' }
  | { status: 'SELF_PAIRING_NOT_ALLOWED' }
  | { status: 'EXPIRED' }
  | { status: 'ALREADY_CONFIRMED' }
  | { status: 'CONFIRMED'; pair: PairEntity };

export interface PendingRelayMessage {
  message_id: string;
  encrypted_payload: string;
  iv: string;
  sent_at: string; // ISO 8601 UTC
  ttl_seconds: number;
}

export interface PairStatusResponse {
  pair_id: string;
  is_paired: boolean;
  sender_device_id: string;
  receiver_device_id?: string;
  device_name?: string;
  platform?: string;
  receiver_pubkey?: string; // exposed to the sender so it can complete the ECDH handshake
  paired_at?: string; // ISO 8601 UTC
  expires_at?: string; // ISO 8601 UTC
  is_active?: boolean;
}

export interface RelayPayloadRequest {
  pair_id: string;
  message_id?: string;
  encrypted_payload: string;
  iv: string;
  sent_at: string; // ISO 8601 UTC (normalized from ISO string / epoch seconds / epoch ms)
  ttl_seconds: number;
}

export interface RelayPayloadResponse {
  success: boolean;
  message: string;
  message_id?: string;
  duplicate?: boolean;
  relayed_at: string; // ISO 8601 UTC
}

export type HistoryViewerRole = 'SENDER' | 'RECEIVER';

export interface RelayHistoryRecord {
  id: string;
  pair_id: string;
  sender_device_id: string;
  sender_device_name?: string;
  receiver_device_name?: string;
  encrypted_payload: string;
  iv: string;
  sent_at: string; // ISO 8601 UTC
  relayed_at: string; // ISO 8601 UTC
  status: 'SUCCESS' | 'QUEUED' | 'FAILED';
  message_id?: string;
  viewer_role?: HistoryViewerRole;
}
