import { ReplayGuardService } from '../src/services/replay-guard.service.js';

describe('ReplayGuardService (anti-replay GĐ4.2)', () => {
  it('records a fingerprint once and flags the second attempt as replay', () => {
    const guard = new ReplayGuardService();

    expect(guard.checkAndRecord('pair_1', 'iv_a', 'cipher_a')).toBe(false);
    expect(guard.checkAndRecord('pair_1', 'iv_a', 'cipher_a')).toBe(true);
  });

  it('distinguishes fingerprints by pair_id, iv and ciphertext', () => {
    const guard = new ReplayGuardService();

    expect(guard.checkAndRecord('pair_1', 'iv_a', 'cipher_a')).toBe(false);
    expect(guard.checkAndRecord('pair_2', 'iv_a', 'cipher_a')).toBe(false);
    expect(guard.checkAndRecord('pair_1', 'iv_b', 'cipher_a')).toBe(false);
    expect(guard.checkAndRecord('pair_1', 'iv_a', 'cipher_b')).toBe(false);

    // Tất cả fingerprint đã ghi nhận đều replay được phát hiện
    expect(guard.checkAndRecord('pair_2', 'iv_a', 'cipher_a')).toBe(true);
  });

  it('expires entries after the TTL', () => {
    let now = 1_000_000;
    const guard = new ReplayGuardService(24 * 60 * 60 * 1000, 1000, () => now);

    expect(guard.checkAndRecord('pair_1', 'iv', 'cipher')).toBe(false);

    now += 24 * 60 * 60 * 1000 - 1; // vẫn còn hạn
    expect(guard.checkAndRecord('pair_1', 'iv', 'cipher')).toBe(true);

    now += 1000; // quá hạn
    expect(guard.checkAndRecord('pair_1', 'iv', 'cipher')).toBe(false);
    expect(guard.size).toBe(1);
  });

  it('caps the number of stored entries to bound memory', () => {
    const guard = new ReplayGuardService(24 * 60 * 60 * 1000, 3);

    guard.checkAndRecord('pair_1', 'iv', 'c1');
    guard.checkAndRecord('pair_2', 'iv', 'c2');
    guard.checkAndRecord('pair_3', 'iv', 'c3');
    expect(guard.size).toBe(3);

    // Entry thứ 4 đè entry cũ nhất, không vượt giới hạn
    expect(guard.checkAndRecord('pair_4', 'iv', 'c4')).toBe(false);
    expect(guard.size).toBe(3);

    // Entry cũ nhất (pair_1) bị đuổi: có thể ghi nhận lại
    expect(guard.checkAndRecord('pair_1', 'iv', 'c1')).toBe(false);
    expect(guard.size).toBe(3);
  });
});
