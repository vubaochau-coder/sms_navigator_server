/**
 * Single source of truth for Firestore collection names and deterministic
 * document ids (SRD_DATABASE.md §3). Services import from here instead of
 * from each other, so no service has to reach into another service's module
 * just to name a collection.
 */

export const DEVICES_COLLECTION = 'devices';
export const CHANNELS_COLLECTION = 'channels';
export const CHANNEL_MEMBERS_COLLECTION = 'channel_members';
export const CHANNEL_KEY_ENVELOPES_COLLECTION = 'channel_key_envelopes';
export const CHANNEL_MESSAGES_COLLECTION = 'channel_messages';
export const PAIRING_SESSIONS_COLLECTION = 'pairing_sessions';
export const PAIRING_REQUESTS_COLLECTION = 'pairing_requests';
/** One pending-join marker per (channel, requester) — dedup guard for T1. */
export const PAIRING_PENDING_COLLECTION = 'pairing_pending';
/** Universal Opaque QR ingress pointers, keyed by sha256(code). */
export const QR_CODES_COLLECTION = 'qr_codes';

/** Document id per SRD 3.3: `{channelId}__{deviceId}` (double underscore). */
export function channelMemberDocId(channelId: string, deviceId: string): string {
  return `${channelId}__${deviceId}`;
}

/** Document id per SRD 3.6: `{channelId}__{deviceId}__{epoch}`. */
export function envelopeDocId(channelId: string, deviceId: string, epoch: number): string {
  return `${channelId}__${deviceId}__${epoch}`;
}

/** Document id per SRD 3.5b: `{channelId}__{requesterDeviceId}` (double underscore). */
export function pairingPendingDocId(channelId: string, requesterDeviceId: string): string {
  return `${channelId}__${requesterDeviceId}`;
}
