export interface PairedDeviceSession {
  pairId: string;
  fcmToken: string;
  deviceName?: string;
  platform?: 'android' | 'ios' | string;
  pairedAt: number; // Unix timestamp in seconds
  expiresAt: number; // Unix timestamp in seconds
  lastActiveAt: number; // Unix timestamp in seconds
}

export interface RelayPayloadRequest {
  pair_id: string;
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
  relayed_at: number;
}

export interface PairConfirmRequest {
  pair_id: string;
  fcm_token: string;
  device_name?: string;
  platform?: string;
}

export interface PairStatusResponse {
  pair_id: string;
  is_paired: boolean;
  device_name?: string;
  platform?: string;
  paired_at?: number;
  expires_at?: number;
}
