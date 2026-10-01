import type * as admin from 'firebase-admin';
import {
  PairEntity,
  PendingRelayMessage,
  RelayHistoryRecord,
  MessageEntity,
  MessageStatus
} from '../types/index.js';
import { env } from '../config/env.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso, msToIso, isoToMs, toIsoString } from '../utils/time.js';

export const PAIRS_COLLECTION = 'pairs';
export const MESSAGES_COLLECTION = 'messages';

export const MESSAGE_DEDUP_TTL_SECONDS = 600; // 10 minutes
export const PENDING_MESSAGE_TTL_SECONDS = 300; // 5 minutes
export const MESSAGE_HISTORY_TTL_SECONDS = 86400; // relay history is kept for 24 hours
const STALE_PENDING_PAIR_SECONDS = 600; // unconfirmed pairs follow the QR payload's 10-minute TTL

export interface PairConfirmParams {
  receiver_device_id: string;
  fcm_token: string;
  device_name?: string;
  platform?: string;
}

function nowMs(): number {
  return Date.now();
}

function pairToDocument(pair: PairEntity): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    pair_id: pair.pair_id,
    sender_device_id: pair.sender_device_id,
    is_active: pair.is_active !== false,
    created_at: pair.created_at,
    last_active_at: pair.last_active_at
  };
  if (pair.sender_device_name !== undefined) doc.sender_device_name = pair.sender_device_name;
  if (pair.receiver_device_id !== undefined) doc.receiver_device_id = pair.receiver_device_id;
  if (pair.receiver_device_name !== undefined) doc.receiver_device_name = pair.receiver_device_name;
  if (pair.fcm_token !== undefined) doc.fcm_token = pair.fcm_token;
  if (pair.platform !== undefined) doc.platform = pair.platform;
  if (pair.paired_at !== undefined) doc.paired_at = pair.paired_at;
  if (pair.expires_at !== undefined) doc.expires_at = pair.expires_at;
  return doc;
}

function pairFromDocument(id: string, data: Record<string, unknown> | undefined): PairEntity | null {
  if (!data || typeof data.sender_device_id !== 'string') return null;
  return {
    pair_id: typeof data.pair_id === 'string' ? data.pair_id : id,
    sender_device_id: data.sender_device_id,
    sender_device_name: data.sender_device_name as string | undefined,
    receiver_device_id: data.receiver_device_id as string | undefined,
    receiver_device_name: data.receiver_device_name as string | undefined,
    is_active: data.is_active !== false,
    fcm_token: data.fcm_token as string | undefined,
    platform: data.platform as string | undefined,
    created_at: toIsoString(data.created_at),
    paired_at: data.paired_at as string | undefined,
    expires_at: data.expires_at as string | undefined,
    last_active_at: toIsoString(data.last_active_at)
  };
}

function messageFromDocument(id: string, data: Record<string, unknown> | undefined): MessageEntity | null {
  if (!data || typeof data.pair_id !== 'string') return null;
  return {
    message_id: typeof data.message_id === 'string' ? data.message_id : id,
    pair_id: data.pair_id,
    sender_device_id: typeof data.sender_device_id === 'string' ? data.sender_device_id : '',
    receiver_device_ids: Array.isArray(data.receiver_device_ids) ? (data.receiver_device_ids as string[]) : undefined,
    encrypted_payload: String(data.encrypted_payload ?? ''),
    iv: String(data.iv ?? ''),
    sent_at: toIsoString(data.sent_at),
    relayed_at: toIsoString(data.relayed_at),
    status: (data.status as MessageStatus) ?? 'PENDING',
    expire_at: data.expire_at as string | undefined,
    sender_device_name: data.sender_device_name as string | undefined,
    receiver_device_name: data.receiver_device_name as string | undefined,
    ttl_seconds: data.ttl_seconds as number | undefined
  };
}

function toHistoryRecord(entity: MessageEntity): RelayHistoryRecord {
  return {
    id: entity.message_id,
    pair_id: entity.pair_id,
    sender_device_id: entity.sender_device_id,
    sender_device_name: entity.sender_device_name,
    receiver_device_name: entity.receiver_device_name,
    encrypted_payload: entity.encrypted_payload,
    iv: entity.iv,
    sent_at: entity.sent_at,
    relayed_at: entity.relayed_at,
    status: entity.status === 'PENDING' ? 'QUEUED' : entity.status,
    message_id: entity.message_id
  };
}

