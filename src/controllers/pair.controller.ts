import { Request, Response } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import { sessionService, PENDING_PAIR_TTL_MS } from '../services/session.service.js';
import { deviceService } from '../services/device.service.js';
import { PairedReceiverItem, PairedSenderItem, PairConfirmRequest, PairStatusResponse } from '../types/index.js';
import { isoToMs, msToIso } from '../utils/time.js';
import { sha256Hex } from '../services/device.service.js';

export class PairController {
  public static async initPairing(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { sender_pubkey } = req.body as { sender_pubkey?: string };

    // The server owns both identifiers: the pair id (opaque UUID) and the
    // one-time 128-bit pairing key embedded in the QR payload. The plaintext
    // key leaves the server exactly once - inside this response - and is only
    // ever stored as a SHA-256 hash. The sender's X25519 public key is stored
    // so Device B can complete the ECDH handshake; private keys never reach
    // the server.
    const pairId = randomUUID();
    const pairingKey = randomBytes(16).toString('base64url');
    const expiresAt = msToIso(Date.now() + PENDING_PAIR_TTL_MS);

    await sessionService.createPair(
      pairId,
      device.device_id,
      device.device_name,
      sha256Hex(pairingKey),
      typeof sender_pubkey === 'string' && sender_pubkey.length > 0 ? sender_pubkey : undefined
    );

    res.status(201).json({
      success: true,
      message: 'Pairing session created. Share the QR payload with Device B to confirm.',
      pair_id: pairId,
      pairing_key: pairingKey,
      expires_at: expiresAt
    });
  }

  public static async confirmPairing(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { pairing_key, receiver_pubkey, fcm_token, device_name, platform } = req.body as PairConfirmRequest;

    const result = await sessionService.confirmPairingByPairingKey(pairing_key, {
      receiver_device_id: device.device_id,
      receiver_pubkey,
      fcm_token: fcm_token ?? device.fcm_token ?? '',
      device_name,
      platform
    });

    switch (result.status) {
      case 'NOT_FOUND':
        res.status(404).json({
          success: false,
          error: 'PAIR_NOT_FOUND',
          message: 'No valid pairing session for this QR key. Device A must call /pair/init and share a fresh QR.'
        });
        return;
      case 'SELF_PAIRING_NOT_ALLOWED':
        res.status(400).json({
          success: false,
          error: 'SELF_PAIRING_NOT_ALLOWED',
          message: 'Device A cannot confirm its own pairing. Pairing must be confirmed by Device B.'
        });
        return;
      case 'EXPIRED':
        res.status(410).json({
          success: false,
          error: 'PAIR_EXPIRED',
          message: 'This pairing QR has expired (10-minute validity). Please generate a new QR on Device A.'
        });
        return;
      case 'ALREADY_CONFIRMED':
        res.status(409).json({
          success: false,
          error: 'PAIR_ALREADY_CONFIRMED',
          message: 'This pair has already been confirmed by another device.'
        });
        return;
      case 'CONFIRMED':
        res.status(200).json({
          success: true,
          message: 'Device paired successfully with FCM token registered',
          pair_id: result.pair.pair_id,
          paired_at: result.pair.paired_at,
          expires_at: result.pair.expires_at,
          // Device B cross-checks this against the sender pubkey embedded in
          // the QR before deriving the shared key (anti server-side key swap).
          sender_pubkey: result.pair.sender_pubkey
        });
        return;
    }
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
      receiver_pubkey: pair.receiver_pubkey,
      paired_at: pair.paired_at,
      expires_at: pair.expires_at,
      is_active: pair.is_active !== false
    };

    res.status(200).json(response);
  }

  /**
   * Sender view: list all receivers paired with this sender device.
   * Pair records created before names were persisted fall back to the
   * device registry so users always see a readable device name.
   */
  public static async getPairedReceivers(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const pairs = await sessionService.getPairsBySender(device.device_id);

    const receivers: PairedReceiverItem[] = await Promise.all(
      pairs.map(async (p) => {
        const fallbackDevice = !p.receiver_device_name || !p.platform
          ? await deviceService.findByDeviceId(p.receiver_device_id!)
          : null;
        return {
          pair_id: p.pair_id,
          receiver_device_id: p.receiver_device_id!,
          device_name: p.receiver_device_name || fallbackDevice?.device_name || 'Thiết bị nhận',
          platform: p.platform || fallbackDevice?.platform || 'Android',
          paired_at: p.paired_at ?? p.created_at,
          last_active_at: p.last_active_at,
          is_active: p.is_active !== false
        };
      })
    );

    res.status(200).json({
      success: true,
      count: receivers.length,
      receivers
    });
  }

  /**
   * Receiver view: list all senders paired with this receiver device.
   * Read-only connection status for receiver. The sender's name/platform
   * come from the pair record, falling back to the device registry —
   * NOT from the requesting device (which is the receiver itself).
   */
  public static async getPairedSenders(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const pairs = await sessionService.getPairsByReceiver(device.device_id);

    const senders: PairedSenderItem[] = await Promise.all(
      pairs.map(async (p) => {
        const senderDevice = await deviceService.findByDeviceId(p.sender_device_id);
        return {
          pair_id: p.pair_id,
          sender_device_id: p.sender_device_id,
          device_name: p.sender_device_name || senderDevice?.device_name || 'Thiết bị gửi',
          platform: senderDevice?.platform ?? p.platform ?? 'Android',
          paired_at: p.paired_at ?? p.created_at,
          last_active_at: p.last_active_at,
          is_active: p.is_active !== false
        };
      })
    );

    res.status(200).json({
      success: true,
      count: senders.length,
      senders
    });
  }
}

