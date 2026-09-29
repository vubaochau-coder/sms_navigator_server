import { SessionService } from '../src/services/session.service.js';

describe('SessionService Unit Tests', () => {
  let sessionService: SessionService;

  beforeEach(() => {
    sessionService = new SessionService();
  });

  afterEach(() => {
    sessionService.destroy();
  });

  it('should save and retrieve a session correctly', () => {
    const pairId = 'pair_test123';
    const fcmToken = 'fake_fcm_token_xyz_12345';

    const saved = sessionService.saveSession(pairId, fcmToken, 'Pixel 7', 'android');
    expect(saved.pairId).toBe(pairId);
    expect(saved.fcmToken).toBe(fcmToken);
    expect(saved.deviceName).toBe('Pixel 7');

    const retrieved = sessionService.getSession(pairId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.pairId).toBe(pairId);
    expect(retrieved?.fcmToken).toBe(fcmToken);
  });

  it('should return null for expired sessions and remove them', () => {
    const pairId = 'pair_expired';
    const fcmToken = 'fake_token';

    const session = sessionService.saveSession(pairId, fcmToken);
    // Artificially expire the session
    session.expiresAt = Math.floor(Date.now() / 1000) - 10;

    const retrieved = sessionService.getSession(pairId);
    expect(retrieved).toBeNull();
    expect(sessionService.count()).toBe(0);
  });

  it('should remove session by pairId', () => {
    const pairId = 'pair_to_remove';
    sessionService.saveSession(pairId, 'token123');
    expect(sessionService.count()).toBe(1);

    const removed = sessionService.removeSession(pairId);
    expect(removed).toBe(true);
    expect(sessionService.getSession(pairId)).toBeNull();
    expect(sessionService.count()).toBe(0);
  });
});
