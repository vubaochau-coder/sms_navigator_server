import { Request, Response } from 'express';
import { pairingService } from '../services/pairing.service.js';
import { channelService } from '../services/channel.service.js';
import { deviceService } from '../services/device.service.js';
import { fcmService } from '../services/fcm.service.js';
import { EnvelopeInput } from '../services/channel.service.js';

export class PairingV2Controller {
  /** POST /api/v2/pairing/requests — T1 member claims the QR token. */
  public static async claimRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { token, encrypted_device_name } = req.body as {
      token: string;
      encrypted_device_name?: string;
    };

    const claimed = await pairingService.claimSession(device, token, encrypted_device_name);

    // Wake-up bell to the owner (best-effort, never in the consistency path)
    try {
      const channel = await channelService.findChannelById(claimed.channel_id);
      if (channel) {
        const owner = await deviceService.findByDeviceId(channel.owner_device_id);
        if (owner?.fcm_token) {
          await fcmService.sendDataNotification(owner.fcm_token, {
            type: 'CHANNEL_EVENT',
            kind: 'JOIN_REQUEST',
            channel_id: claimed.channel_id
          });
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

  /** POST /api/v2/pairing/requests/approve — T2 approve + rotate epoch. */
  public static async approveRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id, request_id, new_epoch, envelopes } = req.body as {
      channel_id: string;
      request_id: string;
      new_epoch: number;
      envelopes: EnvelopeInput[];
    };

    const result = await pairingService.approveRequest(device.device_id, channel_id, request_id, new_epoch, envelopes);

    // Bells: REQUEST_APPROVED to the requester + CHANNEL_KEY_ROTATED to the
    // existing ACTIVE members that just received a fresh-epoch envelope.
    try {
      const members = await channelService.listActiveMembers(channel_id);
      await Promise.all(
        members.map(async (member) => {
          const memberDevice = await deviceService.findByDeviceId(member.device_id);
          if (!memberDevice?.fcm_token) return;
          const kind = member.device_id === result.requester_device_id ? 'REQUEST_APPROVED' : 'CHANNEL_KEY_ROTATED';
          await fcmService.sendDataNotification(memberDevice.fcm_token, {
            type: 'CHANNEL_EVENT',
            kind,
            channel_id,
            epoch: String(new_epoch)
          });
        })
      );
    } catch {
      // ignore FCM failures
    }

    res.status(200).json({
      success: true,
      request_id,
      status: 'APPROVED',
      requester_device_id: result.requester_device_id,
      current_epoch: result.current_epoch
    });
  }

  /** POST /api/v2/pairing/requests/reject — T6 (Owner). */
  public static async rejectRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id, request_id } = req.body as { channel_id: string; request_id: string };

    await pairingService.rejectRequest(device.device_id, channel_id, request_id);

    res.status(200).json({
      success: true,
      request_id,
      status: 'REJECTED'
    });
  }

  /** POST /api/v2/pairing/requests/cancel — T6 (requester only). */
  public static async cancelRequest(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id, request_id } = req.body as { channel_id: string; request_id: string };

    await pairingService.cancelRequest(device.device_id, channel_id, request_id);

    res.status(200).json({
      success: true,
      request_id,
      status: 'CANCELLED'
    });
  }
}
