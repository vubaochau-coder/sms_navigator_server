import { PairedDeviceSession } from '../types/index.js';
import { env } from '../config/env.js';

export class SessionService {
  private sessions = new Map<string, PairedDeviceSession>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup every 15 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanExpiredSessions();
    }, 15 * 60 * 1000);

    // Prevent interval from blocking process shutdown
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  public saveSession(
    pairId: string,
    fcmToken: string,
    deviceName?: string,
    platform?: string
  ): PairedDeviceSession {
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = env.SESSION_TTL_HOURS * 3600;

    const session: PairedDeviceSession = {
      pairId,
      fcmToken,
      deviceName,
      platform,
      pairedAt: now,
      expiresAt: now + ttlSeconds,
      lastActiveAt: now
    };

    this.sessions.set(pairId, session);
    return session;
  }

  public getSession(pairId: string): PairedDeviceSession | null {
    const session = this.sessions.get(pairId);
    if (!session) return null;

    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt <= now) {
      this.sessions.delete(pairId);
      return null;
    }

    session.lastActiveAt = now;
    return session;
  }

  public removeSession(pairId: string): boolean {
    return this.sessions.delete(pairId);
  }

  public cleanExpiredSessions(): number {
    const now = Math.floor(Date.now() / 1000);
    let removedCount = 0;

    for (const [pairId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(pairId);
        removedCount++;
      }
    }

    return removedCount;
  }

  public count(): number {
    return this.sessions.size;
  }

  public clearAll(): void {
    this.sessions.clear();
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const sessionService = new SessionService();
