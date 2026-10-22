import { getMessaging } from 'firebase-admin/messaging';
import type { Message } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
import { initFirebase } from '../config/firebase.js';
import { logger } from '../utils/logger.js';
import { deviceService } from './device.service.js';

/** Sends one FCM message and resolves with its message id. */
export type FcmTransport = (message: Message) => Promise<string>;

/** FCM error codes meaning the token will never work again. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
]);

export function isDeadTokenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DEAD_TOKEN_CODES.has(code);
}

const mockTransport: FcmTransport = async (message) => {
  const token = 'token' in message ? message.token : '';
  const mockMessageId = `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`[FCM-Mock] Data notification (${message.data?.type || 'UNKNOWN'}) -> token ${token.substring(0, 10)}... (msgId: ${mockMessageId})`);
  return mockMessageId;
};

const firebaseTransport: FcmTransport = (message) => getMessaging().send(message);

export class FcmService {
  private readonly transport: FcmTransport;

  constructor(transport?: FcmTransport) {
    // Ensures the Admin SDK is initialized before the first send attempt
    initFirebase();
    this.transport =
      transport ?? (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test' ? mockTransport : firebaseTransport);
  }

  /** Resolves with the FCM message id, or `''` when delivery failed. */
  public async sendDataNotification(
    fcmToken: string,
    data: Record<string, string>,
    notification?: { title: string; body: string }
  ): Promise<string> {
    const message: Message = {
      token: fcmToken,
      data,
      android: {
        priority: 'high',
        ttl: 10 * 60 * 1000
      }
    };

    if (notification) {
      message.notification = notification;
    }

    try {
      return await this.transport(message);
    } catch (error) {
      // Best-effort notification delivery, do not crash business flow
      if (isDeadTokenError(error)) {
        await this.dropDeadToken(fcmToken);
      } else {
        logger.warn('[FCM] Failed to send data notification:', { error: String(error) });
      }
      return '';
    }
  }

  private async dropDeadToken(fcmToken: string): Promise<void> {
    try {
      const cleared = await deviceService.clearFcmToken(fcmToken);
      logger.info(`[FCM] Token ${fcmToken.substring(0, 10)}... is no longer registered; cleared on ${cleared} device(s).`);
    } catch (error) {
      logger.warn('[FCM] Failed to clear dead token:', { error: String(error) });
    }
  }
}

export const fcmService = new FcmService();
