import { Request, Response } from 'express';
import { deviceService } from '../services/device.service.js';
import { channelService } from '../services/channel.service.js';

export class DeviceV2Controller {
  /**
   * POST /api/v2/devices/register (API spec §3.1) — requires device_id,
   * device_name, platform, public_key (32-byte X25519 base64); fcm_token
   * optional. Idempotent per device_id: re-calling with the same device_id
   * issues a fresh token and updates public_key/device_name (reinstall
   * policy SRD 8.2 — reinstall always generates a new device_id).
   */
  public static async registerDevice(req: Request, res: Response): Promise<void> {
    const { device_id, device_name, platform, public_key, fcm_token } = req.body as {
      device_id: string;
      device_name: string;
      platform: 'android' | 'ios';
      public_key: string;
      fcm_token?: string;
    };

    const { device, token } = await deviceService.registerDevice({
      device_id,
      device_name,
      platform,
      public_key,
      fcm_token
    });

    res.status(201).json({
      success: true,
      device_token: token,
      device_id: device.device_id
    });
  }

  /** PUT /api/v2/devices/fcm-token (§3.2). */
  public static async updateFcmToken(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { fcm_token } = req.body as { fcm_token: string };

    await deviceService.updateFcmToken(device.device_id, fcm_token);

    res.status(200).json({ success: true });
  }

  /**
   * PUT /api/v2/devices/name (§3.3) — display-only rename (no key rotation,
   * no epoch/membership_version change). Fan-out happens in a single
   * transaction: devices doc, every channel_members ACTIVE copy and every
   * PENDING pairing_requests copy.
   */
  public static async updateName(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { device_name } = req.body as { device_name: string };

    await channelService.renameDeviceEverywhere(device.device_id, device_name);

    res.status(200).json({ success: true });
  }

  /**
   * GET /api/v2/devices/me (§3.4) — returns profile info of authenticated device.
   * Useful for token verification on startup / splash screen.
   */
  public static async getMe(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    res.status(200).json({
      success: true,
      device_id: device.device_id,
      device_name: device.device_name,
      platform: device.platform,
      public_key: device.public_key,
      created_at: device.created_at
    });
  }
}
