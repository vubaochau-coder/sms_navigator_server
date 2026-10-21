import { createHash, randomUUID } from 'crypto';
import { ChannelMessageEntity } from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso, msToIso, dayRange } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { replayGuardService } from './replay-guard.service.js';
import { deviceService } from './device.service.js';
import { fcmService } from './fcm.service.js';
import { logger } from '../utils/logger.js';
import { assertNotProduction } from '../utils/test-only.js';
import { channelService } from './channel.service.js';
import { CHANNELS_COLLECTION, CHANNEL_MEMBERS_COLLECTION, CHANNEL_MESSAGES_COLLECTION } from './collections.js';

/** SRD 3.7 — channel_messages/{messageId}. */
export { CHANNEL_MESSAGES_COLLECTION };

/** Spec §6.3: cap 1000 tin/ngày, vượt → trả 1000 tin mới nhất + truncated. */
export const MESSAGES_DAY_CAP = 1000;

/** Firestore `in` supports max 30 values per query (SRD Q4). */
const IN_BATCH_SIZE = 30;

export interface MessageSendInput {
  channel_id: string;
  request_epoch: number;
  ciphertext: string;
  nonce: string;
}

export interface MessageSendResult {
  message_id: string;
  sequence_number: number;
  server_received_at: string;
}

export interface FetchedMessage {
  channel_id: string;
  channel_name: string;
  sequence_number: number;
  key_epoch: number;
  ciphertext: string;
  nonce: string;
  sender_device_id: string;
  sent_at: string;
  server_received_at: string;
}

function messageFromDocument(data: Record<string, unknown> | undefined): ChannelMessageEntity | null {
  if (!data || typeof data.channel_id !== 'string') return null;
  return {
    message_id: String(data.message_id ?? ''),
    channel_id: data.channel_id,
    sequence_number: Number(data.sequence_number ?? 0),
    ciphertext: String(data.ciphertext ?? ''),
    nonce: String(data.nonce ?? ''),
    key_epoch: Number(data.key_epoch ?? 0),
    sender_device_id: String(data.sender_device_id ?? ''),
    sent_at: String(data.sent_at ?? ''),
    server_received_at: String(data.server_received_at ?? nowIso())
  };
}

export class MessageV2Service {
  /**
   * T5 + T3 (API spec §6.2, Owner only). Order: rate limit (middleware) →
   * T5 anti-replay sha256(channel_id|nonce|ciphertext) TTL 24h → T3 check
   * request_epoch == current_epoch (KL7) → atomic sequence_counter increment
   * → persist. Ciphertext is opaque; the server never sees keys (KL1).
   */
  public async sendMessage(ownerId: string, input: MessageSendInput): Promise<MessageSendResult> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    // T5 (defense-in-depth, runs before T3): sha256(channel_id|nonce|ciphertext)
    const replayHash = createHash('sha256')
      .update(`${input.channel_id}|${input.nonce}|${input.ciphertext}`)
      .digest('hex');
    if (replayGuardService.checkAndRecordHash(replayHash)) {
      throw new HttpError(409, 'REPLAY_DETECTED', 'This ciphertext has already been accepted within the last 24 hours');
    }

    const serverReceivedAt = nowIso();

