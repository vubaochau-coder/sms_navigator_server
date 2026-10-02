import { randomUUID } from 'crypto';
import * as admin from 'firebase-admin';
import { MessageV2Entity } from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso, msToIso, dayRange } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { replayGuardService } from './replay-guard.service.js';
import { deviceService } from './device.service.js';
import { fcmService } from './fcm.service.js';
import { CHANNELS_COLLECTION, channelService } from './channel.service.js';

/**
 * v2 messages live in the `messages` collection (task spec 2.1 "messages v2").
 * Documents are distinguished from v1 relay records by the `channel_id` field;
 * v1 queries filter on `pair_id` / `relayed_at` and never collide.
 */
export const MESSAGES_V2_COLLECTION = 'messages';

/** Spec §6.3: cap 1000 tin/ngày, vượt → trả 1000 tin mới nhất + truncated. */
export const MESSAGES_DAY_CAP = 1000;

/** Firestore `in` supports max 30 values per query (SRD Q4). */
const IN_BATCH_SIZE = 30;

export interface MessageSendInput {
  channel_id: string;
  request_epoch: number;
  ciphertext: string;
  iv: string;
  sender_ephemeral_pubkey: string;
  sent_at: string;
  expires_at?: string;
}

export interface MessageSendResult {
  message_id: string;
  channel_id: string;
  sequence_number: number;
  epoch: number;
  server_received_at: string;
}

export interface FetchedMessage {
  message_id: string;
  channel_id: string;
  channel_name: string;
  sequence_number: number;
  key_epoch: number;
  epoch: number;
  ciphertext: string;
  iv: string;
  sender_ephemeral_pubkey: string;
  sender_device_id: string;
  sent_at: string;
  server_received_at: string;
}

function messageFromDocument(id: string, data: Record<string, unknown> | undefined): MessageV2Entity | null {
  if (!data || typeof data.channel_id !== 'string') return null;
  return {
    message_id: typeof data.message_id === 'string' ? data.message_id : id,
    channel_id: data.channel_id,
    sequence_number: Number(data.sequence_number ?? 0),
    epoch: Number(data.epoch ?? 0),
    ciphertext: String(data.ciphertext ?? ''),
    iv: String(data.iv ?? ''),
    sender_ephemeral_pubkey: String(data.sender_ephemeral_pubkey ?? ''),
    sender_device_id: String(data.sender_device_id ?? ''),
    sent_at: String(data.sent_at ?? nowIso()),
    created_at: String(data.created_at ?? nowIso()),
    expires_at: data.expires_at as string | undefined
  };
}

export class MessageV2Service {
  /**
   * T5 + T3 (Owner only): anti-replay first, then inside the transaction
   * verify `request_epoch == current_epoch` (KL7) and allocate the sequence
   * number atomically via `sequence_counter` increment (N6).
   */
  public async sendMessage(ownerId: string, input: MessageSendInput): Promise<MessageSendResult> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    // T5 (defense-in-depth, runs before T3): sha256(channel_id|nonce|ciphertext)
    if (replayGuardService.checkAndRecord(input.channel_id, input.iv, input.ciphertext)) {
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
      if (channelData.is_active === false) {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }
      const currentEpoch = Number(channelData.current_epoch ?? 1);
      if (input.request_epoch !== currentEpoch) {
        throw new HttpError(409, 'EPOCH_OUTDATED', `request_epoch ${input.request_epoch} does not match current_epoch ${currentEpoch}`);
      }

      const sequenceNumber = Number(channelData.sequence_counter ?? 0) + 1;
      const messageId = randomUUID();

      tx.update(channelRef, {
        sequence_counter: admin.firestore.FieldValue.increment(1),
        updated_at: serverReceivedAt
      });

      tx.set(db.collection(MESSAGES_V2_COLLECTION).doc(messageId), {
        message_id: messageId,
        channel_id: input.channel_id,
        sequence_number: sequenceNumber,
        epoch: currentEpoch,
        ciphertext: input.ciphertext,
        iv: input.iv,
        sender_ephemeral_pubkey: input.sender_ephemeral_pubkey,
        sender_device_id: ownerId,
        sent_at: input.sent_at,
        created_at: serverReceivedAt,
        ...(input.expires_at ? { expires_at: input.expires_at } : {})
      });

      return {
        message_id: messageId,
        channel_id: input.channel_id,
        sequence_number: sequenceNumber,
        epoch: currentEpoch,
        server_received_at: serverReceivedAt
      };
    });

    await this.notifyNewMessage(input.channel_id, ownerId);
    return result;
  }

  /** FCM wake-up bell to ACTIVE members (never carries ciphertext — I5). */
  private async notifyNewMessage(channelId: string, senderDeviceId: string): Promise<void> {
    try {
      const members = await channelService.listActiveMembers(channelId);
      await Promise.all(
        members
          .filter((member) => member.device_id !== senderDeviceId)
          .map(async (member) => {
            const device = await deviceService.findByDeviceId(member.device_id);
            if (!device?.fcm_token) return;
            await fcmService.sendDataNotification(device.fcm_token, {
              type: 'CHANNEL_EVENT',
              kind: 'NEW_MESSAGE',
              channel_id: channelId
            });
          })
      );
    } catch (error) {
      // Best-effort: FCM is a wake-up signal, never part of the consistency path (N8)
      // eslint-disable-next-line no-console
      console.warn('[MessageV2] Failed to send NEW_MESSAGE bells:', error);
    }
  }

  /**
   * Q2 → Q4: fetch by day, channel-agnostic, across every channel the caller
   * is an ACTIVE member of (KL12). Revoked channels are silently excluded.
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
      .collection('channel_members')
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

    const entities: MessageV2Entity[] = [];
    for (let i = 0; i < channelIds.length; i += IN_BATCH_SIZE) {
      const batch = channelIds.slice(i, i + IN_BATCH_SIZE);
      const snapshot = await db
        .collection(MESSAGES_V2_COLLECTION)
        .where('channel_id', 'in', batch)
        .where('created_at', '>=', fromIso)
        .where('created_at', '<=', toIso)
        .get();
      for (const doc of snapshot.docs) {
        const entity = messageFromDocument(doc.id, doc.data());
        if (entity) entities.push(entity);
      }
    }

    entities.sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.sequence_number - b.sequence_number
    );

    const truncated = entities.length > MESSAGES_DAY_CAP;
    const capped = truncated ? entities.slice(-MESSAGES_DAY_CAP) : entities;

    const channelNameById = new Map<string, string>();
    for (const channelId of channelIds) {
      const channel = await channelService.findChannelById(channelId);
      if (channel) channelNameById.set(channelId, channel.channel_name);
    }

    const messages: FetchedMessage[] = capped.map((entity) => ({
      message_id: entity.message_id,
      channel_id: entity.channel_id,
      channel_name: channelNameById.get(entity.channel_id) ?? '',
      sequence_number: entity.sequence_number,
      key_epoch: entity.epoch,
      epoch: entity.epoch,
      ciphertext: entity.ciphertext,
      iv: entity.iv,
      sender_ephemeral_pubkey: entity.sender_ephemeral_pubkey,
      sender_device_id: entity.sender_device_id,
      sent_at: entity.sent_at,
      server_received_at: entity.created_at
    }));

    return { date, messages, truncated };
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    const snapshot = await db.collection(MESSAGES_V2_COLLECTION).get();
    await Promise.all(
      snapshot.docs
        .filter((doc) => typeof doc.data()?.channel_id === 'string')
        .map((doc) => doc.ref.delete())
    );
  }
}

export const messageV2Service = new MessageV2Service();
