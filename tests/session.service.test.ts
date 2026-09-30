import { SessionService } from '../src/services/session.service.js';

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

    const retrieved = await sessionService.getPair(pairId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.sender_device_id).toBe(senderId);
  });

  it('should set pairing code and lock after max failed attempts', async () => {
    const pairId = 'pair_bruteforce_test';
    await sessionService.createPair(pairId, 'device_a');
    await sessionService.setPairingCode(pairId, 'hash_of_123456');

    for (let i = 0; i < 4; i++) {
      expect(await sessionService.recordFailedAttempt(pairId)).toBe(i + 1);
      const pair = await sessionService.getPair(pairId);
      expect(pair?.pairing_code_hash).toBe('hash_of_123456');
    }

    // 5th attempt exhausts budget
    expect(await sessionService.recordFailedAttempt(pairId)).toBe(5);
    const lockedPair = await sessionService.getPair(pairId);
    expect(lockedPair?.pairing_code_hash).toBeUndefined();
  });

  it('should deduplicate messages by message_id', async () => {
    const msgId = 'msg_unique_uuid_999';
    expect(await sessionService.isMessageProcessed(msgId)).toBe(false);

    await sessionService.addPendingMessage('pair_dedup_test', {
      message_id: msgId,
      encrypted_payload: 'U2FsdGVkX19mock==',
      iv: 'aXZfc2FsdF8xMmJ5dGVz',
      sent_at: Math.floor(Date.now() / 1000),
      ttl_seconds: 300
    });
    expect(await sessionService.isMessageProcessed(msgId)).toBe(true);
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
