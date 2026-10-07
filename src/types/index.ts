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

/* eslint-disable @typescript-eslint/no-namespace -- standard Express Request augmentation */
declare global {
  namespace Express {
    interface Request {
      device?: DeviceEntity;
    }
  }
}
