import { Request, Response } from 'express';
import { sessionService } from '../services/session.service.js';
import { fcmService } from '../services/fcm.service.js';
import { RelayPayloadRequest, RelayPayloadResponse } from '../types/index.js';
import { env } from '../config/env.js';

export class RelayController {
  public static async relayOtp(req: Request, res: Response): Promise<void> {
    const {
      pair_id,
      encrypted_payload,
      iv,
      sent_at,
      ttl_seconds = env.MAX_RELAY_TTL_SECONDS
    }: RelayPayloadRequest = req.body;

    const now = Math.floor(Date.now() / 1000);

    // 1. Verify that the OTP payload hasn't expired before reaching server
    if (now - sent_at > ttl_seconds) {
      res.status(400).json({
        success: false,
        error: 'PAYLOAD_EXPIRED',
        message: `OTP relay payload has expired (${now - sent_at}s elapsed, max TTL is ${ttl_seconds}s)`
      });
      return;
    }

    // 2. Lookup receiver device session
    const session = sessionService.getSession(pair_id);
    if (!session) {
      res.status(404).json({
        success: false,
        error: 'RECEIVER_NOT_PAIRED',
        message: `No active receiver device found for pair_id: ${pair_id}. Please pair Device B first.`
      });
      return;
    }

    // 3. Dispatch FCM High-Priority Data message to Receiver
    try {
      const messageId = await fcmService.sendRelayDataMessage({
        fcmToken: session.fcmToken,
        pairId: session.pairId,
        encryptedPayload: encrypted_payload,
        iv,
        sentAt: sent_at,
        ttlSeconds: ttl_seconds
      });

      const response: RelayPayloadResponse = {
        success: true,
        message: 'OTP payload successfully forwarded to receiver via High-Priority FCM',
        message_id: messageId,
        relayed_at: now
      };

      res.status(200).json(response);
    } catch (error: any) {
      if (error.message === 'RECEIVER_TOKEN_EXPIRED') {
        sessionService.removeSession(pair_id);
        res.status(410).json({
          success: false,
          error: 'RECEIVER_TOKEN_EXPIRED',
          message: 'Receiver FCM device token is no longer valid. Receiver must re-pair.'
        });
        return;
      }

      res.status(502).json({
        success: false,
        error: 'FCM_DISPATCH_FAILED',
        message: `Failed to dispatch push notification: ${error.message || error}`
      });
    }
  }
}
