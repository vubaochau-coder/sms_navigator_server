export interface DeviceEntity {
  device_id: string;
  token_hash: string; // SHA-256 hex digest of the raw bearer token - plaintext token is never stored
  device_name?: string;
  platform?: string;
  fcm_token?: string;
  created_at: number; // Unix timestamp in seconds
  last_active_at: number; // Unix timestamp in seconds
}

export interface PairEntity {
  pair_id: string;
  sender_device_id: string; // Device A - the only device allowed to relay OTP payloads
  sender_device_name?: string; // Device A name for Receiver UI display
  receiver_device_id?: string; // Device B - bound after successful pairing confirmation
  receiver_device_name?: string; // Device B name for Sender UI display
  is_active: boolean; // Sender toggle: true = active relay, false = paused by sender
  pairing_code_hash?: string; // SHA-256 hex digest of the 6-digit code
  pairing_code_expires_at?: number; // Unix timestamp in seconds (10 minutes TTL)
  pairing_attempts: number; // max 5 failed attempts before the code is invalidated
  fcm_token?: string; // receiver FCM token registered at confirm time
  platform?: string; // receiver platform
  created_at: number; // Unix timestamp in seconds
  paired_at?: number; // Unix timestamp in seconds
  expires_at?: number; // Unix timestamp in seconds
  last_active_at: number; // Unix timestamp in seconds
}

export type MessageStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

/**
 * Document model of the `messages` collection (doc ID = message_id).
 * Serves both the polling queue (status PENDING) and the per-day relay history.
 */
export interface MessageEntity {
  message_id: string;
  pair_id: string;
  sender_device_id: string;
  receiver_device_ids?: string[];
  encrypted_payload: string;
  iv: string;
  sent_at: number; // Unix timestamp in seconds
  relayed_at: number; // Unix timestamp in seconds
  date: string; // YYYY-MM-DD (relayed_at date, used for history queries)
  status: MessageStatus; // PENDING = waiting in polling queue, SUCCESS = fetched/pushed
  expire_at?: number; // Unix timestamp in seconds (sent_at + ttl)
  sender_device_name?: string; // for RelayHistoryResponse contract
  ttl_seconds?: number; // original payload TTL from the sender
}

export interface PairedReceiverItem {
  pair_id: string;
  receiver_device_id: string;
  device_name: string;
  platform: string;
  paired_at: number;
  last_active_at: number;
  is_active: boolean;
}

export interface PairedSenderItem {
  pair_id: string;
  sender_device_id: string;
  device_name: string;
  platform: string;
  paired_at: number;
  last_active_at: number;
  is_active: boolean; // Read-only for receiver: indicates if sender has active relay or paused it
}

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

export interface DeviceRegisterResponse {
  success: boolean;
  message: string;
  device_id: string;
  token: string;
  token_type: 'Bearer';
  created_at: number;
}

export interface DeviceFcmTokenRequest {
  fcm_token: string;
}

export interface PairInitRequest {
  pair_id?: string;
}

export interface PairInitResponse {
  success: boolean;
  message: string;
  pair_id: string;
  pairing_code: string;
  expires_at: number;
}

export interface PairConfirmRequest {
  pair_id: string;
  pairing_code?: string;
  fcm_token?: string;
  device_name?: string;
  platform?: string;
}

export interface PendingRelayMessage {
  message_id: string;
  encrypted_payload: string;
  iv: string;
  sent_at: number;
  ttl_seconds: number;
}

export interface PairStatusResponse {
  pair_id: string;
  is_paired: boolean;
  sender_device_id: string;
  receiver_device_id?: string;
  device_name?: string;
  platform?: string;
  paired_at?: number;
  expires_at?: number;
  pairing_code_expires_at?: number;
  pairing_code_expired?: boolean;
  pairing_attempts_remaining?: number;
  is_active?: boolean;
}

export interface RelayPayloadRequest {
  pair_id: string;
  message_id?: string;
  device_id?: string;
  encrypted_payload: string;
  iv: string;
  sent_at: number; // Unix timestamp in seconds
  ttl_seconds?: number;
}

export interface RelayPayloadResponse {
  success: boolean;
  message: string;
  message_id?: string;
  duplicate?: boolean;
  relayed_at: number;
}

export interface RelayHistoryRecord {
  id: string;
  pair_id: string;
  sender_device_id: string;
  sender_device_name?: string;
  encrypted_payload: string;
  iv: string;
  sent_at: number; // Unix timestamp in seconds
  relayed_at: number; // Unix timestamp in seconds
  status: 'SUCCESS' | 'QUEUED' | 'FAILED';
  message_id?: string;
}

export interface RelayHistoryResponse {
  success: boolean;
  date: string;
  count: number;
  records: RelayHistoryRecord[];
}

