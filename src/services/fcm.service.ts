import * as admin from 'firebase-admin';
import { env } from '../config/env.js';
import { initFirebase } from '../config/firebase.js';

export interface FcmRelayMessageParams {
  fcmToken: string;
  pairId: string;
  encryptedPayload: string;
  iv: string;
  sentAt: string; // ISO 8601 UTC
  ttlSeconds?: number;
  relayMessageId?: string;
}

export interface FcmRelayAckParams {
  fcmToken: string;
  pairId: string;
  relayMessageId?: string;
  receiverName?: string;
  status?: 'DELIVERED' | 'QUEUED';
}

export class FcmService {
  private adminSdk: typeof admin;

  constructor() {
    this.adminSdk = initFirebase();
  }

  public async sendRelayDataMessage(params: FcmRelayMessageParams): Promise<string> {
    const { fcmToken, pairId, encryptedPayload, iv, sentAt, ttlSeconds = 300, relayMessageId } = params;

    // Check for mock mode or testing
    if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
      const mockMessageId = `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      // eslint-disable-next-line no-console
      console.log(`[FCM-Mock] Relaying data message for pair ${pairId} -> token ${fcmToken.substring(0, 10)}... (msgId: ${mockMessageId})`);
      return mockMessageId;
    }

    const data: Record<string, string> = {
      pair_id: pairId,
      encrypted_payload: encryptedPayload,
      iv: iv,
      sent_at: sentAt.toString(),
      type: 'OTP_RELAY'
    };

    if (relayMessageId) {
      data.message_id = relayMessageId;
    }

    const message: admin.messaging.Message = {
      token: fcmToken,
      data,
      android: {
        priority: 'high',
        ttl: ttlSeconds * 1000 // In milliseconds
      }
    };

    try {
      const messageId = await this.adminSdk.messaging().send(message);
      return messageId;
    } catch (error: any) {
      // Check if error is related to invalid/unregistered token
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        throw new Error('RECEIVER_TOKEN_EXPIRED');
      }
      throw error;
    }
  }

  public async sendRelayAckMessage(params: FcmRelayAckParams): Promise<string> {
    const { fcmToken, pairId, relayMessageId, receiverName, status = 'DELIVERED' } = params;

    if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
      const mockMessageId = `mock_ack_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      // eslint-disable-next-line no-console
      console.log(`[FCM-Mock] Sending relay ACK for pair ${pairId} -> token ${fcmToken.substring(0, 10)}... (msgId: ${mockMessageId})`);
      return mockMessageId;
    }

    const data: Record<string, string> = {
      pair_id: pairId,
      type: 'OTP_RELAY_ACK',
      status,
      receiver_name: receiverName ?? ''
    };

    if (relayMessageId) {
      data.relay_message_id = relayMessageId;
    }

    const message: admin.messaging.Message = {
      token: fcmToken,
      data,
      android: {
        priority: 'high',
        ttl: 10 * 60 * 1000
      }
    };

    try {
      const messageId = await this.adminSdk.messaging().send(message);
      return messageId;
    } catch (error: any) {
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        throw new Error('SENDER_TOKEN_EXPIRED');
      }
      throw error;
    }
  }
}

export const fcmService = new FcmService();