    const result = await db.runTransaction(async (tx): Promise<MessageSendResult> => {
      const channelRef = db.collection(CHANNELS_COLLECTION).doc(input.channel_id);
      const channelDoc = await tx.get(channelRef);
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${input.channel_id} does not exist`);
      }
      const channelData = channelDoc.data() ?? {};
      if (String(channelData.owner_device_id ?? '') !== ownerId) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the channel owner can send messages');
      }
      if (channelData.status === 'ARCHIVED') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }
      const currentEpoch = Number(channelData.current_epoch ?? 1);
      if (input.request_epoch !== currentEpoch) {
        throw new HttpError(
          409,
          'EPOCH_OUTDATED',
          `request_epoch ${input.request_epoch} does not match current_epoch ${currentEpoch}`,
          { current_epoch: currentEpoch }
        );
      }

      const sequenceNumber = Number(channelData.sequence_counter ?? 0) + 1;
      const messageId = randomUUID();

      tx.update(channelRef, {
        sequence_counter: sequenceNumber,
        updated_at: serverReceivedAt
      });

      tx.set(db.collection(CHANNEL_MESSAGES_COLLECTION).doc(messageId), {
        message_id: messageId,
        channel_id: input.channel_id,
        sequence_number: sequenceNumber,
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        key_epoch: currentEpoch,
        sender_device_id: ownerId,
        sent_at: serverReceivedAt,
        server_received_at: serverReceivedAt
      });

      return {
        message_id: messageId,
        sequence_number: sequenceNumber,
        server_received_at: serverReceivedAt
      };
    });

    await this.notifyNewMessage(input.channel_id, result.sequence_number, ownerId);
    return result;
  }

  /**
   * FCM wake-up bell to ACTIVE members (never carries ciphertext or keys — I5/N8).
   *
   * Android gets a **data-only** message so the app's background handler can
   * pull the single message (`GET /channels/message`), decrypt it locally and
   * render the OTP itself. iOS (and unknown platforms) keep the notification
   * block, because the OS does not reliably wake the app for data-only pushes.
   */
  private async notifyNewMessage(channelId: string, sequenceNumber: number, senderDeviceId: string): Promise<void> {
    try {
      const members = await channelService.listActiveMembers(channelId);
      if (members.length === 0) return;

      const channel = await channelService.findChannelById(channelId);
      const channelName = channel?.name;
      const notification = {
        title: 'Tin nhắn SMS mới',
        body: channelName
          ? `Có tin nhắn SMS mới từ kênh "${channelName}". Chạm để xem.`
          : 'Có tin nhắn SMS mới vừa được chia sẻ. Chạm để xem.'
      };
      const data: Record<string, string> = {
        type: 'CHANNEL_EVENT',
        channel_id: channelId,
        ...(channelName ? { channel_name: channelName } : {}),
        kind: 'NEW_MESSAGE',
        sequence_number: String(sequenceNumber),
        sender_device_id: senderDeviceId
      };

      // One batched round of device reads instead of one per member
      const devices = await Promise.all(members.map((member) => deviceService.findByDeviceId(member.device_id)));
      await Promise.all(
        devices
          .filter((device): device is NonNullable<typeof device> => Boolean(device?.fcm_token))
          .map((device) =>
            fcmService.sendDataNotification(
              device.fcm_token!,
              data,
              device.platform === 'android' ? undefined : notification
            )
          )
      );
    } catch (error) {
      // Best-effort: FCM is a wake-up signal, never part of the consistency path (N8)
      logger.warn('[MessageV2] Failed to send NEW_MESSAGE bells:', { error: String(error) });
    }
  }

  /**
   * GET /channels/message (§6.4) — one message by (channel_id, sequence_number),
   * used by the FCM background handler to render the OTP. Authorization is
   * the same as §6.3: ACTIVE membership at query time (KL12).
   */
  public async fetchMessage(deviceId: string, channelId: string, sequenceNumber: number): Promise<FetchedMessage> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    await channelService.requireActiveMember(channelId, deviceId);

    const snapshot = await db
      .collection(CHANNEL_MESSAGES_COLLECTION)
      .where('channel_id', '==', channelId)
      .where('sequence_number', '==', sequenceNumber)
      .limit(1)
      .get();
    const entity = snapshot.docs.length > 0 ? messageFromDocument(snapshot.docs[0].data()) : null;
    if (!entity) {
      throw new HttpError(404, 'NOT_FOUND', `Message #${sequenceNumber} does not exist in this channel`);
    }

    const channel = await channelService.findChannelById(channelId);
    return {
      channel_id: entity.channel_id,
      channel_name: channel?.name ?? '',
      sequence_number: entity.sequence_number,
      key_epoch: entity.key_epoch,
      ciphertext: entity.ciphertext,
      nonce: entity.nonce,
      sender_device_id: entity.sender_device_id,
      sent_at: entity.sent_at,
      server_received_at: entity.server_received_at
    };
  }

  /**
   * Q2 → Q4 (API spec §6.3): fetch by day, channel-agnostic, across every
   * channel the caller is an ACTIVE member of (KL12). Revoked channels are
   * silently excluded. Filter boundary = `date` + `tz_offset` minutes on
   * `server_received_at`; sort descending (newest first); cap 1000 newest + truncated flag.
   */
  public async fetchMessagesByDate(
    deviceId: string,
    date: string,
    tzOffsetMinutes = 0
  ): Promise<{ date: string; messages: FetchedMessage[]; truncated: boolean }> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const range = dayRange(date, tzOffsetMinutes);
    if (!range) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'date must be a valid YYYY-MM-DD string');
    }

    const memberships = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .where('device_id', '==', deviceId)
      .where('status', '==', 'ACTIVE')
      .get();
    const channelIds = Array.from(
      new Set(memberships.docs.map((doc) => String(doc.data()?.channel_id ?? '')).filter(Boolean))
    );
    if (channelIds.length === 0) {
      return { date, messages: [], truncated: false };
    }

    const fromIso = msToIso(range.fromMs);
    const toIso = msToIso(range.toMs);

    const entities: ChannelMessageEntity[] = [];
    for (let i = 0; i < channelIds.length; i += IN_BATCH_SIZE) {
      const batch = channelIds.slice(i, i + IN_BATCH_SIZE);
      const snapshot = await db
        .collection(CHANNEL_MESSAGES_COLLECTION)
        .where('channel_id', 'in', batch)
        .where('server_received_at', '>=', fromIso)
        .where('server_received_at', '<=', toIso)
        .get();
      for (const doc of snapshot.docs) {
        const entity = messageFromDocument(doc.data());
        if (entity) entities.push(entity);
      }
    }

    entities.sort(
      (a, b) => b.server_received_at.localeCompare(a.server_received_at) || b.sequence_number - a.sequence_number
    );

    const truncated = entities.length > MESSAGES_DAY_CAP;
    const capped = truncated ? entities.slice(0, MESSAGES_DAY_CAP) : entities;

    // Batched channel-name lookup (no per-channel sequential read)
    const channelDocs = await Promise.all(channelIds.map((id) => channelService.findChannelById(id)));
    const channelNameById = new Map<string, string>();
    for (const channel of channelDocs) {
      if (channel) channelNameById.set(channel.channel_id, channel.name);
    }

    const messages: FetchedMessage[] = capped.map((entity) => ({
      channel_id: entity.channel_id,
      channel_name: channelNameById.get(entity.channel_id) ?? '',
      sequence_number: entity.sequence_number,
      key_epoch: entity.key_epoch,
      ciphertext: entity.ciphertext,
      nonce: entity.nonce,
      sender_device_id: entity.sender_device_id,
      sent_at: entity.sent_at,
      server_received_at: entity.server_received_at
    }));

    return { date, messages, truncated };
  }

  public async clearAll(): Promise<void> {
    assertNotProduction('messageV2Service.clearAll');
    const db = getFirestoreDb();
    if (!db) return;
    const snapshot = await db.collection(CHANNEL_MESSAGES_COLLECTION).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
}

export const messageV2Service = new MessageV2Service();
