import { createHash } from 'crypto';

/**
 * Chống replay tấn công tầng relay (roadmap GĐ4.2).
 *
 * Kẻ tấn công đã chặn được 1 request relay (vd qua log mạng, kênh insecure)
 * có thể gửi lại ciphertext cũ kèm `message_id` mới để bypass dedup theo
 * message_id — buộc Máy B decrypt lại cùng một OTP. Fingerprint
 * `sha256(pair_id | iv | ciphertext)` chặn điều đó: cùng một ciphertext
 * chỉ được relay một lần trong TTL 24h.
 *
 * Lưu trữ in-memory (Map hash -> expiry) là đủ cho triển khai single-instance;
 * instance restart chỉ làm mất bộ dedup tối đa 24h dữ liệu — chấp nhận được
 * vì ciphertext còn bị chặn bởi TTL ngắn phía receiver.
 */
export class ReplayGuardService {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    /** Chặn cứng kích thước bộ nhớ nếu bị spam hash (giá trị lớn hơn mọi tải thực tế). */
    private readonly maxEntries = 100_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Trả về true nếu fingerprint này đã thấy trong TTL (replay). Ngược lại
   * ghi nhận và trả về false.
   */
  checkAndRecord(pairId: string, iv: string, encryptedPayload: string): boolean {
    const fingerprint = ReplayGuardService.fingerprint(pairId, iv, encryptedPayload);
    this.evictExpired();

    const existingExpiry = this.entries.get(fingerprint);
    if (existingExpiry !== undefined && existingExpiry > this.now()) {
      return true;
    }

    if (this.entries.size >= this.maxEntries) {
      // Bỏ qua các entry cũ nhất (Map giữ thứ tự chèn) để giới hạn bộ nhớ.
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(fingerprint, this.now() + this.ttlMs);
    return false;
  }

  /** Fingerprint cố định theo cặp (pair_id, iv, ciphertext). */
  public static fingerprint(pairId: string, iv: string, encryptedPayload: string): string {
    return createHash('sha256')
      .update(`${pairId}|${iv}|${encryptedPayload}`)
      .digest('hex');
  }

  /**
   * T5 (SRD 4.1 / API spec §6.2): caller computes the bind hash itself —
   * `sha256(channel_id|nonce|ciphertext)` — and this method only does
   * dedup + TTL. Returns true (replay) or false (recorded, first time).
   */
  checkAndRecordHash(fingerprint: string): boolean {
    this.evictExpired();

    const existingExpiry = this.entries.get(fingerprint);
    if (existingExpiry !== undefined && existingExpiry > this.now()) {
      return true;
    }

    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(fingerprint, this.now() + this.ttlMs);
    return false;
  }

  /** Số entry đang giữ (dùng trong test). */
  get size(): number {
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export const replayGuardService = new ReplayGuardService();
