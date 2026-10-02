export type ChannelRole = 'owner' | 'member';
export type MemberStatus = 'ACTIVE' | 'REVOKED';
export type SessionStatus = 'UNUSED' | 'CLAIMED' | 'EXPIRED';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface DeviceV2Entity {
  device_id: string;
  public_key: string; // 32-byte X25519 base64
  device_name: string;
  platform?: string;
  token_hash: string;
  fcm_token?: string;
  created_at: string;
  last_active_at: string;
}

export interface ChannelEntity {
  channel_id: string;
  channel_name: string;
  owner_device_id: string;
  current_epoch: number;
  sequence_counter: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChannelMemberEntity {
  id: string; // `${channel_id}__${device_id}`
  channel_id: string;
  device_id: string;
  device_name: string;
  public_key: string;
  role: ChannelRole;
  status: MemberStatus;
  joined_epoch: number;
  joined_at: string;
  revoked_at?: string;
  updated_at: string;
}

export interface PairingSessionEntity {
  session_id: string;
  channel_id: string;
  token: string;
  token_hash: string;
  owner_device_id: string;
  status: SessionStatus;
  created_at: string;
  expires_at: string; // 10 minutes TTL
}

export interface PairingRequestEntity {
  request_id: string;
  channel_id: string;
  session_id: string;
  requester_device_id: string;
  requester_device_name: string;
  requester_public_key: string;
  status: RequestStatus;
  created_at: string;
  responded_at?: string;
}

export interface ChannelKeyEnvelopeEntity {
  id: string; // `${channel_id}__${device_id}__${epoch}`
  channel_id: string;
  device_id: string;
  epoch: number;
  encrypted_key: string; // base64
  iv: string; // base64
  sender_ephemeral_pubkey: string; // base64
  created_at: string;
  fetched_at?: string; // stamped on the first idempotent fetch
}

export interface MessageV2Entity {
  message_id: string;
  channel_id: string;
  sequence_number: number;
  epoch: number;
  ciphertext: string;
  iv: string;
  sender_ephemeral_pubkey: string;
  sender_device_id: string;
  sent_at: string;
  created_at: string; // server_received_at
  expires_at?: string;
}
