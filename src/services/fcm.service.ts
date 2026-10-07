import { getMessaging } from 'firebase-admin/messaging';
import type { Message } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
import { initFirebase } from '../config/firebase.js';
import { logger } from '../utils/logger.js';

export class FcmService {
  constructor() {
    // Ensures the Admin SDK is initialized before the first send attempt
    initFirebase();
  }

  public async sendDataNotification(
    fcmToken: string,
    data: Record<string, string>,
    notification?: { title: string; body: string }
  ): Promise<string> {
    if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
      const mockMessageId = `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      logger.info(`[FCM-Mock] Data notification (${data.type || 'UNKNOWN'}) -> token ${fcmToken.substring(0, 10)}... (msgId: ${mockMessageId})`);
      return mockMessageId;
    }

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
      return await getMessaging().send(message);
    } catch (error) {
      // Best-effort notification delivery, do not crash business flow
      logger.warn('[FCM] Failed to send data notification:', { error: String(error) });
      return '';
    }
  }
}

export const fcmService = new FcmService();
