import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { sessionService } from '../services/session.service.js';
import { fcmService } from '../services/fcm.service.js';
import { RelayPayloadRequest, RelayPayloadResponse } from '../types/index.js';
import { env } from '../config/env.js';

export class RelayController {
  public static async relayOtp(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const {
      pair_id,
      message_id,
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

    // 2. Lookup the pairing session
    const pair = sessionService.getPair(pair_id);
    if (!pair) {
      res.status(404).json({
        success: false,
        error: 'RECEIVER_NOT_PAIRED',
        message: `No active receiver device found for pair_id: ${pair_id}. Please pair Device B first.`
      });
      return;
    }

    // 3. Ownership check: only Device A (sender) may relay payloads into its own pair
    if (pair.sender_device_id !== device.device_id) {
      res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Only the sender device (Device A) that initiated this pair is allowed to relay OTP payloads.'
      });
      return;
    }

    // 4. The receiver must have confirmed pairing before the pair can relay
    if (!pair.receiver_device_id) {
      res.status(404).json({
        success: false,
        error: 'RECEIVER_NOT_PAIRED',
        message: `Receiver device has not confirmed pairing for pair_id: ${pair_id}. Please pair Device B first.`
      });
      return;
    }

    // 5. Message deduplication (10 minutes window)
    if (message_id && sessionService.isMessageProcessed(message_id)) {
      const response: RelayPayloadResponse = {
        success: true,
        message: 'Duplicate message_id ignored (already relayed within the last 10 minutes)',
        message_id,
        duplicate: true,
        relayed_at: now
      };
      res.status(200).json(response);
      return;
    }

    // 6. Store the encrypted payload in the pending queue (5 minutes TTL)
    // so the receiver can fetch it via GET /relay/pending/:pairId even if
    // the FCM push is missed or dropped.
    const pendingMessageId = message_id ?? randomUUID();
    sessionService.addPendingMessage(pair_id, {
      message_id: pendingMessageId,
      encrypted_payload,
      iv,
      sent_at,
      ttl_seconds
    });

    // 7. Blind relay: forward the encrypted payload untouched via FCM High-Priority Data message
    if (pair.fcm_token) {
      try {
        const fcmMessageId = await fcmService.sendRelayDataMessage({
          fcmToken: pair.fcm_token,
          pairId: pair.pair_id,
          encryptedPayload: encrypted_payload,
          iv,
          sentAt: sent_at,
          ttlSeconds: ttl_seconds,
          relayMessageId: message_id
        });

        if (message_id) {
          sessionService.markMessageProcessed(message_id);
        }

        const response: RelayPayloadResponse = {
          success: true,
          message: 'OTP payload successfully forwarded to receiver via High-Priority FCM',
          message_id: message_id ?? fcmMessageId,
          relayed_at: now
        };

        res.status(200).json(response);
      } catch (error: any) {
        if (error.message === 'RECEIVER_TOKEN_EXPIRED') {
          sessionService.removePair(pair_id);
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
      return;
    }

    // No FCM token registered: the pending queue is the only delivery channel
    const response: RelayPayloadResponse = {
      success: true,
      message: 'OTP payload queued for receiver polling (no FCM token registered)',
      message_id: pendingMessageId,
      relayed_at: now
    };
    res.status(200).json(response);
  }

  public static async getPendingMessages(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const pairId = String(req.params.pairId);

    const pair = sessionService.getPair(pairId);
    if (!pair) {
      res.status(404).json({
        success: false,
        error: 'PAIR_NOT_FOUND',
        message: `No pairing session found for pair_id: ${pairId}`
      });
      return;
    }

    if (!sessionService.isParticipant(pair, device.device_id)) {
      res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Only the sender or receiver device of this pair can fetch its pending messages.'
      });
      return;
    }

    const messages = sessionService.getAndClearPendingMessages(pairId);

    res.status(200).json({
      success: true,
      count: messages.length,
      messages
    });
  }
}
