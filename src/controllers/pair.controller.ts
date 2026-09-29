import { Request, Response } from 'express';
import { sessionService } from '../services/session.service.js';
import { PairConfirmRequest, PairStatusResponse } from '../types/index.js';

export class PairController {
  public static async confirmPairing(req: Request, res: Response): Promise<void> {
    const { pair_id, fcm_token, device_name, platform }: PairConfirmRequest = req.body;

    const session = sessionService.saveSession(
      pair_id,
      fcm_token,
      device_name,
      platform
    );

    res.status(200).json({
      success: true,
      message: 'Device paired successfully with FCM token registered',
      pair_id: session.pairId,
      expires_at: session.expiresAt
    });
  }

  public static async getPairStatus(req: Request, res: Response): Promise<void> {
    const pairId = String(req.params.pairId);
    const session = sessionService.getSession(pairId);

    if (!session) {
      const response: PairStatusResponse = {
        pair_id: pairId,
        is_paired: false
      };
      res.status(200).json(response);
      return;
    }

    const response: PairStatusResponse = {
      pair_id: session.pairId,
      is_paired: true,
      device_name: session.deviceName,
      platform: session.platform,
      paired_at: session.pairedAt,
      expires_at: session.expiresAt
    };

    res.status(200).json(response);
  }

  public static async revokePairing(req: Request, res: Response): Promise<void> {
    const pairId = String(req.params.pairId);
    const removed = sessionService.removeSession(pairId);

    res.status(200).json({
      success: true,
      message: removed ? 'Pairing session revoked successfully' : 'Session was not found or already expired'
    });
  }
}
