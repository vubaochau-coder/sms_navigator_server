/// <reference types="jest" />

import * as crypto from 'crypto';
import type { Server } from 'http';
import { createApp } from '../src/app.js';
import { mockFirestore } from '../src/config/firestore-mock.js';
import { fcmService } from '../src/services/fcm.service.js';
import { bearer, packageFor, v2Client, type DeviceCtx } from './helpers/v2-client.js';

describe('Channel lifecycle — leave / rotate / archive (§4.9–4.11, BACKLOG 2.2)', () => {
  let server: Server;
  const c = v2Client(() => server);

  beforeAll((done) => {
    server = createApp().listen(0, done);
  });
  afterAll((done) => {
    server.close(done);
  });
  beforeEach(() => mockFirestore.reset());

  const today = new Date().toISOString().slice(0, 10);
  const post = (path: string, dev: DeviceCtx, body: Record<string, unknown>) =>
    c.api().post(path).set(bearer(dev.token)).send(body);
  const send = (owner: DeviceCtx, channelId: string, epoch: number) =>
    post('/api/v2/channels/messages', owner, {
      channel_id: channelId,
      request_epoch: epoch,
      ciphertext: crypto.randomBytes(16).toString('base64'),
      nonce: crypto.randomBytes(12).toString('base64')
    });
  const withFcm = async (dev: DeviceCtx, token: string) =>
    c.api().put('/api/v2/devices/fcm-token').set(bearer(dev.token)).send({ fcm_token: token });

  /** Owner + one joined member; returns the epoch after the join. */
  const setup = async () => {
    const owner = await c.reg('Owner');
    const member = await c.reg('Member');
    const channelId = await c.createChannel(owner, 'Kênh nhà');
    const epoch = await c.join(owner, channelId, member);
    return { owner, member, channelId, epoch };
  };

  describe('POST /channels/leave', () => {
    it('member leaves: access ends at once, owner keeps relaying, rotation is flagged', async () => {
      const { owner, member, channelId, epoch } = await setup();
      await withFcm(owner, 'fcm-owner');
      const fcmSpy = jest.spyOn(fcmService, 'sendDataNotification');

      const res = await post('/api/v2/channels/leave', member, { channel_id: channelId });
      expect(res.status).toBe(200);

      expect((await c.detail(member, channelId)).status).toBe(403);
      const ownerView = await c.detail(owner, channelId);
      expect(ownerView.body.rotation_pending).toBe(true);
      expect(ownerView.body.channel.member_count).toBe(1);
      expect(ownerView.body.channel.current_epoch).toBe(epoch);

      // Owner can still send on the current epoch until it rotates
      expect((await send(owner, channelId, epoch)).status).toBe(201);
      const memberMessages = await c.api().get(`/api/v2/messages?date=${today}`).set(bearer(member.token));
      expect(memberMessages.body.messages).toHaveLength(0);

      expect(fcmSpy).toHaveBeenCalledWith(
        'fcm-owner',
        expect.objectContaining({ kind: 'MEMBER_LEFT', channel_id: channelId, device_name: 'Member' }),
        expect.objectContaining({ title: 'Thành viên rời kênh' })
      );
      fcmSpy.mockRestore();
    });

    it('400 OWNER_CANNOT_LEAVE for the owner, 403 on a second leave, 404 for a stranger', async () => {
      const { owner, member, channelId } = await setup();
      const stranger = await c.reg('Stranger');

      const ownerLeave = await post('/api/v2/channels/leave', owner, { channel_id: channelId });
      expect(ownerLeave.status).toBe(400);
      expect(ownerLeave.body.error).toBe('OWNER_CANNOT_LEAVE');

      expect((await post('/api/v2/channels/leave', member, { channel_id: channelId })).status).toBe(200);
      expect((await post('/api/v2/channels/leave', member, { channel_id: channelId })).status).toBe(403);
      expect((await post('/api/v2/channels/leave', stranger, { channel_id: channelId })).status).toBe(404);
    });

    it('a member who left can be invited again (rejoin)', async () => {
      const { owner, member, channelId } = await setup();
      await post('/api/v2/channels/leave', member, { channel_id: channelId });

      await c.join(owner, channelId, member);
      expect((await c.detail(member, channelId)).status).toBe(200);
      expect((await c.detail(owner, channelId)).body.rotation_pending).toBe(false);
    });
  });

  describe('POST /channels/rotate', () => {
    it('re-keys {Owner} ∪ ACTIVE at N+1 and clears rotation_pending; retry is idempotent', async () => {
      const { owner, member, channelId, epoch } = await setup();
      const stayer = await c.reg('Stayer');
      const epoch2 = await c.join(owner, channelId, stayer);
      expect(epoch2).toBe(epoch + 1);
      await post('/api/v2/channels/leave', member, { channel_id: channelId });

      const state = (await c.detail(owner, channelId)).body.channel;
      const pkg = packageFor([owner.deviceId, stayer.deviceId], state.current_epoch, state.membership_version, state.current_epoch + 1);
      const res = await post('/api/v2/channels/rotate', owner, { channel_id: channelId, package: pkg });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ current_epoch: epoch2 + 1, replayed: false });

      const after = await c.detail(owner, channelId);
      expect(after.body.rotation_pending).toBe(false);
      expect(after.body.channel.current_epoch).toBe(epoch2 + 1);

      // Stayer is provisioned at the new epoch; the leaver is not
      const stayerKey = await c.api().get(`/api/v2/channels/key-envelope?channel_id=${channelId}`).set(bearer(stayer.token));
      expect(stayerKey.body.key_epoch).toBe(epoch2 + 1);

      const retry = await post('/api/v2/channels/rotate', owner, { channel_id: channelId, package: pkg });
      expect(retry.status).toBe(200);
      expect(retry.body.replayed).toBe(true);

      // Old epoch is now outdated for sends
      expect((await send(owner, channelId, epoch2)).status).toBe(409);
      expect((await send(owner, channelId, epoch2 + 1)).status).toBe(201);
    });

    it('422 when the package skips an ACTIVE member or includes the leaver; 403 for a member', async () => {
      const { owner, member, channelId } = await setup();
      const stayer = await c.reg('Stayer');
      await c.join(owner, channelId, stayer);
      await post('/api/v2/channels/leave', member, { channel_id: channelId });
      const s = (await c.detail(owner, channelId)).body.channel;

      const missing = packageFor([owner.deviceId], s.current_epoch, s.membership_version, s.current_epoch + 1);
      expect((await post('/api/v2/channels/rotate', owner, { channel_id: channelId, package: missing })).status).toBe(422);

      const withLeaver = packageFor([owner.deviceId, stayer.deviceId, member.deviceId], s.current_epoch, s.membership_version, s.current_epoch + 1);
      expect((await post('/api/v2/channels/rotate', owner, { channel_id: channelId, package: withLeaver })).status).toBe(422);

      const ok = packageFor([owner.deviceId, stayer.deviceId], s.current_epoch, s.membership_version, s.current_epoch + 1);
      expect((await post('/api/v2/channels/rotate', stayer, { channel_id: channelId, package: ok })).status).toBe(403);
    });
  });

  describe('POST /channels/archive', () => {
    it('dissolves the channel: hidden from lists, no sends/invites, pending requests cancelled, members belled', async () => {
      const { owner, member, channelId, epoch } = await setup();
      expect((await send(owner, channelId, epoch)).status).toBe(201);
      const waiting = await c.reg('Waiting');
      await c.claim(owner, channelId, waiting);
      const session = await post('/api/v2/channels/sessions', owner, { channel_id: channelId });
      await withFcm(member, 'fcm-member');
      const fcmSpy = jest.spyOn(fcmService, 'sendDataNotification');

      const res = await post('/api/v2/channels/archive', owner, { channel_id: channelId });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ARCHIVED', replayed: false });

      for (const dev of [owner, member]) {
        const list = await c.api().get('/api/v2/channels').set(bearer(dev.token));
        expect(list.body.channels).toHaveLength(0);
        const msgs = await c.api().get(`/api/v2/messages?date=${today}`).set(bearer(dev.token));
        expect(msgs.body.messages).toHaveLength(0);
      }
      expect((await c.detail(owner, channelId)).body.channel.status).toBe('ARCHIVED');
      expect((await send(owner, channelId, epoch)).status).toBe(409);
      const newInvite = await post('/api/v2/channels/sessions', owner, { channel_id: channelId });
      expect(newInvite.status).toBe(409);
      expect(newInvite.body.error).toBe('CHANNEL_NOT_ACTIVE');

      // The old invite no longer works and the waiting request was cancelled
      const late = await c.reg('Late');
      const claimOld = await post('/api/v2/pairing/requests', late, { code: session.body.code, device_name: 'Late' });
      expect([409, 410]).toContain(claimOld.status);
      const mine = await c.api().get('/api/v2/pairing/requests/mine').set(bearer(waiting.token));
      expect(mine.body.requests[0].status).toBe('CANCELLED');

      expect(fcmSpy).toHaveBeenCalledWith(
        'fcm-member',
        expect.objectContaining({ kind: 'REVOKED', reason: 'ARCHIVED', channel_id: channelId }),
        expect.objectContaining({ title: 'Kênh đã giải tán' })
      );
      fcmSpy.mockRestore();
    });

    it('is idempotent and owner-only; rename / leave on an archived channel → 409', async () => {
      const { owner, member, channelId } = await setup();

      expect((await post('/api/v2/channels/archive', member, { channel_id: channelId })).status).toBe(403);
      expect((await post('/api/v2/channels/archive', owner, { channel_id: channelId })).body.replayed).toBe(false);
      expect((await post('/api/v2/channels/archive', owner, { channel_id: channelId })).body.replayed).toBe(true);

      const rename = await c.api().put('/api/v2/channels/name').set(bearer(owner.token)).send({ channel_id: channelId, name: 'X' });
      expect(rename.status).toBe(409);
      const leave = await post('/api/v2/channels/leave', member, { channel_id: channelId });
      expect(leave.status).toBe(409);
      expect(leave.body.error).toBe('CHANNEL_NOT_ACTIVE');
    });
  });
});
