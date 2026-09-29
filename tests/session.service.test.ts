import { SessionService } from '../src/services/session.service.js';

describe('SessionService Unit Tests', () => {
  let sessionService: SessionService;

  beforeEach(() => {
    sessionService = new SessionService();
  });

  afterEach(() => {
    sessionService.destroy();
  });

  it('should create and retrieve a pair correctly', () => {
    const pairId = 'pair_test123';
    const senderId = 'device_sender_001';

    const created = sessionService.createPair(pairId, senderId);
    expect(created.pair_id).toBe(pairId);
    expect(created.sender_device_id).toBe(senderId);

    const retrieved = sessionService.getPair(pairId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.sender_device_id).toBe(senderId);
  });

  it('should set pairing code and lock after max failed attempts', () => {
    const pairId = 'pair_bruteforce_test';
    sessionService.createPair(pairId, 'device_a');
    sessionService.setPairingCode(pairId, 'hash_of_123456');

    for (let i = 0; i < 4; i++) {
      expect(sessionService.recordFailedAttempt(pairId)).toBe(i + 1);
      expect(sessionService.getPair(pairId)?.pairing_code_hash).toBe('hash_of_123456');
    }

    // 5th attempt exhausts budget
    expect(sessionService.recordFailedAttempt(pairId)).toBe(5);
    expect(sessionService.getPair(pairId)?.pairing_code_hash).toBeUndefined();
  });

  it('should deduplicate messages by message_id', () => {
    const msgId = 'msg_unique_uuid_999';
    expect(sessionService.isMessageProcessed(msgId)).toBe(false);

    sessionService.markMessageProcessed(msgId);
    expect(sessionService.isMessageProcessed(msgId)).toBe(true);
  });

  it('should remove pair by pairId', () => {
    const pairId = 'pair_to_remove';
    sessionService.createPair(pairId, 'sender123');
    expect(sessionService.count()).toBe(1);

    const removed = sessionService.removePair(pairId);
    expect(removed).toBe(true);
    expect(sessionService.getPair(pairId)).toBeNull();
    expect(sessionService.count()).toBe(0);
  });
});