export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionService {
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup once every 24 hours
    this.cleanupInterval = setInterval(() => {
      void this.cleanExpiredSessions().catch(() => undefined);
    }, CLEANUP_INTERVAL_MS);

    // Prevent interval from blocking process shutdown
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Raw pair read without expiry handling or side effects. */
  private async rawGetPair(pairId: string): Promise<PairEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const doc = await db.collection(PAIRS_COLLECTION).doc(pairId).get();
    if (!doc.exists) return null;
    return pairFromDocument(doc.id, doc.data());
  }

  private async savePair(pair: PairEntity): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    await db.collection(PAIRS_COLLECTION).doc(pair.pair_id).set(pairToDocument(pair));
  }

  public async createPair(
    pairId: string,
    senderDeviceId: string,
    senderDeviceName?: string
  ): Promise<PairEntity> {
    const now = nowIso();

    const pair: PairEntity = {
      pair_id: pairId,
      sender_device_id: senderDeviceId,
      sender_device_name: senderDeviceName,
      is_active: true,
      created_at: now,
      last_active_at: now
    };

    await this.savePair(pair);
    return pair;
  }

  public async getPairsBySender(senderDeviceId: string): Promise<PairEntity[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const now = nowMs();
    const snapshot = await db
      .collection(PAIRS_COLLECTION)
      .where('sender_device_id', '==', senderDeviceId)
      .get();

    return snapshot.docs
      .map((doc) => pairFromDocument(doc.id, doc.data()))
      .filter((pair): pair is PairEntity => {
        if (!pair) return false;
        if (!pair.receiver_device_id) return false;
        if (pair.expires_at !== undefined && isoToMs(pair.expires_at) <= now) return false;
        return true;
      })
      .sort((a, b) => isoToMs(a.created_at) - isoToMs(b.created_at));
  }

  public async getPairsByReceiver(receiverDeviceId: string): Promise<PairEntity[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const now = nowMs();
    const snapshot = await db
      .collection(PAIRS_COLLECTION)
      .where('receiver_device_id', '==', receiverDeviceId)
      .get();

    return snapshot.docs
      .map((doc) => pairFromDocument(doc.id, doc.data()))
      .filter((pair): pair is PairEntity => {
        if (!pair) return false;
        if (pair.expires_at !== undefined && isoToMs(pair.expires_at) <= now) return false;
        return true;
      })
      .sort((a, b) => isoToMs(a.created_at) - isoToMs(b.created_at));
  }

  public async setPairActive(pairId: string, isActive: boolean, senderDeviceId: string): Promise<boolean> {
    const pair = await this.getPair(pairId);
    if (!pair) return false;
    if (pair.sender_device_id !== senderDeviceId) return false;

    pair.is_active = isActive;
    pair.last_active_at = nowIso();
    await this.savePair(pair);
    return true;
  }

  public async getPair(pairId: string): Promise<PairEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const docRef = db.collection(PAIRS_COLLECTION).doc(pairId);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const pair = pairFromDocument(doc.id, doc.data());
    if (!pair) return null;

    const now = nowMs();
    const isConfirmed = Boolean(pair.receiver_device_id);
    if (isConfirmed && pair.expires_at !== undefined && isoToMs(pair.expires_at) <= now) {
      await docRef.delete();
      return null;
    }

    const lastActive = nowIso();
    pair.last_active_at = lastActive;
    await docRef.update({ last_active_at: lastActive });
    return pair;
  }

  public async confirmPairing(pairId: string, params: PairConfirmParams): Promise<PairEntity | null> {
    const pair = await this.rawGetPair(pairId);
    if (!pair) return null;

    const now = nowMs();
    pair.receiver_device_id = params.receiver_device_id;
    pair.receiver_device_name = params.device_name;
    pair.fcm_token = params.fcm_token;
    pair.platform = params.platform;
    pair.paired_at = nowIso();
    pair.expires_at = msToIso(now + env.SESSION_TTL_HOURS * 3600 * 1000);
    pair.last_active_at = nowIso();

    await this.savePair(pair);
    return pair;
  }

  public async removePair(pairId: string): Promise<boolean> {
    const db = getFirestoreDb();
    if (!db) return false;

    const docRef = db.collection(PAIRS_COLLECTION).doc(pairId);
    const doc = await docRef.get();
    const existed = doc.exists;
    if (existed) {
      await docRef.delete();
    }

    // Clear the pending polling queue of this pair (history records are kept)
    const pending = await db
      .collection(MESSAGES_COLLECTION)
      .where('pair_id', '==', pairId)
      .where('status', '==', 'PENDING')
      .get();
    await Promise.all(pending.docs.map((doc) => doc.ref.delete()));

    return existed;
  }

  public async updateReceiverFcmToken(receiverDeviceId: string, fcmToken: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const snapshot = await db
      .collection(PAIRS_COLLECTION)
      .where('receiver_device_id', '==', receiverDeviceId)
      .get();

    await Promise.all(
      snapshot.docs.map((doc) => doc.ref.update({ fcm_token: fcmToken, last_active_at: nowIso() }))
    );
  }

  public isParticipant(pair: PairEntity, deviceId: string): boolean {
    return pair.sender_device_id === deviceId || pair.receiver_device_id === deviceId;
  }

  /**
   * Deduplication: a message is "processed" while a `messages` document with
   * the same message_id exists and was relayed within the dedup TTL window.
   */
  public async isMessageProcessed(messageId: string): Promise<boolean> {
    const db = getFirestoreDb();
    if (!db) return false;

    const doc = await db.collection(MESSAGES_COLLECTION).doc(messageId).get();
    if (!doc.exists) return false;

    const relayedAtMs = isoToMs(toIsoString(doc.data()?.relayed_at));
    if (nowMs() - relayedAtMs > MESSAGE_DEDUP_TTL_SECONDS * 1000) {
      return false;
    }
    return true;
  }

  public async addPendingMessage(pairId: string, message: PendingRelayMessage): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const sentMs = isoToMs(message.sent_at);
    const ttlSeconds = message.ttl_seconds ?? PENDING_MESSAGE_TTL_SECONDS;

    const docData: Record<string, unknown> = {
      message_id: message.message_id,
      pair_id: pairId,
      encrypted_payload: message.encrypted_payload,
      iv: message.iv,
      sent_at: message.sent_at,
      relayed_at: nowIso(),
      status: 'PENDING',
      expire_at: msToIso(sentMs + ttlSeconds * 1000),
      ttl_seconds: message.ttl_seconds
    };

    await db.collection(MESSAGES_COLLECTION).doc(message.message_id).set(docData, { merge: true });
  }

  public async getAndClearPendingMessages(pairId: string): Promise<PendingRelayMessage[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const now = nowMs();
    const snapshot = await db
      .collection(MESSAGES_COLLECTION)
      .where('pair_id', '==', pairId)
      .where('status', '==', 'PENDING')
      .get();

    const alive: PendingRelayMessage[] = [];
    const markFetched: Promise<unknown>[] = [];

    for (const doc of snapshot.docs) {
      const entity = messageFromDocument(doc.id, doc.data());
      if (!entity) continue;

      // Expired pending messages are dropped from the queue (history is kept)
      if (now - isoToMs(entity.sent_at) > PENDING_MESSAGE_TTL_SECONDS * 1000) continue;

      alive.push({
        message_id: entity.message_id,
        encrypted_payload: entity.encrypted_payload,
        iv: entity.iv,
        sent_at: entity.sent_at,
        ttl_seconds:
          entity.ttl_seconds ??
          Math.max(0, Math.round((isoToMs(entity.expire_at ?? entity.sent_at) - isoToMs(entity.sent_at)) / 1000))
      });
      markFetched.push(doc.ref.update({ status: 'SUCCESS' as MessageStatus }));
    }

    await Promise.all(markFetched);
    return alive.sort((a, b) => isoToMs(a.sent_at) - isoToMs(b.sent_at));
  }

  public async cleanExpiredSessions(): Promise<number> {
    const db = getFirestoreDb();
    if (!db) return 0;

    let removedCount = 0;

    try {
      // Expired confirmed pairs (expires_at is only set after confirmation);
      // ISO 8601 UTC strings compare chronologically as plain strings
      const expired = await db.collection(PAIRS_COLLECTION).where('expires_at', '<=', nowIso()).get();
      for (const doc of expired.docs) {
        await doc.ref.delete();
        removedCount++;
      }

      // Stale pending pairs: never confirmed within the 10-minute QR window
      const stale = await db
        .collection(PAIRS_COLLECTION)
        .where('created_at', '<', msToIso(nowMs() - STALE_PENDING_PAIR_SECONDS * 1000))
        .get();
      for (const doc of stale.docs) {
        const pair = pairFromDocument(doc.id, doc.data());
        if (pair && !pair.receiver_device_id) {
          await doc.ref.delete();
          removedCount++;
        }
      }

      // Relay messages older than 24h: dedup (10 min) and history views
      // only need one day, so this bounds the `messages` collection size
      const staleMessages = await db
        .collection(MESSAGES_COLLECTION)
        .where('relayed_at', '<', msToIso(nowMs() - MESSAGE_HISTORY_TTL_SECONDS * 1000))
        .get();
      for (const doc of staleMessages.docs) {
        await doc.ref.delete();
        removedCount++;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[SessionService] Failed to clean expired sessions:', error);
    }

    return removedCount;
  }

  public async addRelayHistory(record: Omit<RelayHistoryRecord, 'status'>): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const docKey = record.message_id ?? record.id;
    const pair = await this.rawGetPair(record.pair_id);

    const docData: Record<string, unknown> = {
      message_id: docKey,
      pair_id: record.pair_id,
      sender_device_id: record.sender_device_id,
      sender_device_name: record.sender_device_name,
      encrypted_payload: record.encrypted_payload,
      iv: record.iv,
      sent_at: record.sent_at,
      relayed_at: record.relayed_at,
      // PENDING = waiting in the polling queue; flipped to SUCCESS when fetched
      status: 'PENDING' as MessageStatus
    };

    if (pair?.receiver_device_id) {
      docData.receiver_device_ids = [pair.receiver_device_id];
      if (pair.receiver_device_name) {
        docData.receiver_device_name = pair.receiver_device_name;
      }
    }

    await db.collection(MESSAGES_COLLECTION).doc(docKey).set(docData, { merge: true });
  }

  public async getRelayHistory(options: {
    fromMs: number;
    toMs: number;
    pairId?: string;
    participantDeviceId?: string;
  }): Promise<RelayHistoryRecord[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const fromIso = msToIso(options.fromMs);
    const toIso = msToIso(options.toMs);

    let query: admin.firestore.Query = db.collection(MESSAGES_COLLECTION);
    if (options.pairId) {
      query = query.where('pair_id', '==', options.pairId);
    } else {
      // ISO 8601 UTC strings compare chronologically as plain strings,
      // so a range filter works both on the mock and on real Firestore
      query = query.where('relayed_at', '>=', fromIso).where('relayed_at', '<=', toIso);
    }

    const snapshot = await query.get();
    const entities = snapshot.docs
      .map((doc) => messageFromDocument(doc.id, doc.data()))
      .filter((entity): entity is MessageEntity => entity !== null);

    // Participant security check (same semantics as the previous in-memory filter)
    const pairCache = new Map<string, PairEntity | null>();
    if (options.participantDeviceId) {
      const pairIds = Array.from(new Set(entities.map((entity) => entity.pair_id)));
      await Promise.all(
        pairIds.map(async (pairId) => {
          pairCache.set(pairId, await this.rawGetPair(pairId));
        })
      );
    }

    const records = entities
      .filter((entity) => {
        const relayedAtMs = isoToMs(entity.relayed_at);
        // Check [from, to] range
        if (relayedAtMs < options.fromMs || relayedAtMs > options.toMs) {
          return false;
        }
        // Check pairId filter if provided
        if (options.pairId && entity.pair_id !== options.pairId) {
          return false;
        }
        // Check participant security if provided
        if (options.participantDeviceId) {
          const pair = pairCache.get(entity.pair_id);
          if (pair && !this.isParticipant(pair, options.participantDeviceId)) {
            return false;
          }
        }
        return true;
      })
      .map((entity) => toHistoryRecord(entity));

    // Newest first
    return records.sort((a, b) => isoToMs(b.relayed_at) - isoToMs(a.relayed_at));
  }

  public async count(): Promise<number> {
    const db = getFirestoreDb();
    if (!db) return 0;
    const snapshot = await db.collection(PAIRS_COLLECTION).get();
    return snapshot.size;
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    for (const collectionName of [PAIRS_COLLECTION, MESSAGES_COLLECTION]) {
      const snapshot = await db.collection(collectionName).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const sessionService = new SessionService();
