import { Request, Response } from 'express';
import { channelService } from '../services/channel.service.js';
import { pairingService } from '../services/pairing.service.js';
import { messageV2Service } from '../services/message.v2.service.js';
import { deviceService } from '../services/device.service.js';
import { fcmService } from '../services/fcm.service.js';
import { env } from '../config/env.js';
import { EnvelopeInput } from '../services/channel.service.js';

/** QR invite format per task spec 2.2.7: smsnavigator://join?ch=...&token=...&srv=... */
function buildQrData(channelId: string, token: string): string {
  return `smsnavigator://join?ch=${encodeURIComponent(channelId)}&token=${token}&srv=${encodeURIComponent(env.SERVER_BASE_URL)}`;
}

export class ChannelV2Controller {
  /** POST /api/v2/channels — caller becomes Owner at epoch 1. */
  public static async createChannel(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_name } = req.body as { channel_name: string };

    const channel = await channelService.createChannel(device, channel_name);

    res.status(201).json({
      success: true,
      channel_id: channel.channel_id,
      channel_name: channel.channel_name,
      current_epoch: channel.current_epoch,
      sequence_counter: channel.sequence_counter,
      member_count: 1,
      created_at: channel.created_at
    });
  }

  /** GET /api/v2/channels — ACTIVE memberships of the caller, with role. */
  public static async listChannels(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channels = await channelService.listChannelsForDevice(device.device_id);

    res.status(200).json({
      success: true,
      count: channels.length,
      channels: channels.map((channel) => ({
        channel_id: channel.channel_id,
        channel_name: channel.channel_name,
        role: channel.role,
        status: channel.status,
        current_epoch: channel.current_epoch,
        member_count: channel.member_count,
        joined_epoch: channel.joined_epoch,
        owner_device_id: channel.owner_device_id,
        created_at: channel.created_at
      }))
    });
  }

  /** GET /api/v2/channels/detail?channel_id= — ACTIVE members only (KL12). */
  public static async getDetail(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);

    const member = await channelService.requireActiveMember(channelId, device.device_id);
    const channel = await channelService.findChannelById(channelId);
    const memberCount = await channelService.countActiveMembers(channelId);

    res.status(200).json({
      success: true,
      channel: {
        channel_id: channel!.channel_id,
        channel_name: channel!.channel_name,
        owner_device_id: channel!.owner_device_id,
        current_epoch: channel!.current_epoch,
        member_count: memberCount,
        status: channel!.is_active ? 'ACTIVE' : 'ARCHIVED',
        created_at: channel!.created_at
      },
      my_role: member.role,
      my_status: member.status,
      my_joined_epoch: member.joined_epoch
    });
  }

  /** GET /api/v2/channels/members?channel_id= — ACTIVE member list. */
  public static async getMembers(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);

    await channelService.requireActiveMember(channelId, device.device_id);
    const members = await channelService.listActiveMembers(channelId);

    res.status(200).json({
      success: true,
      count: members.length,
      members: members.map((member) => ({
        device_id: member.device_id,
        device_name: member.device_name,
        public_key: member.public_key,
        role: member.role,
        status: member.status,
        joined_epoch: member.joined_epoch,
        joined_at: member.joined_at
      }))
    });
  }

  /** GET /api/v2/channels/key-envelope?channel_id=&epoch= — per-member envelope. */
  public static async getKeyEnvelope(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);
    const epoch = Number(req.query.epoch);

    // KL12: a revoked member gets no envelope at all - not even an old epoch
    await channelService.requireActiveMember(channelId, device.device_id);

    const envelope = await channelService.getEnvelope(channelId, device.device_id, epoch);
    if (!envelope) {
      res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: `No key envelope provisioned for epoch ${epoch}`
      });
      return;
    }

    res.status(200).json({
      success: true,
      channel_id: envelope.channel_id,
      device_id: envelope.device_id,
      epoch: envelope.epoch,
      encrypted_key: envelope.encrypted_key,
      iv: envelope.iv,
      sender_ephemeral_pubkey: envelope.sender_ephemeral_pubkey,
      created_at: envelope.created_at,
      fetched_at: envelope.fetched_at
    });
  }

  /** POST /api/v2/channels/revoke — T4 revoke + auto-rotate (Owner package). */
  public static async revoke(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id, target_device_ids, new_epoch, envelopes } = req.body as {
      channel_id: string;
      target_device_ids: string[];
      new_epoch: number;
      envelopes: EnvelopeInput[];
    };

    const { channel, revoked } = await channelService.revokeMembers(
      device.device_id,
      channel_id,
      target_device_ids,
      new_epoch,
      envelopes
    );

    // FCM bell to every revoked device (best-effort, N8)
    await Promise.all(
      revoked.map(async (deviceId) => {
        const target = await deviceService.findByDeviceId(deviceId);
        if (!target?.fcm_token) return;
        try {
          await fcmService.sendDataNotification(target.fcm_token, {
            type: 'CHANNEL_EVENT',
            kind: 'REVOKED',
            channel_id,
            epoch: String(new_epoch)
          });
        } catch {
          // ignore
        }
      })
    );

    res.status(200).json({
      success: true,
      channel_id: channel.channel_id,
      current_epoch: channel.current_epoch,
      revoked_device_ids: revoked
    });
  }
}

export class PairingChannelV2Controller {
  /** POST /api/v2/channels/sessions — Owner creates a single-use QR session. */
  public static async createSession(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const { channel_id } = req.body as { channel_id: string };

    const session = await pairingService.createSession(device, channel_id);

    res.status(201).json({
      success: true,
      session_id: session.session_id,
      channel_id: session.channel_id,
      token: session.token,
      qr_data: buildQrData(session.channel_id, session.token),
      expires_at: session.expires_at
    });
  }

  /** GET /api/v2/channels/requests?channel_id=&status= — Owner approval queue. */
  public static async listRequests(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const channelId = String(req.query.channel_id);
    const status = String(req.query.status ?? 'PENDING') as 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

    await channelService.requireOwner(channelId, device.device_id);
    const requests = await pairingService.listRequests(channelId, status);

    res.status(200).json({
      success: true,
      count: requests.length,
      requests: requests.map((request) => ({
        request_id: request.request_id,
        channel_id: request.channel_id,
        requester_device_id: request.requester_device_id,
        requester_device_name: request.requester_device_name,
        requester_public_key: request.requester_public_key,
        status: request.status,
        created_at: request.created_at
      }))
    });
  }
}

export class MessageV2Controller {
  /** POST /api/v2/channels/messages — T5 + T3 (Owner only). */
  public static async sendMessage(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const body = req.body as {
      channel_id: string;
      request_epoch: number;
      ciphertext: string;
      iv: string;
      sender_ephemeral_pubkey: string;
      sent_at: string;
      expires_at?: string;
    };

    const result = await messageV2Service.sendMessage(device.device_id, body);

    res.status(201).json({
      success: true,
      message_id: result.message_id,
      channel_id: result.channel_id,
      sequence_number: result.sequence_number,
      epoch: result.epoch,
      server_received_at: result.server_received_at
    });
  }

  /** GET /api/v2/messages?date=&tz_offset= — channel-agnostic day fetch. */
  public static async fetchMessages(req: Request, res: Response): Promise<void> {
    const device = req.device!;
    const date = String(req.query.date);
    const tzOffset = Number(req.query.tz_offset ?? 0);

    const { messages, truncated } = await messageV2Service.fetchMessagesByDate(device.device_id, date, tzOffset);

    res.status(200).json({
      success: true,
      date,
      count: messages.length,
      truncated,
      messages
    });
  }
}
