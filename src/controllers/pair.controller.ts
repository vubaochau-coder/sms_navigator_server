import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { sessionService } from '../services/session.service.js';
import { PairedReceiverItem, PairedSenderItem, PairConfirmRequest, PairStatusResponse } from '../types/index.js';
import { isoToMs } from '../utils/time.js';

export class PairController {
  public static async initPairing(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const requestedPairId: string | undefined = req.body?.pair_id;
    const pairId = requestedPairId ?? randomUUID();

    const existing = await sessionService.getPair(pairId);
    if (existing) {
      if (existing.sender_device_id !== device.device_id) {
        res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'This pair_id already belongs to another device.'
        });
        return;
      }

      if (existing.receiver_device_id) {
        res.status(409).json({
          success: false,
          error: 'PAIR_ALREADY_CONFIRMED',
          message: 'This pair has already been confirmed. Please use a new pair_id.'
        });
        return;
      }
    }

    const pair = existing ?? (await sessionService.createPair(pairId, device.device_id));

    res.status(201).json({
      success: true,
      message: 'Pairing session created. Share the QR payload with Device B to confirm.',
      pair_id: pair.pair_id
    });
  }

  public static async confirmPairing(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { pair_id, fcm_token, device_name, platform } = req.body as PairConfirmRequest;

    const pair = await sessionService.getPair(pair_id);
    if (!pair) {
      res.status(404).json({
        success: false,
        error: 'PAIR_NOT_FOUND',
        message: `No pairing session found for pair_id: ${pair_id}. Device A must call /pair/init first.`
      });
      return;
    }

    if (pair.sender_device_id === device.device_id) {
      res.status(400).json({
        success: false,
        error: 'SELF_PAIRING_NOT_ALLOWED',
        message: 'Device A cannot confirm its own pairing. Pairing must be confirmed by Device B.'
      });
      return;
    }

    if (pair.receiver_device_id) {
      res.status(409).json({
        success: false,
        error: 'PAIR_ALREADY_CONFIRMED',
        message: 'This pair has already been confirmed by another device.'
      });
      return;
    }

    // QR-based pairing: the scanned pair payload (pair_id + authenticated
    // sender identity) is sufficient to confirm.
    const confirmed = await sessionService.confirmPairing(pair_id, {
      receiver_device_id: device.device_id,
      fcm_token: fcm_token ?? device.fcm_token ?? '',
      device_name,
      platform
    });

    res.status(200).json({
      success: true,
      message: 'Device paired successfully with FCM token registered',
      pair_id: confirmed!.pair_id,
      paired_at: confirmed!.paired_at,
      expires_at: confirmed!.expires_at
    });
  }

  public static async getPairStatus(req: Request, res: Response): Promise<void> {
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
        message: 'Only the sender or receiver device of this pair can view its status.'
      });
      return;
    }

    const now = Date.now();
    const response: PairStatusResponse = {
      pair_id: pair.pair_id,
      is_paired:
        Boolean(pair.receiver_device_id) &&
        (pair.expires_at === undefined || isoToMs(pair.expires_at) > now),
      sender_device_id: pair.sender_device_id,
      receiver_device_id: pair.receiver_device_id,
      device_name: pair.receiver_device_name,
      platform: pair.platform,
      paired_at: pair.paired_at,
      expires_at: pair.expires_at,
      is_active: pair.is_active !== false
    };

    res.status(200).json(response);
  }

  /**
   * Sender view: list all receivers paired with this sender device.
   */
  public static async getPairedReceivers(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const pairs = await sessionService.getPairsBySender(device.device_id);

    const receivers: PairedReceiverItem[] = pairs.map((p) => ({
      pair_id: p.pair_id,
      receiver_device_id: p.receiver_device_id!,
      device_name: p.receiver_device_name || 'Thiết bị nhận',
      platform: p.platform || 'Android',
      paired_at: p.paired_at ?? p.created_at,
      last_active_at: p.last_active_at,
      is_active: p.is_active !== false
    }));

    res.status(200).json({
      success: true,
      count: receivers.length,
      receivers
    });
  }

  /**
   * Receiver view: list all senders paired with this receiver device.
   * Read-only connection status for receiver.
   */
  public static async getPairedSenders(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const pairs = await sessionService.getPairsByReceiver(device.device_id);

    const senders: PairedSenderItem[] = pairs.map((p) => ({
      pair_id: p.pair_id,
      sender_device_id: p.sender_device_id,
      device_name: p.sender_device_name || 'Thiết bị gửi',
      platform: device.platform || 'Android',
      paired_at: p.paired_at ?? p.created_at,
      last_active_at: p.last_active_at,
      is_active: p.is_active !== false
    }));

    res.status(200).json({
      success: true,
      count: senders.length,
      senders
    });
  }
}

