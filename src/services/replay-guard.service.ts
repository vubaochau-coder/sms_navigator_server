/**
 * Chống replay tấn công (T5 — SRD 4.1 / API spec §6.2).
 *
 * Kẻ tấn công đã chặn được 1 request (vd qua log mạng, kênh insecure) có thể
 * gửi lại ciphertext cũ. Caller tự tính fingerprint bind
 * `sha256(channel_id|nonce|ciphertext)` rồi đưa vào `checkAndRecordHash`:
 * cùng một fingerprint chỉ được chấp nhận một lần trong TTL 24h.
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
      // Bỏ qua các entry cũ nhất (Map giữ thứ tự chèn) để giới hạn bộ nhớ.
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
