import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { sessionService } from '../services/session.service.js';
import { fcmService } from '../services/fcm.service.js';
import { RelayHistoryRecord, RelayPayloadRequest, RelayPayloadResponse } from '../types/index.js';
import { nowIso, msToIso, isoToMs, dayRange, parseTzOffsetMinutes } from '../utils/time.js';

// Device clocks drift: accept payloads stamped up to 2 minutes in the
// future, and extend the effective TTL by the same buffer before declaring
// a payload expired.
const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

export class RelayController {
  public static async relayOtp(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const {
      pair_id,
      message_id,
      encrypted_payload,
      iv,
      sent_at,
      ttl_seconds
    }: RelayPayloadRequest = req.body;

    const now = Date.now();
    const sentAtMs = isoToMs(sent_at);

    // 1. Verify that the OTP payload hasn't expired before reaching server
    //    (with clock-skew tolerance on both ends of the window)
    const elapsedMs = now - sentAtMs;
    if (elapsedMs > (ttl_seconds + CLOCK_SKEW_TOLERANCE_SECONDS) * 1000) {
      res.status(400).json({
        success: false,
        error: 'PAYLOAD_EXPIRED',
        message: `OTP relay payload has expired (${Math.floor(elapsedMs / 1000)}s elapsed, max TTL is ${ttl_seconds}s)`
      });
      return;
    }

    if (elapsedMs < -CLOCK_SKEW_TOLERANCE_SECONDS * 1000) {
      res.status(400).json({
        success: false,
        error: 'INVALID_SENT_AT',
        message: `sent_at is more than ${CLOCK_SKEW_TOLERANCE_SECONDS}s in the future. Check the device clock.`
      });
      return;
    }

    // 2. Lookup the pairing session
    const pair = await sessionService.getPair(pair_id);
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

    // 5. Sender active toggle check: sender may pause forwarding to this pair
    if (pair.is_active === false) {
      res.status(403).json({
        success: false,
        error: 'RELAY_PAUSED_BY_SENDER',
        message: 'Relay is currently paused by the sender device for this pair.'
      });
      return;
    }

    // 6. Message deduplication (10 minutes window) - checked against the
    //    `messages` collection by message_id
    if (message_id && (await sessionService.isMessageProcessed(message_id))) {
      const response: RelayPayloadResponse = {
        success: true,
        message: 'Duplicate message_id ignored (already relayed within the last 10 minutes)',
        message_id,
        duplicate: true,
        relayed_at: nowIso()
      };
      res.status(200).json(response);
      return;
    }

    // 7. Store the encrypted payload in the pending queue (5 minutes TTL)
    // so the receiver can fetch it via GET /relay/pending/:pairId even if
    // the FCM push is missed or dropped.
    const pendingMessageId = message_id ?? randomUUID();
    await sessionService.addPendingMessage(pair_id, {
      message_id: pendingMessageId,
      encrypted_payload,
      iv,
      sent_at,
      ttl_seconds
    });

    // Record in history for OTP logs & analytics by time range
    await sessionService.addRelayHistory({
      id: pendingMessageId,
      pair_id,
      sender_device_id: device.device_id,
      sender_device_name: device.device_name || 'Sender Device',
      encrypted_payload,
      iv,
      sent_at,
      relayed_at: nowIso(),
      message_id: message_id ?? pendingMessageId
    });

    // 8. Blind relay: forward the encrypted payload untouched via FCM High-Priority Data message
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

        // Best-effort delivery confirmation push back to the sender device.
        // Failures here must never affect the relay response.
        await RelayController.sendRelayAck(device, pair, pendingMessageId, 'DELIVERED');

        const response: RelayPayloadResponse = {
          success: true,
          message: 'OTP payload successfully forwarded to receiver via High-Priority FCM',
          message_id: message_id ?? fcmMessageId,
          relayed_at: nowIso()
        };

        res.status(200).json(response);
      } catch (error: any) {
        if (error.message === 'RECEIVER_TOKEN_EXPIRED') {
          await sessionService.removePair(pair_id);
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
    await RelayController.sendRelayAck(device, pair, pendingMessageId, 'QUEUED');

    const response: RelayPayloadResponse = {
      success: true,
      message: 'OTP payload queued for receiver polling (no FCM token registered)',
      message_id: pendingMessageId,
      relayed_at: nowIso()
    };
    res.status(200).json(response);
  }

  private static async sendRelayAck(
    device: NonNullable<Request['device']>,
    pair: { pair_id: string; receiver_device_name?: string },
    relayMessageId: string,
    status: 'DELIVERED' | 'QUEUED'
  ): Promise<void> {
    if (!device.fcm_token) return;
    try {
      await fcmService.sendRelayAckMessage({
        fcmToken: device.fcm_token,
        pairId: pair.pair_id,
        relayMessageId,
        receiverName: pair.receiver_device_name,
        status
      });
    } catch (error: any) {
      // eslint-disable-next-line no-console
      console.warn('[RelayController] Failed to send relay ACK to sender:', error?.message || error);
    }
  }

  public static async getPendingMessages(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const pairId = String(req.params.pairId);

    const pair = await sessionService.getPair(pairId);
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

    const messages = await sessionService.getAndClearPendingMessages(pairId);

    res.status(200).json({
      success: true,
      count: messages.length,
      messages
    });
  }

  public static async getRelayHistory(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const fromParam = typeof req.query.from === 'string' ? req.query.from : undefined;
    const toParam = typeof req.query.to === 'string' ? req.query.to : undefined;
    const dateParam = typeof req.query.date === 'string' ? req.query.date : undefined;
    const tzParam = typeof req.query.tz === 'string' ? req.query.tz : undefined;
    const pairIdParam = typeof req.query.pair_id === 'string' ? req.query.pair_id : undefined;

    let range: { fromMs: number; toMs: number };

    if (fromParam !== undefined || toParam !== undefined) {
      if (fromParam === undefined || toParam === undefined) {
        res.status(400).json({
          success: false,
          error: 'INVALID_PARAMETERS',
          message: 'Both "from" and "to" ISO 8601 query params are required when using a range.'
        });
        return;
      }
      const fromMs = Date.parse(fromParam);
      const toMs = Date.parse(toParam);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        res.status(400).json({
          success: false,
          error: 'INVALID_PARAMETERS',
          message: '"from" and "to" must be valid ISO 8601 datetimes (e.g. 2026-09-30T00:00:00+07:00).'
        });
        return;
      }
      if (fromMs > toMs) {
        res.status(400).json({
          success: false,
          error: 'INVALID_PARAMETERS',
          message: '"from" must not be after "to".'
        });
        return;
      }
      range = { fromMs, toMs };
    } else {
      // Legacy day-based query: ?date=YYYY-MM-DD with optional ?tz=+07:00 | tz=<minutes>
      // No tz (or no date) falls back to plain UTC day bounds.
      let offsetMinutes = 0;
      if (tzParam !== undefined) {
        const parsed = parseTzOffsetMinutes(tzParam);
        if (parsed === null) {
          res.status(400).json({
            success: false,
            error: 'INVALID_PARAMETERS',
            message: '"tz" must be a UTC offset like +07:00 or a minute value like 420.'
          });
          return;
        }
        offsetMinutes = parsed;
      }
      const targetDate = dateParam ?? new Date().toISOString().slice(0, 10);
      const computed = dayRange(targetDate, offsetMinutes);
      if (!computed) {
        res.status(400).json({
          success: false,
          error: 'INVALID_PARAMETERS',
          message: '"date" must be a valid YYYY-MM-DD string.'
        });
        return;
      }
      range = computed;
    }

    const records = await sessionService.getRelayHistory({
      fromMs: range.fromMs,
      toMs: range.toMs,
      pairId: pairIdParam,
      participantDeviceId: device.device_id
    });

    // Tag each record with the requesting device's role in that pair so the
    // client can distinguish "sent by me" vs "received by me" records.
    const taggedRecords = records.map((record) => ({
      ...record,
      viewer_role: (record.sender_device_id === device.device_id
        ? 'SENDER'
        : 'RECEIVER') as RelayHistoryRecord['viewer_role']
    }));

    res.status(200).json({
      success: true,
      from: msToIso(range.fromMs),
      to: msToIso(range.toMs),
      count: taggedRecords.length,
      records: taggedRecords
    });
  }
}
