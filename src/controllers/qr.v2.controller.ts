import { Request, Response } from 'express';
import { pairingV2Service } from '../services/pairing.v2.service.js';

export class QrV2Controller {
  /**
   * GET /api/v2/qr/resolve?code= (roadmap v3.3 §2.3.B): opaque QR → typed
   * preview. Read-only; never returns session ids or pairing tokens.
   */
  public static async resolve(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const code = String(req.query.code);

    // Only PAIRING exists today; qrCodeService rejects other types with 422
    // UNSUPPORTED_QR_TYPE before we get here.
    const preview = await pairingV2Service.previewByCode(device.device_id, code);

    res.status(200).json({
      success: true,
      type: 'PAIRING',
      version: 1,
      data: {
        channel_id: preview.channel_id,
        channel_name: preview.channel_name,
        owner_device_name: preview.owner_device_name,
        expires_at: preview.expires_at
      }
    });
  }
}
