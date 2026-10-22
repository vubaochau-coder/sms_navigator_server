import request from 'supertest';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import { KEK_ALG } from '../../src/types/v2.js';

/**
 * Supertest helpers for the v2 channel API, shared by the newer test files
 * (same flows as the private helpers in api-v2.test.ts).
 */
export interface DeviceCtx {
  deviceId: string;
  token: string;
  publicKey: string;
  deviceName: string;
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const nonce12 = (): string => crypto.randomBytes(12).toString('base64');

export const packageFor = (deviceIds: string[], baseEpoch: number, baseVersion: number, newEpoch: number) => ({
  base_epoch: baseEpoch,
  base_membership_version: baseVersion,
  envelopes: deviceIds.map((id) => ({
    device_id: id,
    key_epoch: newEpoch,
    wrapped_key: crypto.randomBytes(32).toString('base64'),
    nonce: nonce12(),
    kek_alg: KEK_ALG
  }))
});

export function v2Client(server: () => Server) {
  const api = () => request(server());

  const reg = async (deviceName: string): Promise<DeviceCtx> => {
    const publicKey = crypto.randomBytes(32).toString('base64');
    const res = await api()
      .post('/api/v2/devices/register')
      .send({ device_id: randomUUID(), device_name: deviceName, platform: 'android', public_key: publicKey });
    expect(res.status).toBe(201);
    return { deviceId: res.body.device_id, token: res.body.device_token, publicKey, deviceName };
  };

  const createChannel = async (owner: DeviceCtx, name = 'Kênh OTP'): Promise<string> => {
    const res = await api()
      .post('/api/v2/channels')
      .set(bearer(owner.token))
      .send({ name, package: packageFor([owner.deviceId], 1, 1, 1) });
    expect(res.status).toBe(201);
    return res.body.channel_id;
  };

  const detail = (dev: DeviceCtx, channelId: string) =>
    api().get(`/api/v2/channels/detail?channel_id=${channelId}`).set(bearer(dev.token));

  const activeMemberIds = async (owner: DeviceCtx, channelId: string): Promise<string[]> => {
    const res = await api().get(`/api/v2/channels/members?channel_id=${channelId}`).set(bearer(owner.token));
    expect(res.status).toBe(200);
    return res.body.members.filter((m: any) => m.status === 'ACTIVE').map((m: any) => m.device_id as string);
  };

  /** QR session + claim; returns the PENDING request id. */
  const claim = async (owner: DeviceCtx, channelId: string, member: DeviceCtx): Promise<string> => {
    const session = await api().post('/api/v2/channels/sessions').set(bearer(owner.token)).send({ channel_id: channelId });
    expect(session.status).toBe(201);
    const res = await api()
      .post('/api/v2/pairing/requests')
      .set(bearer(member.token))
      .send({ code: session.body.code, device_name: member.deviceName });
    expect(res.status).toBe(201);
    return res.body.request_id;
  };

  /** Full T1 + T2 join; returns the new epoch. */
  const join = async (owner: DeviceCtx, channelId: string, member: DeviceCtx): Promise<number> => {
    const requestId = await claim(owner, channelId, member);
    const state = (await detail(owner, channelId)).body.channel;
    const ids = await activeMemberIds(owner, channelId);
    const res = await api()
      .post('/api/v2/pairing/requests/approve')
      .set(bearer(owner.token))
      .send({
        request_id: requestId,
        package: packageFor([...ids, member.deviceId], state.current_epoch, state.membership_version, state.current_epoch + 1)
      });
    expect(res.status).toBe(200);
    return res.body.current_epoch;
  };

  return { api, reg, createChannel, detail, activeMemberIds, claim, join };
}
