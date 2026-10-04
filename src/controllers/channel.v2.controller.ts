import { Request, Response } from 'express';
import { channelService } from '../services/channel.service.js';
import { messageV2Service } from '../services/message.v2.service.js';
import { pairingV2Service } from '../services/pairing.v2.service.js';
import { deviceService } from '../services/device.service.js';
import { fcmService } from '../services/fcm.service.js';
import { PackageInput } from '../types/v2.js';

export class ChannelV2Controller {
  /** POST /api/v2/channels — T0 Owner package (API spec §4.1). */
  public static async createChannel(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id, name, package: pkg } = req.body as {
      channel_id?: string;
      name: string;
      package: PackageInput;
    };

    const channel = await channelService.createChannel(device, name, pkg, channel_id);

    res.status(201).json({
      success: true,
      channel_id: channel.channel_id,
      current_epoch: channel.current_epoch,
      membership_version: channel.membership_version
    });
  }

  /** GET /api/v2/channels — ACTIVE memberships of the caller, grouped by role client-side (§4.2). */
  public static async listChannels(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channels = await channelService.listChannelsForDevice(device);

    res.status(200).json({
      success: true,
      channels: channels.map((channel) => ({
        channel_id: channel.channel_id,
        name: channel.name,
        role: channel.role,
        status: channel.status,
        current_epoch: channel.current_epoch,
        membership_version: channel.membership_version,
        member_count: channel.member_count,
        my_joined_epoch: channel.my_joined_epoch,
        owner_device_name: channel.owner_device_name
      }))
    });
  }

  /**
   * GET /api/v2/channels/detail?channel_id= (§4.3): channel + caller state.
   * 403 REVOKED if previously a member and revoked; 404 if never a member.
   */
  public static async getDetail(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);

    const member = await channelService.requireActiveMember(channelId, device.device_id);
    const channel = await channelService.findChannelById(channelId);
    const ownerDevice = await deviceService.findByDeviceId(channel!.owner_device_id);

    res.status(200).json({
      success: true,
      channel: {
        channel_id: channel!.channel_id,
        name: channel!.name,
        owner_device_id: channel!.owner_device_id,
        current_epoch: channel!.current_epoch,
        membership_version: channel!.membership_version,
        member_count: channel!.member_count,
        status: channel!.status,
        created_at: channel!.created_at
      },
      my_role: channel!.owner_device_id === device.device_id ? 'OWNER' : 'MEMBER',
      my_status: member.status,
      my_joined_epoch: member.joined_epoch,
      my_provisioned_epoch: member.provisioned_epoch,
      owner_device_name: ownerDevice?.device_name ?? '',
      // Member cần pk_owner để derive KEK khi unwrap envelope (SRD 7.2)
      owner_public_key: ownerDevice?.public_key ?? ''
    });
  }

  /** GET /api/v2/channels/members?channel_id= (§4.4): Owner sees all, Member ACTIVE only. */
  public static async getMembers(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);

    await channelService.requireActiveMember(channelId, device.device_id);
    const channel = await channelService.findChannelById(channelId);
    const isOwner = channel?.owner_device_id === device.device_id;

    const members = isOwner
      ? await channelService.listMembers(channelId)
      : await channelService.listActiveMembers(channelId);

    res.status(200).json({
      success: true,
      members: members.map((member) => ({
        device_id: member.device_id,
        device_name: member.device_name,
        public_key: member.public_key,
        status: member.status,
        joined_epoch: member.joined_epoch,
        provisioned_epoch: member.provisioned_epoch,
        joined_at: member.joined_at
      }))
    });
  }

  /** GET /api/v2/channels/key-envelope?channel_id=&epoch= (§6.1). */
  public static async getKeyEnvelope(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);
    const epochRaw = req.query.epoch;
    // validateQuery may already coerce `epoch` to a number (zod) — accept both
    const epoch =
      epochRaw === undefined || epochRaw === null || epochRaw === ''
        ? undefined
        : Number(epochRaw);

    const envelope = await channelService.getKeyEnvelope(channelId, device.device_id, epoch);

    res.status(200).json({
      success: true,
      key_epoch: envelope.key_epoch,
      wrapped_key: envelope.wrapped_key,
      nonce: envelope.nonce,
      kek_alg: envelope.kek_alg
    });
  }

  /** POST /api/v2/channels/revoke — T4 revoke + auto-rotate (Owner package, §4.6). */
  public static async revoke(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id, revoke_device_ids, package: pkg } = req.body as {
      channel_id: string;
      revoke_device_ids: string[];
      package: PackageInput;
    };

    const result = await channelService.revokeMembers(device.device_id, channel_id, revoke_device_ids, pkg);

    // FCM bell to every revoked device (best-effort, N8)
    await Promise.all(
      result.revoked.map(async (revokedId) => {
        const target = await deviceService.findByDeviceId(revokedId);
        if (!target?.fcm_token) return;
        try {
          await fcmService.sendDataNotification(target.fcm_token, {
            type: 'CHANNEL_EVENT',
            channel_id,
            kind: 'REVOKED',
            epoch: String(result.current_epoch)
          });
        } catch {
          // ignore
        }
      })
    );

    res.status(200).json({
      success: true,
      current_epoch: result.current_epoch,
      membership_version: result.membership_version
    });
  }
}

export class PairingChannelV2Controller {
  /** POST /api/v2/channels/sessions — Owner creates a single-use QR invite (§4.5). */
  public static async createSession(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id } = req.body as { channel_id: string };

    const session = await pairingV2Service.createSession(device.device_id, channel_id);

    res.status(201).json({
      success: true,
      session_id: session.session_id,
      pairing_token: session.pairing_token,
      expires_at: session.expires_at,
      invite_url: session.invite_url
    });
  }

  /** GET /api/v2/channels/requests?channel_id=&status= — Owner approval queue (§5.3). */
  public static async listRequests(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);
    const status = String(req.query.status ?? 'PENDING');

    const requests = await pairingV2Service.listChannelRequests(device.device_id, channelId, status);

    res.status(200).json({
      success: true,
      requests
    });
  }
}

export class MessageV2Controller {
  /** POST /api/v2/channels/messages — T5 + T3 (Owner only, §6.2). */
  public static async sendMessage(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const body = req.body as {
      channel_id: string;
      request_epoch: number;
      ciphertext: string;
      nonce: string;
    };

    const result = await messageV2Service.sendMessage(device.device_id, body);

    res.status(201).json({
      success: true,
      message_id: result.message_id,
      sequence_number: result.sequence_number,
      server_received_at: result.server_received_at
    });
  }

  /** GET /api/v2/messages?date=&tz_offset= — channel-agnostic day fetch (§6.3). */
  public static async fetchMessages(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const date = String(req.query.date);
    const tzOffset = Number(req.query.tz_offset ?? 0);

    const { messages, truncated } = await messageV2Service.fetchMessagesByDate(device.device_id, date, tzOffset);

    res.status(200).json({
      success: true,
      date,
      messages,
      truncated
    });
  }
}
