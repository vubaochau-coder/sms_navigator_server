import { SessionService, MESSAGES_COLLECTION, MESSAGE_HISTORY_TTL_SECONDS, PENDING_PAIR_TTL_MS } from '../src/services/session.service.js';
import { getFirestoreDb } from '../src/config/firebase.js';
import { msToIso } from '../src/utils/time.js';
import { sha256Hex } from '../src/services/device.service.js';
import { PairConfirmOutcome } from '../src/types/index.js';

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

  describe('confirmPairingByPairingKey (transactional, one-time use)', () => {
    const createPairWithKey = async (pairId: string, senderId: string) => {
      const pairingKey = 'unit_test_pairing_key_value';
      await sessionService.createPair(pairId, senderId, undefined, sha256Hex(pairingKey));
      return pairingKey;
    };

    it('should confirm the pair and consume the pairing key', async () => {
      const pairingKey = await createPairWithKey('pair_tx_ok', 'device_tx_sender');

      const outcome = await sessionService.confirmPairingByPairingKey(pairingKey, {
        receiver_device_id: 'device_tx_receiver',
        fcm_token: 'fcm_tx_12345'
      });

      expect(outcome.status).toBe('CONFIRMED');
      if (outcome.status === 'CONFIRMED') {
        expect(outcome.pair.receiver_device_id).toBe('device_tx_receiver');
        expect(outcome.pair.expires_at).toBeDefined();
      }

      // One-time use: the key no longer resolves to any pairing session
      const replay = await sessionService.confirmPairingByPairingKey(pairingKey, {
        receiver_device_id: 'device_tx_receiver',
        fcm_token: 'fcm_tx_12345'
      });
      expect(replay.status).toBe('NOT_FOUND');
    });

    it('should reject an unknown pairing key', async () => {
      const outcome = await sessionService.confirmPairingByPairingKey('never_issued_pairing_key', {
        receiver_device_id: 'device_any',
        fcm_token: 'fcm_any_12345'
      });
      expect(outcome.status).toBe('NOT_FOUND');
    });

    it('should reject self-pairing from the sender device', async () => {
      const pairingKey = await createPairWithKey('pair_tx_self', 'device_tx_same');

      const outcome = await sessionService.confirmPairingByPairingKey(pairingKey, {
        receiver_device_id: 'device_tx_same',
        fcm_token: 'fcm_self_12345'
      });

      expect(outcome.status).toBe('SELF_PAIRING_NOT_ALLOWED');
    });

    it('should reject a pending pair older than the 10-minute TTL', async () => {
      const db = getFirestoreDb();
      expect(db).not.toBeNull();

      const pairingKey = await createPairWithKey('pair_tx_expired', 'device_tx_old_sender');
      await db!
        .collection('pairs')
        .doc('pair_tx_expired')
        .update({ created_at: msToIso(Date.now() - PENDING_PAIR_TTL_MS - 60_000) });

      const outcome = await sessionService.confirmPairingByPairingKey(pairingKey, {
        receiver_device_id: 'device_tx_receiver',
        fcm_token: 'fcm_expired_12345'
      });

      expect(outcome.status).toBe('EXPIRED');
    });

    it('should let only the first concurrent confirmation win', async () => {
      const pairingKey = await createPairWithKey('pair_tx_race', 'device_tx_race_sender');

      const [first, second] = await Promise.all([
        sessionService.confirmPairingByPairingKey(pairingKey, {
          receiver_device_id: 'device_tx_race_receiver',
          fcm_token: 'fcm_race_1_12345'
        }),
        sessionService.confirmPairingByPairingKey(pairingKey, {
          receiver_device_id: 'device_tx_race_receiver',
          fcm_token: 'fcm_race_2_12345'
        })
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual(['CONFIRMED', 'NOT_FOUND']);
      const winner: PairConfirmOutcome = first.status === 'CONFIRMED' ? first : second;
      expect(winner.status === 'CONFIRMED' && winner.pair.receiver_device_id).toBe('device_tx_race_receiver');
    });
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
    await sessionService.createPair(
      'pair_confirmed_recent',
      'device_recent_sender',
      undefined,
      sha256Hex('recent_pairing_key_value')
    );
    const confirmed = await sessionService.confirmPairingByPairingKey('recent_pairing_key_value', {
      receiver_device_id: 'device_recent_receiver',
      fcm_token: 'fcm_recent_12345'
    });
    expect(confirmed.status).toBe('CONFIRMED');

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
