import { Request, Response } from 'express';
import { deviceService } from '../services/device.service.js';
import { channelService } from '../services/channel.service.js';
import { DeviceRegisterInput } from '../services/device.service.js';

export class DeviceV2Controller {
  /**
   * POST /api/v2/devices/register — requires a 32-byte X25519 public key.
   * Idempotent per device_id (reinstall policy) and per public_key: re-calling
   * with the same identity reuses the device record and issues a fresh token.
   */
  public static async registerDevice(req: Request, res: Response): Promise<void> {
    const { public_key, device_name, platform, device_id } = req.body as DeviceRegisterInput & {
      public_key: string;
    };

    // Same identity key without an explicit device_id → same installation
    const matchByKey = device_id ? null : await deviceService.findByPublicKey(public_key);

    const { device, token } = await deviceService.registerDevice({
      device_id: device_id ?? matchByKey?.device_id,
      public_key,
      device_name,
      platform
    });

    res.status(201).json({
      success: true,
      device_token: token,
      device_id: device.device_id,
      device_name: device.device_name ?? '',
      platform: device.platform ?? 'unknown',
      created_at: device.created_at
    });
  }

  /**
   * PUT /api/v2/devices/name — display-only rename (no key rotation, no epoch
   * change). Fan-out happens in a single transaction: devices doc, every
   * channel_members ACTIVE copy and every PENDING pairing_requests copy.
   */
  public static async updateName(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { device_name } = req.body as { device_name: string };

    await channelService.renameDeviceEverywhere(device.device_id, device_name);

    res.status(200).json({
      success: true,
      device_id: device.device_id,
      device_name
    });
  }
}
