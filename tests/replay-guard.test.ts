import { createHash } from 'crypto';
import { ReplayGuardService } from '../src/services/replay-guard.service.js';

const fingerprint = (parts: string[]): string =>
  createHash('sha256')
    .update(parts.join('|'))
    .digest('hex');

describe('ReplayGuardService (anti-replay T5)', () => {
  it('records a fingerprint once and flags the second attempt as replay', () => {
    const guard = new ReplayGuardService();
    const fp = fingerprint(['channel_1', 'nonce_a', 'cipher_a']);

    expect(guard.checkAndRecordHash(fp)).toBe(false);
    expect(guard.checkAndRecordHash(fp)).toBe(true);
  });

  it('distinguishes fingerprints by channel, nonce and ciphertext', () => {
    const guard = new ReplayGuardService();

    expect(guard.checkAndRecordHash(fingerprint(['channel_1', 'nonce_a', 'cipher_a']))).toBe(false);
    expect(guard.checkAndRecordHash(fingerprint(['channel_2', 'nonce_a', 'cipher_a']))).toBe(false);
    expect(guard.checkAndRecordHash(fingerprint(['channel_1', 'nonce_b', 'cipher_a']))).toBe(false);
    expect(guard.checkAndRecordHash(fingerprint(['channel_1', 'nonce_a', 'cipher_b']))).toBe(false);

    // Tất cả fingerprint đã ghi nhận đều replay được phát hiện
    expect(guard.checkAndRecordHash(fingerprint(['channel_2', 'nonce_a', 'cipher_a']))).toBe(true);
  });

  it('expires entries after the TTL', () => {
    let now = 1_000_000;
    const guard = new ReplayGuardService(24 * 60 * 60 * 1000, 1000, () => now);
    const fp = fingerprint(['channel_1', 'nonce', 'cipher']);

    expect(guard.checkAndRecordHash(fp)).toBe(false);

    now += 24 * 60 * 60 * 1000 - 1; // vẫn còn hạn
    expect(guard.checkAndRecordHash(fp)).toBe(true);

    now += 1000; // quá hạn
    expect(guard.checkAndRecordHash(fp)).toBe(false);
    expect(guard.size).toBe(1);
  });

  it('caps the number of stored entries to bound memory', () => {
    const guard = new ReplayGuardService(24 * 60 * 60 * 1000, 3);
    const fp1 = fingerprint(['channel_1', 'iv', 'c1']);
    const fp2 = fingerprint(['channel_2', 'iv', 'c2']);
    const fp3 = fingerprint(['channel_3', 'iv', 'c3']);
    const fp4 = fingerprint(['channel_4', 'iv', 'c4']);

    guard.checkAndRecordHash(fp1);
    guard.checkAndRecordHash(fp2);
    guard.checkAndRecordHash(fp3);
    expect(guard.size).toBe(3);

    // Entry thứ 4 đè entry cũ nhất, không vượt giới hạn
    expect(guard.checkAndRecordHash(fp4)).toBe(false);
    expect(guard.size).toBe(3);

    // Entry cũ nhất (channel_1) bị đuổi: có thể ghi nhận lại
    expect(guard.checkAndRecordHash(fp1)).toBe(false);
    expect(guard.size).toBe(3);
  });
});
