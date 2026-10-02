import request from 'supertest';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { createApp } from '../src/app.js';
import { sessionService } from '../src/services/session.service.js';
import { deviceService } from '../src/services/device.service.js';
import { channelService } from '../src/services/channel.service.js';
import { pairingService } from '../src/services/pairing.service.js';
import { messageV2Service } from '../src/services/message.v2.service.js';
import { fcmService } from '../src/services/fcm.service.js';
import { mockFirestore } from '../src/config/firestore-mock.js';
import { nowIso } from '../src/utils/time.js';

describe('SMS Navigator Server — API v2 (Channel 1-to-N E2EE)', () => {
  const expressApp = createApp();
  let server: any;

  beforeAll((done) => {
    server = expressApp.listen(0, done);
  });

  afterAll((done) => {
    sessionService.destroy();
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  // ------------------------------------------------------------------ helpers
  interface DeviceCtx {
    deviceId: string;
    token: string;
    publicKey: string;
    deviceName: string;
  }

  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const fakePubkey = (): string => crypto.randomBytes(32).toString('base64');

  const uniqueB64 = (): string => crypto.randomBytes(24).toString('base64');

  const expectIso8601 = (value: string) => {
    expect(typeof value).toBe('string');
    expect(new Date(value).toISOString()).toBe(value);
  };

  const reg = async (deviceName: string, platform = 'android'): Promise<DeviceCtx> => {
    const publicKey = fakePubkey();
    const res = await request(server)
      .post('/api/v2/devices/register')
      .send({ public_key: publicKey, device_name: deviceName, platform });
    expect(res.status).toBe(201);
    return {
      deviceId: res.body.device_id,
      token: res.body.device_token,
      publicKey,
      deviceName
    };
  };

  const envelope = (deviceId: string, epoch: number) => ({
    device_id: deviceId,
    encrypted_key: Buffer.from(`ck_${epoch}_${deviceId}`).toString('base64'),
    iv: crypto.randomBytes(12).toString('base64'),
    sender_ephemeral_pubkey: fakePubkey()
  });

  const envelopesFor = (deviceIds: string[], epoch: number) => deviceIds.map((id) => envelope(id, epoch));

  const createChannelV2 = async (owner: DeviceCtx, channelName: string): Promise<string> => {
    const res = await request(server)
      .post('/api/v2/channels')
      .set(bearer(owner.token))
      .send({ channel_name: channelName });
    expect(res.status).toBe(201);
    return res.body.channel_id as string;
  };

  const currentEpoch = async (token: string, channelId: string): Promise<number> => {
    const res = await request(server)
      .get(`/api/v2/channels/detail?channel_id=${channelId}`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    return res.body.channel.current_epoch as number;
  };

  const activeMemberIds = async (token: string, channelId: string): Promise<string[]> => {
    const res = await request(server)
      .get(`/api/v2/channels/members?channel_id=${channelId}`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    return res.body.members.map((m: any) => m.device_id as string);
  };

  /** Full join flow: owner creates QR → member claims → owner approves (rotates epoch). */
  const joinChannel = async (owner: DeviceCtx, channelId: string, member: DeviceCtx): Promise<number> => {
    const sessionRes = await request(server)
      .post('/api/v2/channels/sessions')
      .set(bearer(owner.token))
      .send({ channel_id: channelId });
    expect(sessionRes.status).toBe(201);

    const claimRes = await request(server)
      .post('/api/v2/pairing/requests')
      .set(bearer(member.token))
      .send({ token: sessionRes.body.token });
    expect(claimRes.status).toBe(201);

    const epoch = (await currentEpoch(owner.token, channelId)) + 1;
    const ids = await activeMemberIds(owner.token, channelId);

    const approveRes = await request(server)
      .post('/api/v2/pairing/requests/approve')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        request_id: claimRes.body.request_id,
        new_epoch: epoch,
        envelopes: envelopesFor([...ids, member.deviceId], epoch)
      });
    expect(approveRes.status).toBe(200);
    return epoch;
  };

  const messageBody = (channelId: string, requestEpoch: number) => ({
    channel_id: channelId,
    request_epoch: requestEpoch,
    ciphertext: uniqueB64(),
    iv: crypto.randomBytes(12).toString('base64'),
    sender_ephemeral_pubkey: fakePubkey(),
    sent_at: new Date().toISOString()
  });

  /** Owner + members with a joined channel; returns everything needed per suite. */
  const setupChannelWithMembers = async (channelName: string, memberNames: string[]) => {
    const owner = await reg('Owner ' + channelName);
    const channelId = await createChannelV2(owner, channelName);
    const members: DeviceCtx[] = [];
    for (const name of memberNames) {
      const member = await reg(name);
      await joinChannel(owner, channelId, member);
      members.push(member);
    }
    const epoch = await currentEpoch(owner.token, channelId);
    return { owner, members, channelId, epoch };
  };

  beforeEach(async () => {
    await sessionService.clearAll();
    await messageV2Service.clearAll();
    await channelService.clearAll();
    await pairingService.clearAll();
    await deviceService.clearAll();
    jest.restoreAllMocks();
  });

  // ------------------------------------------------- 1. POST /devices/register
  describe('POST /api/v2/devices/register', () => {
    it('should register a device with an X25519 public key (201)', async () => {
      const publicKey = fakePubkey();
      const res = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: publicKey, device_name: 'Pixel 8', platform: 'android' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.device_token).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.device_id).toBeDefined();
      expect(res.body.device_name).toBe('Pixel 8');
      expect(res.body.platform).toBe('android');
      expectIso8601(res.body.created_at);

      const device = await deviceService.findByDeviceId(res.body.device_id);
      expect(device?.public_key).toBe(publicKey);
      // The plaintext token is never stored server-side
      expect(JSON.stringify(device)).not.toContain(res.body.device_token);
    });

    it('should default platform to "unknown" and accept all enum values', async () => {
      const missing = await request(server).post('/api/v2/devices/register').send({ public_key: fakePubkey() });
      expect(missing.status).toBe(201);
      expect(missing.body.platform).toBe('unknown');

      for (const platform of ['android', 'ios', 'web', 'unknown']) {
        const res = await request(server)
          .post('/api/v2/devices/register')
          .send({ public_key: fakePubkey(), platform });
        expect(res.status).toBe(201);
        expect(res.body.platform).toBe(platform);
      }
    });

    it('should be idempotent per device_id: re-register keeps the id, rotates the token', async () => {
      const deviceId = randomUUID();
      const first = await request(server)
        .post('/api/v2/devices/register')
        .send({ device_id: deviceId, public_key: fakePubkey(), device_name: 'Pixel 8' });
      const second = await request(server)
        .post('/api/v2/devices/register')
        .send({ device_id: deviceId, public_key: fakePubkey() });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.device_id).toBe(deviceId);
      expect(second.body.device_token).not.toBe(first.body.device_token);
      // Reinstall policy: fields not re-sent are preserved
      expect(second.body.device_name).toBe('Pixel 8');

      const oldTokenRes = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(first.body.device_token))
        .send({ device_name: 'Impostor' });
      expect(oldTokenRes.status).toBe(401);
    });

    it('should be idempotent per public_key: re-register with the same key reuses the device', async () => {
      const publicKey = fakePubkey();
      const first = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: publicKey, device_name: 'Galaxy S23' });
      const second = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: publicKey, device_name: 'Galaxy S23 renamed' });

      expect(second.status).toBe(201);
      expect(second.body.device_id).toBe(first.body.device_id);
      expect(second.body.device_name).toBe('Galaxy S23 renamed');
    });

    it('should reject invalid payloads with 400 VALIDATION_ERROR', async () => {
      const noKey = await request(server).post('/api/v2/devices/register').send({ device_name: 'Pixel' });
      expect(noKey.status).toBe(400);
      expect(noKey.body.error).toBe('VALIDATION_ERROR');

      const shortKey = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: Buffer.from('too-short').toString('base64') });
      expect(shortKey.status).toBe(400);

      const notBase64 = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: 'not-a-valid-base64-key!!!' });
      expect(notBase64.status).toBe(400);

      const badPlatform = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: fakePubkey(), platform: 'windows' });
      expect(badPlatform.status).toBe(400);

      const longName = await request(server)
        .post('/api/v2/devices/register')
        .send({ public_key: fakePubkey(), device_name: 'x'.repeat(101) });
      expect(longName.status).toBe(400);
    });
  });

  // -------------------------------------------------- 2. PUT /devices/name
  describe('PUT /api/v2/devices/name', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).put('/api/v2/devices/name').send({ device_name: 'New Name' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should rename the caller device (200)', async () => {
      const device = await reg('Old Name');
      const res = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(device.token))
        .send({ device_name: 'Pixel 8 của Minh' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect((await deviceService.findByDeviceId(device.deviceId))?.device_name).toBe('Pixel 8 của Minh');
    });

    it('should be idempotent when called with the same name', async () => {
      const device = await reg('Stable Name');
      const first = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(device.token))
        .send({ device_name: 'Same Name' });
      const second = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(device.token))
        .send({ device_name: 'Same Name' });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it('should fan-out the new name to channel_members ACTIVE and pairing_requests PENDING', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const otherOwner = await reg('Owner D');
      const channelId = await createChannelV2(owner, 'Kênh A');
      const otherChannelId = await createChannelV2(otherOwner, 'Kênh D');

      await joinChannel(owner, channelId, member);
      // Member B also has a PENDING request on the other channel
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(otherOwner.token))
        .send({ channel_id: otherChannelId });
      await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });

      const renameRes = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(member.token))
        .send({ device_name: 'B Đổi Tên' });
      expect(renameRes.status).toBe(200);

      const membersRes = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(owner.token));
      const renamed = membersRes.body.members.find((m: any) => m.device_id === member.deviceId);
      expect(renamed.device_name).toBe('B Đổi Tên');

      const requestsRes = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${otherChannelId}`)
        .set(bearer(otherOwner.token));
      expect(requestsRes.body.requests[0].requester_device_name).toBe('B Đổi Tên');
    });

    it('should reject invalid names with 400', async () => {
      const device = await reg('Name Validation');
      const empty = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(device.token))
        .send({ device_name: '   ' });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toBe('VALIDATION_ERROR');

      const tooLong = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(device.token))
        .send({ device_name: 'x'.repeat(101) });
      expect(tooLong.status).toBe(400);
    });
  });

  // -------------------------------------------------- 3. POST /channels
  describe('POST /api/v2/channels', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/channels').send({ channel_name: 'Kênh' });
      expect(res.status).toBe(401);
    });

    it('should create a channel with the caller as Owner at epoch 1 (201)', async () => {
      const owner = await reg('Owner A');
      const res = await request(server)
        .post('/api/v2/channels')
        .set(bearer(owner.token))
        .send({ channel_name: 'Kênh nhà' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.channel_name).toBe('Kênh nhà');
      expect(res.body.current_epoch).toBe(1);
      expect(res.body.sequence_counter).toBe(0);
      expect(res.body.member_count).toBe(1);

      const channel = await channelService.findChannelById(res.body.channel_id);
      expect(channel?.owner_device_id).toBe(owner.deviceId);
      expect(channel?.sequence_counter).toBe(0);

      const member = await channelService.getMember(res.body.channel_id, owner.deviceId);
      expect(member?.role).toBe('owner');
      expect(member?.status).toBe('ACTIVE');
      expect(member?.joined_epoch).toBe(1);
    });

    it('should allow one device to own several channels', async () => {
      const owner = await reg('Owner A');
      const first = await createChannelV2(owner, 'Kênh 1');
      const second = await createChannelV2(owner, 'Kênh 2');
      expect(first).not.toBe(second);
    });

    it('should reject invalid channel names with 400', async () => {
      const owner = await reg('Owner A');
      const missing = await request(server).post('/api/v2/channels').set(bearer(owner.token)).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('VALIDATION_ERROR');

      const blank = await request(server)
        .post('/api/v2/channels')
        .set(bearer(owner.token))
        .send({ channel_name: '   ' });
      expect(blank.status).toBe(400);

      const tooLong = await request(server)
        .post('/api/v2/channels')
        .set(bearer(owner.token))
        .send({ channel_name: 'x'.repeat(101) });
      expect(tooLong.status).toBe(400);
    });
  });

  // -------------------------------------------------- 4. GET /channels
  describe('GET /api/v2/channels', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).get('/api/v2/channels');
      expect(res.status).toBe(401);
    });

    it('should list channels where the caller is an ACTIVE member with its role', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const outsider = await reg('Outsider C');
      const channelId = await createChannelV2(owner, 'Kênh nhà');
      await joinChannel(owner, channelId, member);

      const ownerList = await request(server).get('/api/v2/channels').set(bearer(owner.token));
      expect(ownerList.status).toBe(200);
      expect(ownerList.body.channels).toHaveLength(1);
      expect(ownerList.body.channels[0].role).toBe('owner');
      expect(ownerList.body.channels[0].channel_id).toBe(channelId);
      expect(ownerList.body.channels[0].member_count).toBe(2);

      const memberList = await request(server).get('/api/v2/channels').set(bearer(member.token));
      expect(memberList.body.channels).toHaveLength(1);
      expect(memberList.body.channels[0].role).toBe('member');
      expect(memberList.body.channels[0].joined_epoch).toBe(2);

      const outsiderList = await request(server).get('/api/v2/channels').set(bearer(outsider.token));
      expect(outsiderList.status).toBe(200);
      expect(outsiderList.body.channels).toEqual([]);
    });

    it('should exclude channels where the caller has been REVOKED', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh revoke', ['Member B']);
      const member = members[0];

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [member.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });

      const res = await request(server).get('/api/v2/channels').set(bearer(member.token));
      expect(res.status).toBe(200);
      expect(res.body.channels).toEqual([]);

      const ownerList = await request(server).get('/api/v2/channels').set(bearer(owner.token));
      expect(ownerList.body.channels[0].member_count).toBe(1);
    });
  });

  // -------------------------------------------------- 5. GET /channels/detail
  describe('GET /api/v2/channels/detail', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).get('/api/v2/channels/detail?channel_id=abc');
      expect(res.status).toBe(401);
    });

    it('should return 400 when channel_id is missing', async () => {
      const owner = await reg('Owner A');
      const res = await request(server).get('/api/v2/channels/detail').set(bearer(owner.token));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return channel metadata, member count and current_epoch for an ACTIVE member', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh nhà', ['Member B']);

      const ownerRes = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(owner.token));
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body.success).toBe(true);
      expect(ownerRes.body.channel.channel_id).toBe(channelId);
      expect(ownerRes.body.channel.channel_name).toBe('Kênh nhà');
      expect(ownerRes.body.channel.current_epoch).toBe(epoch);
      expect(ownerRes.body.channel.member_count).toBe(2);
      expect(ownerRes.body.channel.status).toBe('ACTIVE');
      expect(ownerRes.body.my_role).toBe('owner');
      expect(ownerRes.body.my_joined_epoch).toBe(1);

      const memberRes = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(members[0].token));
      expect(memberRes.status).toBe(200);
      expect(memberRes.body.my_role).toBe('member');
      expect(memberRes.body.my_joined_epoch).toBe(2);
    });

    it('should return 404 for unknown channels and never-members', async () => {
      const { owner, channelId } = await setupChannelWithMembers('Kênh 404', []);
      const outsider = await reg('Outsider');

      const unknown = await request(server)
        .get(`/api/v2/channels/detail?channel_id=does-not-exist`)
        .set(bearer(owner.token));
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('NOT_FOUND');

      const neverMember = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(outsider.token));
      expect(neverMember.status).toBe(404);
    });

    it('should return 403 REVOKED for a revoked member', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh revoke', ['Member B']);
      const member = members[0];

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [member.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });

      const res = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(member.token));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('REVOKED');
    });
  });

  // -------------------------------------------------- 6. GET /channels/members
  describe('GET /api/v2/channels/members', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).get('/api/v2/channels/members?channel_id=abc');
      expect(res.status).toBe(401);
    });

    it('should list ACTIVE members with role, joined_at and joined_epoch', async () => {
      const { owner, members, channelId } = await setupChannelWithMembers('Kênh nhà', ['Member B']);

      const res = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(members[0].token));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.members).toHaveLength(2);

      const ownerRow = res.body.members.find((m: any) => m.device_id === owner.deviceId);
      expect(ownerRow.role).toBe('owner');
      expect(ownerRow.joined_epoch).toBe(1);
      expectIso8601(ownerRow.joined_at);
      expect(ownerRow.public_key).toBe(owner.publicKey);

      const memberRow = res.body.members.find((m: any) => m.device_id === members[0].deviceId);
      expect(memberRow.role).toBe('member');
      expect(memberRow.joined_epoch).toBe(2);
      expect(memberRow.status).toBe('ACTIVE');
    });

    it('should return 404 for a never-member and 403 REVOKED for a revoked member', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh guard', ['Member B']);
      const outsider = await reg('Outsider');

      const never = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(outsider.token));
      expect(never.status).toBe(404);

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [members[0].deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });

      const revoked = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(members[0].token));
      expect(revoked.status).toBe(403);
      expect(revoked.body.error).toBe('REVOKED');
    });

    it('should return 400 when channel_id is missing', async () => {
      const owner = await reg('Owner A');
      const res = await request(server).get('/api/v2/channels/members').set(bearer(owner.token));
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------- 7. POST /channels/sessions
  describe('POST /api/v2/channels/sessions', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/channels/sessions').send({ channel_id: 'abc' });
      expect(res.status).toBe(401);
    });

    it('should create a pairing session with a CSPRNG 128-bit hex token and qr_data (201)', async () => {
      const { owner, channelId } = await setupChannelWithMembers('Kênh QR', []);
      const res = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.session_id).toBeDefined();
      expect(res.body.token).toMatch(/^[a-f0-9]{32}$/); // 128-bit hex
      expect(res.body.qr_data).toBe(
        `smsnavigator://join?ch=${encodeURIComponent(channelId)}&token=${res.body.token}&srv=${encodeURIComponent('http://localhost:3000')}`
      );
      expect(res.body.qr_data).toContain('smsnavigator://join?ch=');
      expectIso8601(res.body.expires_at);

      const expiresMs = new Date(res.body.expires_at).getTime();
      expect(expiresMs).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1000);

      const session = await pairingService.findSessionById(res.body.session_id);
      expect(session?.status).toBe('UNUSED');
      // Only the hash of the token is stored, never the plaintext
      expect(session?.token_hash).not.toBe(res.body.token);
      expect(JSON.stringify(session)).not.toContain(res.body.token);
    });

    it('should generate a fresh token for every session', async () => {
      const { owner, channelId } = await setupChannelWithMembers('Kênh QR fresh', []);
      const first = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const second = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(first.body.token).not.toBe(second.body.token);
      expect(first.body.session_id).not.toBe(second.body.session_id);
    });

    it('should return 403 NOT_OWNER when a non-owner calls it', async () => {
      const { owner, members, channelId } = await setupChannelWithMembers('Kênh not owner', ['Member B']);
      const outsider = await reg('Outsider');

      const byMember = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(members[0].token))
        .send({ channel_id: channelId });
      expect(byMember.status).toBe(403);
      expect(byMember.body.error).toBe('NOT_OWNER');

      const byOutsider = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(outsider.token))
        .send({ channel_id: channelId });
      expect(byOutsider.status).toBe(403);
    });

    it('should return 404 for an unknown channel', async () => {
      const owner = await reg('Owner A');
      const res = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: 'unknown-channel' });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('should return 400 when channel_id is missing', async () => {
      const owner = await reg('Owner A');
      const res = await request(server).post('/api/v2/channels/sessions').set(bearer(owner.token)).send({});
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------- 8. POST /pairing/requests
  describe('POST /api/v2/pairing/requests (claim QR)', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/pairing/requests').send({ token: 'x'.repeat(32) });
      expect(res.status).toBe(401);
    });

    it('should claim a valid QR token and create a PENDING request (201)', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh join');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.request_id).toBeDefined();
      expect(res.body.status).toBe('PENDING');
      expect(res.body.channel_id).toBe(channelId);
      expect(res.body.channel_name).toBe('Kênh join');
      expect(res.body.owner_device_name).toBe('Owner A');

      const stored = await pairingService.findRequestById(res.body.request_id);
      expect(stored?.status).toBe('PENDING');
      expect(stored?.requester_device_id).toBe(member.deviceId);
      expect(stored?.requester_public_key).toBe(member.publicKey);

      const session = await pairingService.findSessionById(sessionRes.body.session_id);
      expect(session?.status).toBe('CLAIMED');
    });

    it('should accept an optional encrypted_device_name', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh join 2');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token, encrypted_device_name: 'Q0lQSEVSX0RFTU8=' });

      expect(res.status).toBe(201);
      const stored = await pairingService.findRequestById(res.body.request_id);
      expect(stored?.requester_device_name).toBe('Q0lQSEVSX0RFTU8=');
    });

    it('should return 404 for an unknown token', async () => {
      const member = await reg('Member B');
      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: 'f'.repeat(32) });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('should return 409 QR_ALREADY_USED when the session was already claimed', async () => {
      const owner = await reg('Owner A');
      const memberB = await reg('Member B');
      const memberC = await reg('Member C');
      const channelId = await createChannelV2(owner, 'Kênh single-use');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const first = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(memberB.token))
        .send({ token: sessionRes.body.token });
      expect(first.status).toBe(201);

      const second = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(memberC.token))
        .send({ token: sessionRes.body.token });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('QR_ALREADY_USED');
    });

    it('should return 410 QR_EXPIRED when the 10-minute TTL is over', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh expired');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      await mockFirestore
        .collection('pairing_sessions')
        .doc(sessionRes.body.session_id)
        .update({ expires_at: new Date(Date.now() - 60_000).toISOString() });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('QR_EXPIRED');
    });

    it('should block the owner from claiming its own QR and already-ACTIVE members', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh self', ['Member B']);

      const ownSession = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const selfClaim = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(owner.token))
        .send({ token: ownSession.body.token });
      expect(selfClaim.status).toBe(409);
      expect(selfClaim.body.error).toBe('ALREADY_MEMBER');

      void epoch;
      const rejoinSession = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const memberClaim = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(members[0].token))
        .send({ token: rejoinSession.body.token });
      expect(memberClaim.status).toBe(409);
      expect(memberClaim.body.error).toBe('ALREADY_MEMBER');
    });
  });

  // -------------------------------------------------- 9. GET /channels/requests
  describe('GET /api/v2/channels/requests', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).get('/api/v2/channels/requests?channel_id=abc');
      expect(res.status).toBe(401);
    });

    it('should return the PENDING queue for the Owner with requester info', async () => {
      const owner = await reg('Owner A');
      const memberB = await reg('Member B');
      const memberC = await reg('Member C');
      const channelId = await createChannelV2(owner, 'Kênh queue');

      for (const member of [memberB, memberC]) {
        const sessionRes = await request(server)
          .post('/api/v2/channels/sessions')
          .set(bearer(owner.token))
          .send({ channel_id: channelId });
        await request(server)
          .post('/api/v2/pairing/requests')
          .set(bearer(member.token))
          .send({ token: sessionRes.body.token });
      }

      const res = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}`)
        .set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.requests).toHaveLength(2);
      for (const row of res.body.requests) {
        expect(row.status).toBe('PENDING');
        expectIso8601(row.created_at);
      }
      const requesterIds = res.body.requests.map((r: any) => r.requester_device_id).sort();
      expect(requesterIds).toEqual([memberB.deviceId, memberC.deviceId].sort());
      expect(res.body.requests[0].requester_device_name).toBeDefined();
    });

    it('should filter by status query param', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh filter');
      await joinChannel(owner, channelId, member); // request becomes APPROVED

      const pending = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}&status=PENDING`)
        .set(bearer(owner.token));
      expect(pending.body.count).toBe(0);

      const approved = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}&status=APPROVED`)
        .set(bearer(owner.token));
      expect(approved.body.count).toBe(1);
      expect(approved.body.requests[0].status).toBe('APPROVED');
    });

    it('should return 403 NOT_OWNER for non-owners', async () => {
      const { owner, members, channelId } = await setupChannelWithMembers('Kênh queue guard', ['Member B']);
      const outsider = await reg('Outsider');

      const byMember = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}`)
        .set(bearer(members[0].token));
      expect(byMember.status).toBe(403);
      expect(byMember.body.error).toBe('NOT_OWNER');

      const byOutsider = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}`)
        .set(bearer(outsider.token));
      expect(byOutsider.status).toBe(403);

      void owner;
    });

    it('should return 404 for an unknown channel', async () => {
      const owner = await reg('Owner A');
      const res = await request(server)
        .get('/api/v2/channels/requests?channel_id=unknown-channel')
        .set(bearer(owner.token));
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------- 10. approve
  describe('POST /api/v2/pairing/requests/approve (T2, rotate)', () => {
    const prepareRequest = async (owner: DeviceCtx, member: DeviceCtx, channelId: string) => {
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });
      expect(claimRes.status).toBe(201);
      return { sessionId: sessionRes.body.session_id as string, requestId: claimRes.body.request_id as string };
    };

    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/pairing/requests/approve').send({});
      expect(res.status).toBe(401);
    });

    it('should approve a PENDING request: epoch rotates, member joins, envelopes stored (200)', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh approve');
      const { requestId } = await prepareRequest(owner, member, channelId);

      const epoch = 2;
      const envelopes = envelopesFor([owner.deviceId, member.deviceId], epoch);
      const res = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: requestId, new_epoch: epoch, envelopes });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.requester_device_id).toBe(member.deviceId);
      expect(res.body.current_epoch).toBe(2);

      const channel = await channelService.findChannelById(channelId);
      expect(channel?.current_epoch).toBe(2);

      const memberDoc = await channelService.getMember(channelId, member.deviceId);
      expect(memberDoc?.status).toBe('ACTIVE');
      expect(memberDoc?.role).toBe('member');
      expect(memberDoc?.joined_epoch).toBe(2);

      const stored = await pairingService.findRequestById(requestId);
      expect(stored?.status).toBe('APPROVED');

      // KL3: envelope for the requester at the new epoch exists
      const envelopeRes = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=2`)
        .set(bearer(member.token));
      expect(envelopeRes.status).toBe(200);
      expect(envelopeRes.body.encrypted_key).toBe(
        envelopes.find((e) => e.device_id === member.deviceId)?.encrypted_key
      );
    });

    it('should send REQUEST_APPROVED / CHANNEL_KEY_ROTATED FCM bells', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(member.token))
        .send({ fcm_token: 'fcm_member_B_approve_12345' });
      const channelId = await createChannelV2(owner, 'Kênh fcm');
      const { requestId } = await prepareRequest(owner, member, channelId);

      const spy = jest.spyOn(fcmService, 'sendDataNotification').mockResolvedValue('mock_fcm_id');

      const res = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId, member.deviceId], 2)
        });
      expect(res.status).toBe(200);

      const approvals = spy.mock.calls.filter(
        (call) => (call[1] as Record<string, string>).kind === 'REQUEST_APPROVED'
      );
      expect(approvals).toHaveLength(1);
      expect(approvals[0][0]).toBe('fcm_member_B_approve_12345');
      expect(approvals[0][1]).toEqual(
        expect.objectContaining({ type: 'CHANNEL_EVENT', channel_id: channelId, epoch: '2' })
      );
    });

    it('should return 403 NOT_OWNER for non-owners', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const outsider = await reg('Outsider');
      const channelId = await createChannelV2(owner, 'Kênh approve guard');
      const { requestId } = await prepareRequest(owner, member, channelId);

      const res = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(outsider.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId, member.deviceId], 2)
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('NOT_OWNER');
    });

    it('should return 409 REQUEST_NOT_PENDING when the request was already decided', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh double approve');
      const { requestId } = await prepareRequest(owner, member, channelId);

      const first = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId, member.deviceId], 2)
        });
      expect(first.status).toBe(200);

      const second = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 3,
          envelopes: envelopesFor([owner.deviceId, member.deviceId], 3)
        });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('REQUEST_NOT_PENDING');
    });

    it('should return 409 MEMBERSHIP_CHANGED when new_epoch != current_epoch + 1', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh epoch');
      const { requestId } = await prepareRequest(owner, member, channelId);

      const res = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 5,
          envelopes: envelopesFor([owner.deviceId, member.deviceId], 5)
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('MEMBERSHIP_CHANGED');
    });

    it('should return 422 PACKAGE_INCOMPLETE when the envelope set is wrong', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh package');
      const { requestId } = await prepareRequest(owner, member, channelId);

      const missingRequester = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId], 2)
        });
      expect(missingRequester.status).toBe(422);
      expect(missingRequester.body.error).toBe('PACKAGE_INCOMPLETE');

      const extraDevice = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: requestId,
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId, member.deviceId, 'device_extra'], 2)
        });
      expect(extraDevice.status).toBe(422);
    });

    it('should return 404 for an unknown request and 400 for invalid payloads', async () => {
      const owner = await reg('Owner A');
      const channelId = await createChannelV2(owner, 'Kênh 404');

      const unknown = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: 'no-such-request',
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId], 2)
        });
      expect(unknown.status).toBe(404);

      const missingEnvelopes = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: 'no-such-request', new_epoch: 2, envelopes: [] });
      expect(missingEnvelopes.status).toBe(400);
      expect(missingEnvelopes.body.error).toBe('VALIDATION_ERROR');
    });
  });

  // -------------------------------------------------- 11. reject
  describe('POST /api/v2/pairing/requests/reject (T6, Owner)', () => {
    const prepareRequest = async (owner: DeviceCtx, member: DeviceCtx, channelId: string) => {
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });
      return claimRes.body.request_id as string;
    };

    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/pairing/requests/reject').send({});
      expect(res.status).toBe(401);
    });

    it('should reject a PENDING request (200)', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh reject');
      const requestId = await prepareRequest(owner, member, channelId);

      const res = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('REJECTED');

      const stored = await pairingService.findRequestById(requestId);
      expect(stored?.status).toBe('REJECTED');

      // The channel stays untouched: no member, no rotation
      const channel = await channelService.findChannelById(channelId);
      expect(channel?.current_epoch).toBe(1);
      expect(await channelService.getMember(channelId, member.deviceId)).toBeNull();
    });

    it('should return 409 REQUEST_NOT_PENDING on a second reject', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh double reject');
      const requestId = await prepareRequest(owner, member, channelId);

      await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: requestId });

      const second = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('REQUEST_NOT_PENDING');
    });

    it('should return 403 NOT_OWNER for non-owners and 404 for unknown requests', async () => {
      const { members, channelId } = await setupChannelWithMembers('Kênh reject guard', ['Member B']);
      const owner = await reg('Owner Z');
      const member = await reg('Member Y');
      const requestId = await prepareRequest(owner, member, await createChannelV2(owner, 'Kênh Z'));

      const byNonOwner = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(members[0].token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(byNonOwner.status).toBe(403);
      expect(byNonOwner.body.error).toBe('NOT_OWNER');

      const unknown = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ channel_id: await createChannelV2(owner, 'Kênh Z2'), request_id: 'no-such-request' });
      expect(unknown.status).toBe(404);
    });
  });

  // -------------------------------------------------- 12. cancel
  describe('POST /api/v2/pairing/requests/cancel (T6, requester only)', () => {
    const prepareRequest = async (owner: DeviceCtx, member: DeviceCtx, channelId: string) => {
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });
      return claimRes.body.request_id as string;
    };

    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/pairing/requests/cancel').send({});
      expect(res.status).toBe(401);
    });

    it('should let the requester cancel its own PENDING request (200)', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh cancel');
      const requestId = await prepareRequest(owner, member, channelId);

      const res = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(member.token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');

      const stored = await pairingService.findRequestById(requestId);
      expect(stored?.status).toBe('CANCELLED');
    });

    it('should return 403 FORBIDDEN when anyone else tries to cancel', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const intruder = await reg('Intruder C');
      const channelId = await createChannelV2(owner, 'Kênh cancel guard');
      const requestId = await prepareRequest(owner, member, channelId);

      const byOwner = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(byOwner.status).toBe(403);
      expect(byOwner.body.error).toBe('FORBIDDEN');

      const byIntruder = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(intruder.token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(byIntruder.status).toBe(403);
    });

    it('should return 409 REQUEST_NOT_PENDING after a decision and 404 for unknown ids', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh cancel terminal');
      const requestId = await prepareRequest(owner, member, channelId);

      await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ channel_id: channelId, request_id: requestId });

      const afterReject = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(member.token))
        .send({ channel_id: channelId, request_id: requestId });
      expect(afterReject.status).toBe(409);

      const unknown = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(member.token))
        .send({ channel_id: channelId, request_id: 'no-such-request' });
      expect(unknown.status).toBe(404);
    });
  });

  // -------------------------------------------------- 13. key-envelope
  describe('GET /api/v2/channels/key-envelope', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).get('/api/v2/channels/key-envelope?channel_id=abc&epoch=1');
      expect(res.status).toBe(401);
    });

    it('should return the caller envelope for the requested epoch (idempotent fetch)', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const channelId = await createChannelV2(owner, 'Kênh envelope');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({ token: sessionRes.body.token });

      const epoch = 2;
      const envelopes = envelopesFor([owner.deviceId, member.deviceId], epoch);
      await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          request_id: (await pairingService.listRequests(channelId, 'PENDING'))[0].request_id,
          new_epoch: epoch,
          envelopes
        });

      const first = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=${epoch}`)
        .set(bearer(member.token));
      expect(first.status).toBe(200);
      expect(first.body.success).toBe(true);
      expect(first.body.channel_id).toBe(channelId);
      expect(first.body.device_id).toBe(member.deviceId);
      expect(first.body.epoch).toBe(epoch);
      expect(first.body.encrypted_key).toBe(envelopes.find((e) => e.device_id === member.deviceId)?.encrypted_key);
      expect(first.body.iv).toBe(envelopes.find((e) => e.device_id === member.deviceId)?.iv);
      expect(first.body.sender_ephemeral_pubkey).toBe(
        envelopes.find((e) => e.device_id === member.deviceId)?.sender_ephemeral_pubkey
      );
      expect(first.body.fetched_at).toBeDefined();

      const second = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=${epoch}`)
        .set(bearer(member.token));
      expect(second.status).toBe(200);
      expect(second.body.fetched_at).toBe(first.body.fetched_at);
    });

    it('should return 404 for an epoch that was never provisioned', async () => {
      const { owner, channelId } = await setupChannelWithMembers('Kênh env 404', []);

      const wrongEpoch = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=9`)
        .set(bearer(owner.token));
      expect(wrongEpoch.status).toBe(404);
      expect(wrongEpoch.body.error).toBe('NOT_FOUND');
    });

    it('should return 400 for missing or invalid query params', async () => {
      const { owner, channelId } = await setupChannelWithMembers('Kênh env 400', []);

      const missingEpoch = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}`)
        .set(bearer(owner.token));
      expect(missingEpoch.status).toBe(400);

      const zeroEpoch = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=0`)
        .set(bearer(owner.token));
      expect(zeroEpoch.status).toBe(400);

      const missingChannel = await request(server)
        .get('/api/v2/channels/key-envelope?epoch=1')
        .set(bearer(owner.token));
      expect(missingChannel.status).toBe(400);
    });

    it('should return 403 REVOKED for a revoked member even for old epochs (KL12)', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh env revoked', ['Member B']);
      const member = members[0];

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [member.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });

      const res = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=${epoch}`)
        .set(bearer(member.token));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('REVOKED');
    });
  });

  // -------------------------------------------------- 14. POST /channels/messages
  describe('POST /api/v2/channels/messages (T5 + T3)', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/channels/messages').send({});
      expect(res.status).toBe(401);
    });

    it('should accept an owner message at the current epoch and allocate sequence 1 (201)', async () => {
      const { owner, channelId, epoch } = await setupChannelWithMembers('Kênh msg', ['Member B']);
      const body = messageBody(channelId, epoch);

      const res = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message_id).toBeDefined();
      expect(res.body.sequence_number).toBe(1);
      expect(res.body.epoch).toBe(epoch);
      expectIso8601(res.body.server_received_at);

      const channel = await channelService.findChannelById(channelId);
      expect(channel?.sequence_counter).toBe(1);
    });

    it('should allocate monotonically increasing sequence numbers', async () => {
      const { owner, channelId, epoch } = await setupChannelWithMembers('Kênh seq', ['Member B']);

      const first = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, epoch));
      const second = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, epoch));

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.sequence_number).toBe(first.body.sequence_number + 1);
    });

    it('should return 403 FORBIDDEN when a member or outsider sends a message', async () => {
      const { members, channelId, epoch } = await setupChannelWithMembers('Kênh msg guard', ['Member B']);
      const outsider = await reg('Outsider');

      const byMember = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(members[0].token))
        .send(messageBody(channelId, epoch));
      expect(byMember.status).toBe(403);
      expect(byMember.body.error).toBe('FORBIDDEN');

      const byOutsider = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(outsider.token))
        .send(messageBody(channelId, epoch));
      expect(byOutsider.status).toBe(403);
    });

    it('should return 409 EPOCH_OUTDATED when request_epoch != current_epoch (KL7)', async () => {
      const { owner, channelId, epoch } = await setupChannelWithMembers('Kênh epoch guard', ['Member B']);

      const future = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, epoch + 1));
      expect(future.status).toBe(409);
      expect(future.body.error).toBe('EPOCH_OUTDATED');

      const past = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, Math.max(1, epoch - 1)));
      expect(past.status).toBe(409);
      expect(past.body.error).toBe('EPOCH_OUTDATED');
    });

    it('should return 409 REPLAY_DETECTED when the same ciphertext is sent twice (T5)', async () => {
      const { owner, channelId, epoch } = await setupChannelWithMembers('Kênh replay', ['Member B']);
      const body = messageBody(channelId, epoch);

      const first = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(body);
      expect(first.status).toBe(201);

      const replay = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send({ ...body, iv: body.iv });
      expect(replay.status).toBe(409);
      expect(replay.body.error).toBe('REPLAY_DETECTED');
    });

    it('should not treat the same ciphertext on a different channel as a replay', async () => {
      const first = await setupChannelWithMembers('Kênh replay A', []);
      const second = await setupChannelWithMembers('Kênh replay B', []);

      const sharedCiphertext = uniqueB64();
      const sharedIv = crypto.randomBytes(12).toString('base64');

      const send = (ownerToken: string, channelId: string, epoch: number) =>
        request(server)
          .post('/api/v2/channels/messages')
          .set(bearer(ownerToken))
          .send({
            channel_id: channelId,
            request_epoch: epoch,
            ciphertext: sharedCiphertext,
            iv: sharedIv,
            sender_ephemeral_pubkey: fakePubkey(),
            sent_at: new Date().toISOString()
          });

      expect((await send(first.owner.token, first.channelId, first.epoch)).status).toBe(201);
      expect((await send(second.owner.token, second.channelId, second.epoch)).status).toBe(201);
    });

    it('should return 404 for an unknown channel and 400 for invalid payloads', async () => {
      const owner = await reg('Owner A');

      const unknown = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody('unknown-channel', 1));
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('NOT_FOUND');

      const badSentAt = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send({ ...messageBody('unknown-channel', 1), sent_at: 'not-a-timestamp' });
      expect(badSentAt.status).toBe(400);
      expect(badSentAt.body.error).toBe('VALIDATION_ERROR');

      const missingCipher = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send({
          channel_id: 'unknown-channel',
          request_epoch: 1,
          iv: 'x',
          sender_ephemeral_pubkey: 'x',
          sent_at: new Date().toISOString()
        });
      expect(missingCipher.status).toBe(400);
    });

    it('should ring NEW_MESSAGE bells to ACTIVE members (not the sender)', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(member.token))
        .send({ fcm_token: 'fcm_member_B_msg_12345' });
      const channelId = await createChannelV2(owner, 'Kênh bell');
      await joinChannel(owner, channelId, member);
      const epoch = await currentEpoch(owner.token, channelId);

      const spy = jest.spyOn(fcmService, 'sendDataNotification').mockResolvedValue('mock_fcm_id');

      const res = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, epoch));
      expect(res.status).toBe(201);

      expect(spy).toHaveBeenCalledWith(
        'fcm_member_B_msg_12345',
        expect.objectContaining({ type: 'CHANNEL_EVENT', kind: 'NEW_MESSAGE', channel_id: channelId })
      );
    });
  });

  // -------------------------------------------------- 15. GET /messages
  describe('GET /api/v2/messages (channel-agnostic day fetch)', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).get('/api/v2/messages?date=2026-10-03');
      expect(res.status).toBe(401);
    });

    it('should return 400 for invalid date or tz_offset', async () => {
      const owner = await reg('Owner A');

      const badDate = await request(server)
        .get('/api/v2/messages?date=03-10-2026')
        .set(bearer(owner.token));
      expect(badDate.status).toBe(400);
      expect(badDate.body.error).toBe('VALIDATION_ERROR');

      const missingDate = await request(server).get('/api/v2/messages').set(bearer(owner.token));
      expect(missingDate.status).toBe(400);

      const badTz = await request(server)
        .get('/api/v2/messages?date=2026-10-03&tz_offset=99999')
        .set(bearer(owner.token));
      expect(badTz.status).toBe(400);
    });

    it('should return an empty list for a caller with no ACTIVE memberships', async () => {
      const outsider = await reg('Outsider');
      const res = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}`)
        .set(bearer(outsider.token));
      expect(res.status).toBe(200);
      expect(res.body.messages).toEqual([]);
      expect(res.body.truncated).toBe(false);
    });

    it('should aggregate today messages from every channel the caller is ACTIVE in', async () => {
      const ownerA = await reg('Owner A');
      const ownerD = await reg('Owner D');
      const memberB = await reg('Member B');
      const outsider = await reg('Outsider C');

      const channelA = await createChannelV2(ownerA, 'Kênh A');
      const channelD = await createChannelV2(ownerD, 'Kênh D');
      await joinChannel(ownerA, channelA, memberB);
      await joinChannel(ownerD, channelD, memberB);

      const epochA = await currentEpoch(ownerA.token, channelA);
      const epochD = await currentEpoch(ownerD.token, channelD);

      const cipherA = uniqueB64();
      const cipherD = uniqueB64();
      await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(ownerA.token))
        .send({ ...messageBody(channelA, epochA), ciphertext: cipherA });
      await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(ownerD.token))
        .send({ ...messageBody(channelD, epochD), ciphertext: cipherD });

      const today = new Date().toISOString().slice(0, 10);
      const res = await request(server)
        .get(`/api/v2/messages?date=${today}&tz_offset=0`)
        .set(bearer(memberB.token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.date).toBe(today);
      expect(res.body.count).toBe(2);
      expect(res.body.truncated).toBe(false);

      const cipherTexts = res.body.messages.map((m: any) => m.ciphertext).sort();
      expect(cipherTexts).toEqual([cipherA, cipherD].sort());
      const channelNames = res.body.messages.map((m: any) => m.channel_name).sort();
      expect(channelNames).toEqual(['Kênh A', 'Kênh D']);
      for (const message of res.body.messages) {
        expect(message.key_epoch).toBeDefined();
        expect(message.sequence_number).toBe(1);
        expect(message.sender_device_id).toBeDefined();
        expectIso8601(message.server_received_at);
      }

      // Sorted ascending by server_received_at
      const received = res.body.messages.map((m: any) => m.server_received_at);
      expect([...received].sort()).toEqual(received);

      // Outsider sees nothing
      const outsiderRes = await request(server)
        .get(`/api/v2/messages?date=${today}`)
        .set(bearer(outsider.token));
      expect(outsiderRes.body.messages).toEqual([]);
    });

    it('should honor tz_offset when computing the day window', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh tz', ['Member B']);
      await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, epoch));

      // "Today" in UTC+7 always contains "now"
      const vnToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
      const res = await request(server)
        .get(`/api/v2/messages?date=${vnToday}&tz_offset=420`)
        .set(bearer(members[0].token));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });

    it('should exclude channels where the caller has been REVOKED (KL12)', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh revoked read', ['Member B']);
      const member = members[0];

      await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(owner.token))
        .send(messageBody(channelId, epoch));

      const before = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}`)
        .set(bearer(member.token));
      expect(before.body.count).toBe(1);

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [member.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });

      const after = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}`)
        .set(bearer(member.token));
      expect(after.status).toBe(200);
      expect(after.body.messages).toEqual([]);
    });

    it('should cap the day at 1000 newest messages with truncated=true', async () => {
      const { owner, channelId } = await setupChannelWithMembers('Kênh cap', []);
      const bulk = mockFirestore.collection('messages');
      for (let i = 0; i < 1005; i++) {
        await bulk.add({
          message_id: `bulk_${i}`,
          channel_id: channelId,
          sequence_number: i + 1,
          epoch: 1,
          ciphertext: `bulk_cipher_${i}`,
          iv: 'aXZfYnVsa19jYXNl',
          sender_ephemeral_pubkey: fakePubkey(),
          sender_device_id: owner.deviceId,
          sent_at: nowIso(),
          created_at: nowIso()
        });
      }

      const res = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}&tz_offset=0`)
        .set(bearer(owner.token));

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1000);
      expect(res.body.truncated).toBe(true);
      // The 1000 newest are kept: the 5 lowest sequences are dropped
      expect(res.body.messages[0].sequence_number).toBe(6);
      expect(res.body.messages[999].sequence_number).toBe(1005);
    });
  });

  // -------------------------------------------------- 16. POST /channels/revoke
  describe('POST /api/v2/channels/revoke (T4, rotate)', () => {
    it('should return 401 without a bearer token', async () => {
      const res = await request(server).post('/api/v2/channels/revoke').send({});
      expect(res.status).toBe(401);
    });

    it('should revoke members, rotate the epoch and store envelopes for the remaining set (200)', async () => {
      const owner = await reg('Owner A');
      const memberB = await reg('Member B');
      const memberC = await reg('Member C');
      const channelId = await createChannelV2(owner, 'Kênh revoke');

      await joinChannel(owner, channelId, memberB); // epoch 2
      const epochAfterB = await currentEpoch(owner.token, channelId);
      await joinChannel(owner, channelId, memberC); // epoch 3
      const epoch = await currentEpoch(owner.token, channelId);
      expect(epoch).toBe(epochAfterB + 1);

      const newEpoch = epoch + 1;
      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [memberC.deviceId],
          new_epoch: newEpoch,
          envelopes: envelopesFor([owner.deviceId, memberB.deviceId], newEpoch)
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.current_epoch).toBe(newEpoch);
      expect(res.body.revoked_device_ids).toEqual([memberC.deviceId]);

      const revokedMember = await channelService.getMember(channelId, memberC.deviceId);
      expect(revokedMember?.status).toBe('REVOKED');
      expect(revokedMember?.revoked_at).toBeDefined();

      const activeB = await channelService.getMember(channelId, memberB.deviceId);
      expect(activeB?.status).toBe('ACTIVE');

      const remainingEnvelope = await channelService.getEnvelope(channelId, memberB.deviceId, newEpoch);
      expect(remainingEnvelope).not.toBeNull();

      const ownerList = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(owner.token));
      expect(ownerList.body.count).toBe(2);
    });

    it('should ring the REVOKED bell to the revoked device', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh revoke bell', ['Member B']);
      const member = members[0];
      await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(member.token))
        .send({ fcm_token: 'fcm_member_B_revoke_12345' });

      const spy = jest.spyOn(fcmService, 'sendDataNotification').mockResolvedValue('mock_fcm_id');

      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [member.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });
      expect(res.status).toBe(200);

      expect(spy).toHaveBeenCalledWith(
        'fcm_member_B_revoke_12345',
        expect.objectContaining({ type: 'CHANNEL_EVENT', kind: 'REVOKED', channel_id: channelId })
      );
    });

    it('should return 403 NOT_OWNER for non-owners', async () => {
      const { members, channelId, epoch } = await setupChannelWithMembers('Kênh revoke guard', ['Member B']);
      const outsider = await reg('Outsider');

      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(outsider.token))
        .send({
          channel_id: channelId,
          target_device_ids: [members[0].deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([members[0].deviceId], epoch + 1)
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('NOT_OWNER');
    });

    it('should return 409 MEMBERSHIP_CHANGED when new_epoch != current_epoch + 1', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh revoke epoch', ['Member B']);

      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [members[0].deviceId],
          new_epoch: epoch + 7,
          envelopes: envelopesFor([owner.deviceId], epoch + 7)
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('MEMBERSHIP_CHANGED');
    });

    it('should return 422 PACKAGE_INCOMPLETE when envelopes do not match the remaining set (KL8)', async () => {
      const { owner, members, channelId, epoch } = await setupChannelWithMembers('Kênh revoke pkg', ['Member B']);

      const missingOwner = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [members[0].deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([members[0].deviceId], epoch + 1)
        });
      expect(missingOwner.status).toBe(422);
      expect(missingOwner.body.error).toBe('PACKAGE_INCOMPLETE');

      const includesRevoked = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [members[0].deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId, members[0].deviceId], epoch + 1)
        });
      expect(includesRevoked.status).toBe(422);
    });

    it('should return 404 when a target is not an ACTIVE member and 400 when revoking the owner', async () => {
      const { owner, channelId, epoch } = await setupChannelWithMembers('Kênh revoke target', []);
      const stranger = await reg('Stranger');

      const notMember = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [stranger.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });
      expect(notMember.status).toBe(404);

      const self = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          target_device_ids: [owner.deviceId],
          new_epoch: epoch + 1,
          envelopes: envelopesFor([owner.deviceId], epoch + 1)
        });
      expect(self.status).toBe(400);
      expect(self.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for an unknown channel', async () => {
      const owner = await reg('Owner A');
      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: 'unknown-channel',
          target_device_ids: ['someone'],
          new_epoch: 2,
          envelopes: envelopesFor([owner.deviceId], 2)
        });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------- E2E
  describe('E2E — full 1-to-N E2EE flow', () => {
    it('should run register → channel → QR → claim → approve → envelope → message → fetch → revoke', async () => {
      // 1. Register Owner (A) and members (B, C)
      const a = await reg('Owner Pixel 8');
      const b = await reg('Galaxy S23');
      const c = await reg('iPhone 15');

      // 2. Owner creates the channel
      const channelId = await createChannelV2(a, 'Kênh gia đình');

      // 3. Owner creates the QR pairing session
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(a.token))
        .send({ channel_id: channelId });
      expect(sessionRes.status).toBe(201);
      expect(sessionRes.body.qr_data).toContain('smsnavigator://join?ch=');
      expect(sessionRes.body.qr_data).toContain(`token=${sessionRes.body.token}`);

      // 4. Member B claims the QR → PENDING request
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(b.token))
        .send({ token: sessionRes.body.token });
      expect(claimRes.status).toBe(201);
      expect(claimRes.body.status).toBe('PENDING');
      expect(claimRes.body.channel_name).toBe('Kênh gia đình');

      // 5. Owner approves → epoch 2, envelopes for A and B
      const epoch2 = 2;
      const envelopes2 = envelopesFor([a.deviceId, b.deviceId], epoch2);
      const approveRes = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(a.token))
        .send({
          channel_id: channelId,
          request_id: claimRes.body.request_id,
          new_epoch: epoch2,
          envelopes: envelopes2
        });
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.current_epoch).toBe(2);
      expect((await channelService.findChannelById(channelId))?.current_epoch).toBe(2);

      // 6. Member B fetches its key-envelope for epoch 2
      const envelopeRes = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=${epoch2}`)
        .set(bearer(b.token));
      expect(envelopeRes.status).toBe(200);
      expect(envelopeRes.body.encrypted_key).toBe(
        envelopes2.find((e) => e.device_id === b.deviceId)?.encrypted_key
      );

      // C joins as well (epoch 3) so the revoke step has a real member to revoke
      const epoch3 = await joinChannel(a, channelId, c);
      expect(epoch3).toBe(3);

      // 7. Owner sends an encrypted message at epoch 3 → sequence_number 1
      const cipher = uniqueB64();
      const sendRes = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(a.token))
        .send({
          channel_id: channelId,
          request_epoch: epoch3,
          ciphertext: cipher,
          iv: crypto.randomBytes(12).toString('base64'),
          sender_ephemeral_pubkey: fakePubkey(),
          sent_at: new Date().toISOString()
        });
      expect(sendRes.status).toBe(201);
      expect(sendRes.body.sequence_number).toBe(1);
      expect(sendRes.body.epoch).toBe(epoch3);

      // Sending with a stale epoch is rejected
      const staleRes = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(a.token))
        .send({
          channel_id: channelId,
          request_epoch: 2,
          ciphertext: uniqueB64(),
          iv: crypto.randomBytes(12).toString('base64'),
          sender_ephemeral_pubkey: fakePubkey(),
          sent_at: new Date().toISOString()
        });
      expect(staleRes.status).toBe(409);
      expect(staleRes.body.error).toBe('EPOCH_OUTDATED');

      // 8. Member B fetches messages by day → sees the message
      const fetchRes = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}&tz_offset=0`)
        .set(bearer(b.token));
      expect(fetchRes.status).toBe(200);
      expect(fetchRes.body.count).toBe(1);
      expect(fetchRes.body.messages[0].ciphertext).toBe(cipher);
      expect(fetchRes.body.messages[0].channel_id).toBe(channelId);
      expect(fetchRes.body.messages[0].channel_name).toBe('Kênh gia đình');
      expect(fetchRes.body.messages[0].key_epoch).toBe(epoch3);

      // 9. Owner revokes C → epoch 4, C becomes REVOKED
      const epoch4 = 4;
      const revokeRes = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(a.token))
        .send({
          channel_id: channelId,
          target_device_ids: [c.deviceId],
          new_epoch: epoch4,
          envelopes: envelopesFor([a.deviceId, b.deviceId], epoch4)
        });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked_device_ids).toEqual([c.deviceId]);
      expect((await channelService.findChannelById(channelId))?.current_epoch).toBe(4);

      // 10. The revoked member can no longer read messages or call channel APIs
      const revokedMessages = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}&tz_offset=0`)
        .set(bearer(c.token));
      expect(revokedMessages.status).toBe(200);
      expect(revokedMessages.body.messages).toEqual([]);

      const revokedDetail = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(c.token));
      expect(revokedDetail.status).toBe(403);
      expect(revokedDetail.body.error).toBe('REVOKED');

      const revokedEnvelope = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=3`)
        .set(bearer(c.token));
      expect(revokedEnvelope.status).toBe(403);

      const revokedList = await request(server).get('/api/v2/channels').set(bearer(c.token));
      expect(revokedList.body.channels).toEqual([]);

      // B is unaffected and still reads the channel; A keeps a 2-member channel
      const memberMessages = await request(server)
        .get(`/api/v2/messages?date=${new Date().toISOString().slice(0, 10)}&tz_offset=0`)
        .set(bearer(b.token));
      expect(memberMessages.body.count).toBe(1);

      const membersRes = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(a.token));
      expect(membersRes.body.count).toBe(2);
    });
  });

  // -------------------------------------------------- auth matrix + v1 isolation
  describe('v2 auth & routing conventions', () => {
    const isoNow = new Date().toISOString();

    const protectedEndpoints: Array<[string, 'get' | 'post' | 'put', Record<string, unknown> | undefined]> = [
      ['/api/v2/channels', 'post', { channel_name: 'Kênh' }],
      ['/api/v2/channels/detail?channel_id=x', 'get', undefined],
      ['/api/v2/channels/members?channel_id=x', 'get', undefined],
      ['/api/v2/channels/requests?channel_id=x', 'get', undefined],
      ['/api/v2/channels/key-envelope?channel_id=x&epoch=1', 'get', undefined],
      ['/api/v2/channels/sessions', 'post', { channel_id: 'x' }],
      [
        '/api/v2/channels/messages',
        'post',
        { channel_id: 'x', request_epoch: 1, ciphertext: 'x', iv: 'x', sender_ephemeral_pubkey: 'x', sent_at: isoNow }
      ],
      ['/api/v2/channels/revoke', 'post', { channel_id: 'x', target_device_ids: ['x'], new_epoch: 2, envelopes: [] }],
      ['/api/v2/pairing/requests', 'post', { token: 'x'.repeat(32) }],
      ['/api/v2/pairing/requests/approve', 'post', { channel_id: 'x', request_id: 'x', new_epoch: 2, envelopes: [] }],
      ['/api/v2/pairing/requests/reject', 'post', { channel_id: 'x', request_id: 'x' }],
      ['/api/v2/pairing/requests/cancel', 'post', { channel_id: 'x', request_id: 'x' }],
      ['/api/v2/devices/name', 'put', { device_name: 'x' }],
      ['/api/v2/messages?date=2026-10-03', 'get', undefined]
    ];

    it('should require a bearer token on every channel-scoped / pairing / messages endpoint', async () => {
      for (const [url, method, body] of protectedEndpoints) {
        const res = await request(server)[method](url).send(body ?? {});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('UNAUTHORIZED');
      }
    });

    it('should expose only static paths (no path parameters) under /api/v2', async () => {
      const res = await request(server).get('/api/v2/channels/some-id');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('should keep /api/v1 routes untouched alongside /api/v2', async () => {
      const health = await request(server).get('/api/v1/health');
      expect(health.status).toBe(200);

      const v1Register = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'v1_smoke_device', device_name: 'Legacy' });
      expect(v1Register.status).toBe(201);
      expect(v1Register.body.token).toBeDefined();
    });
  });
});
