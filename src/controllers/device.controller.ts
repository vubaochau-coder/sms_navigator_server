import { Request, Response } from 'express';
import { deviceService } from '../services/device.service.js';
import { sessionService } from '../services/session.service.js';
import { DeviceFcmTokenRequest, DeviceRegisterRequest } from '../types/index.js';

export class DeviceController {
  public static async registerDevice(req: Request, res: Response): Promise<void> {
    const { device_id, device_name, platform } = req.body as DeviceRegisterRequest;

    const { device, token } = deviceService.registerDevice({ device_id, device_name, platform });

    res.status(201).json({
      success: true,
      message: 'Device registered successfully. Store the token securely, it cannot be retrieved again.',
      device_id: device.device_id,
      token,
      token_type: 'Bearer',
      created_at: device.created_at
    });
  }

  public static async updateFcmToken(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { fcm_token } = req.body as DeviceFcmTokenRequest;

    const updated = deviceService.updateFcmToken(device.device_id, fcm_token);
    sessionService.updateReceiverFcmToken(device.device_id, fcm_token);

    res.status(200).json({
      success: true,
      message: 'FCM token updated successfully',
      device_id: updated!.device_id
    });
  }
}
