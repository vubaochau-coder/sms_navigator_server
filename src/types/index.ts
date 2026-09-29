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
  receiver_device_id?: string; // Device B - bound after successful pairing code confirmation
  pairing_code_hash?: string; // SHA-256 hex digest of the 6-digit code - plaintext code is never stored
  pairing_code_expires_at?: number; // Unix timestamp in seconds (10 minutes TTL)
  pairing_attempts: number; // max 5 failed attempts before the code is invalidated
  fcm_token?: string; // receiver FCM token registered at confirm time
  device_name?: string;
  platform?: string;
  created_at: number; // Unix timestamp in seconds
  paired_at?: number; // Unix timestamp in seconds
  expires_at?: number; // Unix timestamp in seconds
  last_active_at: number; // Unix timestamp in seconds
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
  pairing_code?: string; // optional: QR-based pairing skips the 6-digit code
  fcm_token: string;
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
