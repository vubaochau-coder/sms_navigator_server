import { PairEntity, PendingRelayMessage } from '../types/index.js';
import { env } from '../config/env.js';

export const PAIRING_CODE_TTL_SECONDS = 600; // 10 minutes
export const MAX_PAIRING_ATTEMPTS = 5; // 5 wrong guesses invalidate the code
export const MESSAGE_DEDUP_TTL_SECONDS = 600; // 10 minutes
export const PENDING_MESSAGE_TTL_SECONDS = 300; // 5 minutes
const STALE_PENDING_PAIR_SECONDS = 3600;

export interface PairConfirmParams {
  receiver_device_id: string;
  fcm_token: string;
  device_name?: string;
  platform?: string;
}

export class SessionService {
  private pairs = new Map<string, PairEntity>();
  private pendingMessages: Map<string, PendingRelayMessage[]> = new Map();
  private processedMessageIds = new Set<string>();
  private messageProcessedAt = new Map<string, number>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredSessions();
    }, 60 * 1000);

    // Prevent interval from blocking process shutdown
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  public createPair(pairId: string, senderDeviceId: string): PairEntity {
    const now = Math.floor(Date.now() / 1000);

    const pair: PairEntity = {
      pair_id: pairId,
      sender_device_id: senderDeviceId,
      pairing_attempts: 0,
      created_at: now,
      last_active_at: now
    };

    this.pairs.set(pairId, pair);
    return pair;
  }

  public getPair(pairId: string): PairEntity | null {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;

    const now = Math.floor(Date.now() / 1000);
    const isConfirmed = Boolean(pair.receiver_device_id);
    if (isConfirmed && pair.expires_at !== undefined && pair.expires_at <= now) {
      this.pairs.delete(pairId);
      return null;
    }

    pair.last_active_at = now;
    return pair;
  }

  public setPairingCode(pairId: string, codeHash: string): PairEntity | null {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;

    const now = Math.floor(Date.now() / 1000);
    pair.pairing_code_hash = codeHash;
    pair.pairing_code_expires_at = now + PAIRING_CODE_TTL_SECONDS;
    pair.pairing_attempts = 0;
    pair.last_active_at = now;
    return pair;
  }

  public recordFailedAttempt(pairId: string): number {
    const pair = this.pairs.get(pairId);
    if (!pair) return 0;

    pair.pairing_attempts += 1;
    pair.last_active_at = Math.floor(Date.now() / 1000);

    if (pair.pairing_attempts >= MAX_PAIRING_ATTEMPTS) {
      // Brute-force guard: invalidate the code once the guess budget is exhausted
      pair.pairing_code_hash = undefined;
      pair.pairing_code_expires_at = undefined;
    }

    return pair.pairing_attempts;
  }

  public confirmPairing(pairId: string, params: PairConfirmParams): PairEntity | null {
    const pair = this.pairs.get(pairId);
    if (!pair) return null;

    const now = Math.floor(Date.now() / 1000);
    pair.receiver_device_id = params.receiver_device_id;
    pair.fcm_token = params.fcm_token;
    pair.device_name = params.device_name;
    pair.platform = params.platform;
    pair.paired_at = now;
    pair.expires_at = now + env.SESSION_TTL_HOURS * 3600;
    pair.last_active_at = now;

    // One-time use: the code can never be redeemed again
    pair.pairing_code_hash = undefined;
    pair.pairing_code_expires_at = undefined;
    pair.pairing_attempts = 0;

    return pair;
  }

  public removePair(pairId: string): boolean {
    this.pendingMessages.delete(pairId);
    return this.pairs.delete(pairId);
  }

  public isParticipant(pair: PairEntity, deviceId: string): boolean {
    return pair.sender_device_id === deviceId || pair.receiver_device_id === deviceId;
  }

  public isMessageProcessed(messageId: string): boolean {
    const processedAt = this.messageProcessedAt.get(messageId);
    if (processedAt === undefined) return false;

    const now = Math.floor(Date.now() / 1000);
    if (now - processedAt > MESSAGE_DEDUP_TTL_SECONDS) {
      this.processedMessageIds.delete(messageId);
      this.messageProcessedAt.delete(messageId);
      return false;
    }

    return true;
  }

  public markMessageProcessed(messageId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.processedMessageIds.add(messageId);
    this.messageProcessedAt.set(messageId, now);
  }

  public addPendingMessage(pairId: string, message: PendingRelayMessage): void {
    const queue = this.pendingMessages.get(pairId) ?? [];
    queue.push(message);
    this.pendingMessages.set(pairId, this.pruneExpiredPendingMessages(queue));
  }

  public getAndClearPendingMessages(pairId: string): PendingRelayMessage[] {
    const queue = this.pendingMessages.get(pairId);
    if (!queue) return [];

    const alive = this.pruneExpiredPendingMessages(queue);
    this.pendingMessages.delete(pairId);
    return alive;
  }

  private pruneExpiredPendingMessages(queue: PendingRelayMessage[]): PendingRelayMessage[] {
    const now = Math.floor(Date.now() / 1000);
    return queue.filter(
      (message) => now - message.sent_at <= PENDING_MESSAGE_TTL_SECONDS
    );
  }

  public cleanExpiredSessions(): number {
    const now = Math.floor(Date.now() / 1000);
    let removedCount = 0;

    for (const [pairId, pair] of this.pairs.entries()) {
      const isConfirmed = Boolean(pair.receiver_device_id);
      const isExpired =
        isConfirmed && pair.expires_at !== undefined && pair.expires_at <= now;
      const isStalePending = !isConfirmed && now - pair.created_at > STALE_PENDING_PAIR_SECONDS;

      if (isExpired || isStalePending) {
        this.pairs.delete(pairId);
        removedCount++;
      }
    }

    for (const [messageId, processedAt] of this.messageProcessedAt.entries()) {
      if (now - processedAt > MESSAGE_DEDUP_TTL_SECONDS) {
        this.processedMessageIds.delete(messageId);
        this.messageProcessedAt.delete(messageId);
      }
    }

    for (const [pairId, queue] of this.pendingMessages.entries()) {
      const alive = this.pruneExpiredPendingMessages(queue);
      if (alive.length === 0) {
        this.pendingMessages.delete(pairId);
      } else {
        this.pendingMessages.set(pairId, alive);
      }
    }

    return removedCount;
  }

  public count(): number {
    return this.pairs.size;
  }

  public clearAll(): void {
    this.pairs.clear();
    this.pendingMessages.clear();
    this.processedMessageIds.clear();
    this.messageProcessedAt.clear();
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const sessionService = new SessionService();
