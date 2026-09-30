import { SessionService, MESSAGES_COLLECTION, MESSAGE_HISTORY_TTL_SECONDS } from '../src/services/session.service.js';
import { getFirestoreDb } from '../src/config/firebase.js';
import { msToIso } from '../src/utils/time.js';

describe('SessionService Unit Tests', () => {
  let sessionService: SessionService;

  beforeEach(async () => {
    sessionService = new SessionService();
    await sessionService.clearAll();
  });

  afterEach(async () => {
    sessionService.destroy();
    await sessionService.clearAll();
  });

  it('should create and retrieve a pair correctly', async () => {
    const pairId = 'pair_test123';
    const senderId = 'device_sender_001';

    const created = await sessionService.createPair(pairId, senderId);
    expect(created.pair_id).toBe(pairId);
    expect(created.sender_device_id).toBe(senderId);
    expect(new Date(created.created_at).toISOString()).toBe(created.created_at);

    const retrieved = await sessionService.getPair(pairId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.sender_device_id).toBe(senderId);
  });

  it('should deduplicate messages by message_id', async () => {
    const msgId = 'msg_unique_uuid_999';
    expect(await sessionService.isMessageProcessed(msgId)).toBe(false);

    await sessionService.addPendingMessage('pair_dedup_test', {
      message_id: msgId,
      encrypted_payload: 'U2FsdGVkX19mock==',
      iv: 'aXZfc2FsdF8xMmJ5dGVz',
      sent_at: new Date().toISOString(),
      ttl_seconds: 300
    });
    expect(await sessionService.isMessageProcessed(msgId)).toBe(true);
  });

  it('should clean up relay messages older than 24h and keep fresh ones', async () => {
    const db = getFirestoreDb();
    expect(db).not.toBeNull();

    const oldRelayedAt = msToIso(Date.now() - (MESSAGE_HISTORY_TTL_SECONDS + 3600) * 1000);
    await db!.collection(MESSAGES_COLLECTION).doc('msg_too_old').set({
      message_id: 'msg_too_old',
      pair_id: 'pair_cleanup',
      relayed_at: oldRelayedAt,
      status: 'PENDING'
    });
    await db!.collection(MESSAGES_COLLECTION).doc('msg_fresh').set({
      message_id: 'msg_fresh',
      pair_id: 'pair_cleanup',
      relayed_at: new Date().toISOString(),
      status: 'PENDING'
    });

    await sessionService.cleanExpiredSessions();

    expect((await db!.collection(MESSAGES_COLLECTION).doc('msg_too_old').get()).exists).toBe(false);
    expect((await db!.collection(MESSAGES_COLLECTION).doc('msg_fresh').get()).exists).toBe(true);
  });

  it('should remove stale unconfirmed pairs after the 10-minute QR window', async () => {
    const db = getFirestoreDb();
    expect(db).not.toBeNull();

    const staleCreatedAt = msToIso(Date.now() - 11 * 60 * 1000);
    await db!.collection('pairs').doc('pair_stale_pending').set({
      pair_id: 'pair_stale_pending',
      sender_device_id: 'device_stale_sender',
      created_at: staleCreatedAt,
      last_active_at: staleCreatedAt
    });
    const confirmedPair = await sessionService.createPair('pair_confirmed_recent', 'device_recent_sender');
    await sessionService.confirmPairing(confirmedPair.pair_id, {
      receiver_device_id: 'device_recent_receiver',
      fcm_token: 'fcm_recent_12345'
    });

    await sessionService.cleanExpiredSessions();

    expect((await db!.collection('pairs').doc('pair_stale_pending').get()).exists).toBe(false);
    expect(await sessionService.getPair('pair_confirmed_recent')).not.toBeNull();
  });

  it('should remove pair by pairId', async () => {
    const pairId = 'pair_to_remove';
    await sessionService.createPair(pairId, 'sender123');
    expect(await sessionService.count()).toBe(1);

    const removed = await sessionService.removePair(pairId);
    expect(removed).toBe(true);
    expect(await sessionService.getPair(pairId)).toBeNull();
    expect(await sessionService.count()).toBe(0);
  });
});
