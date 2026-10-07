import { Request, Response } from 'express';
import { pairingV2Service } from '../services/pairing.v2.service.js';
import { channelService } from '../services/channel.service.js';
import { deviceService } from '../services/device.service.js';
import { fcmService } from '../services/fcm.service.js';
import { PackageInput } from '../types/v2.js';

export class PairingV2Controller {
  /** POST /api/v2/pairing/requests — T1 member claims the QR invite (§5.1). */
  public static async claimRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { session_id, pairing_token, device_name } = req.body as {
      session_id: string;
      pairing_token: string;
      device_name: string;
    };

    const claimed = await pairingV2Service.claimSession(
      device.device_id,
      device.public_key ?? '',
      session_id,
      pairing_token,
      device_name
    );

    // Wake-up bell to the owner (best-effort, never in the consistency path — N8)
    try {
      const channel = await channelService.findChannelById(claimed.channel_id);
      if (channel) {
        const owner = await deviceService.findByDeviceId(channel.owner_device_id);
        if (owner?.fcm_token) {
          await fcmService.sendDataNotification(
            owner.fcm_token,
            {
              type: 'CHANNEL_EVENT',
              channel_id: claimed.channel_id,
              channel_name: channel.name,
              kind: 'JOIN_REQUEST',
              requester_device_name: device_name
            },
            {
              title: 'Yêu cầu tham gia kênh',
              body: `${device_name} muốn tham gia kênh "${channel.name}".`
            }
          );
        }
      }
    } catch {
      // ignore FCM failures
    }

    res.status(201).json({
      success: true,
      request_id: claimed.request_id,
      status: 'PENDING',
      channel_id: claimed.channel_id,
      channel_name: claimed.channel_name,
      owner_device_name: claimed.owner_device_name
    });
  }

  /** GET /api/v2/pairing/requests/mine — statuses of requests sent by the caller (§5.2). */
  public static async listMyRequests(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const requests = await pairingV2Service.listMyRequests(device.device_id);

    res.status(200).json({
      success: true,
      requests
    });
  }

  /** POST /api/v2/pairing/requests/approve — T2 approve + rotate (Owner package, §5.4). */
  public static async approveRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { request_id, package: pkg } = req.body as { request_id: string; package: PackageInput };

    const result = await pairingV2Service.approveRequest(device.device_id, request_id, pkg);

    // Bell: APPROVED to the requester (best-effort, N8)
    try {
      const requester = await deviceService.findByDeviceId(result.requester_device_id);
      if (requester?.fcm_token) {
        await fcmService.sendDataNotification(
          requester.fcm_token,
          {
            type: 'CHANNEL_EVENT',
            channel_id: result.channel_id,
            channel_name: result.channel_name,
            kind: 'APPROVED',
            epoch: String(result.current_epoch)
          },
          {
            title: 'Yêu cầu đã được duyệt',
            body: `Bạn đã được thêm vào kênh "${result.channel_name}". Mở app để xem OTP.`
          }
        );
      }
    } catch {
      // ignore FCM failures
    }

    res.status(200).json({
      success: true,
      current_epoch: result.current_epoch,
      membership_version: result.membership_version,
      requester_device_id: result.requester_device_id
    });
  }

  /** POST /api/v2/pairing/requests/reject — T6 (Owner, §5.5). */
  public static async rejectRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { request_id } = req.body as { request_id: string };

    await pairingV2Service.rejectRequest(device.device_id, request_id);

    res.status(200).json({ success: true });
  }

  /** POST /api/v2/pairing/requests/cancel — T6 (requester only, §5.6). */
  public static async cancelRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { request_id } = req.body as { request_id: string };

    await pairingV2Service.cancelRequest(device.device_id, request_id);

    res.status(200).json({ success: true });
  }
}
