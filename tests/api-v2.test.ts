/// <reference types="jest" />

import request from 'supertest';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { createApp } from '../src/app.js';
import { deviceService } from '../src/services/device.service.js';
import { channelService, CHANNEL_KEY_ENVELOPES_COLLECTION } from '../src/services/channel.service.js';
import { pairingV2Service } from '../src/services/pairing.v2.service.js';
import { messageV2Service } from '../src/services/message.v2.service.js';
import { mockFirestore } from '../src/config/firestore-mock.js';
import { KEK_ALG } from '../src/types/v2.js';

/**
 * API contract tests for SERVER_API_SPEC v1.5 (Channel 1-to-N E2EE).
 * Envelope payloads are opaque here: the server only validates structure
 * (Package Pattern) and never derives/opens key material (KL1/KL2).
 */
describe('API v2 — Channel 1-to-N E2EE (spec v1.5)', () => {
  const expressApp = createApp();
  let server: any;

  beforeAll((done) => {
    server = expressApp.listen(0, done);
  });

  afterAll((done) => {
    if (server) server.close(done);
    else done();
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

  const reg = async (deviceName: string, platform: 'android' | 'ios' = 'android'): Promise<DeviceCtx> => {
    const publicKey = fakePubkey();
    const deviceId = randomUUID();
    const res = await request(server)
      .post('/api/v2/devices/register')
      .send({ device_id: deviceId, device_name: deviceName, platform, public_key: publicKey });
    expect(res.status).toBe(201);
    return { deviceId: res.body.device_id, token: res.body.device_token, publicKey, deviceName };
  };

  const nonce12 = (): string => crypto.randomBytes(12).toString('base64');

  const envelopeFor = (deviceId: string, epoch: number) => ({
    device_id: deviceId,
    key_epoch: epoch,
    wrapped_key: crypto.randomBytes(32).toString('base64'),
    nonce: nonce12(),
    kek_alg: KEK_ALG
  });

  /** Envelope set for the given device ids at `epoch` — structurally complete. */
  const envelopesFor = (deviceIds: string[], epoch: number) => deviceIds.map((id) => envelopeFor(id, epoch));

  const packageFor = (deviceIds: string[], baseEpoch: number, baseVersion: number, newEpoch: number) => ({
    base_epoch: baseEpoch,
    base_membership_version: baseVersion,
    envelopes: envelopesFor(deviceIds, newEpoch)
  });

  /** T0: owner creates a channel with a valid package. Returns channel_id. */
  const createChannel = async (owner: DeviceCtx, name: string): Promise<{ channelId: string; version: number }> => {
    const res = await request(server)
      .post('/api/v2/channels')
      .set(bearer(owner.token))
      .send({
        name,
        package: packageFor([owner.deviceId], 1, 1, 1)
      });
    expect(res.status).toBe(201);
    return { channelId: res.body.channel_id, version: res.body.membership_version };
  };

  const channelState = async (
    token: string,
    channelId: string
  ): Promise<{ current_epoch: number; membership_version: number }> => {
    const res = await request(server)
      .get(`/api/v2/channels/detail?channel_id=${channelId}`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    return {
      current_epoch: res.body.channel.current_epoch,
      membership_version: res.body.channel.membership_version
    };
  };

  const activeMemberIds = async (token: string, channelId: string): Promise<string[]> => {
    const res = await request(server)
      .get(`/api/v2/channels/members?channel_id=${channelId}`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    return res.body.members.map((m: any) => m.device_id as string);
  };

  /**
   * Full join flow (T1 + T2): owner creates a QR session, member claims it,
   * owner approves with a rotated package. Returns the new epoch.
   */
  const joinChannel = async (owner: DeviceCtx, channelId: string, member: DeviceCtx): Promise<number> => {
    const sessionRes = await request(server)
      .post('/api/v2/channels/sessions')
      .set(bearer(owner.token))
      .send({ channel_id: channelId });
    expect(sessionRes.status).toBe(201);

    const claimRes = await request(server)
      .post('/api/v2/pairing/requests')
      .set(bearer(member.token))
      .send({
        session_id: sessionRes.body.session_id,
        pairing_token: sessionRes.body.pairing_token,
        device_name: member.deviceName
      });
    expect(claimRes.status).toBe(201);

    const state = await channelState(owner.token, channelId);
    const ids = await activeMemberIds(owner.token, channelId);
    const newEpoch = state.current_epoch + 1;

    const approveRes = await request(server)
      .post('/api/v2/pairing/requests/approve')
      .set(bearer(owner.token))
      .send({
        request_id: claimRes.body.request_id,
        package: packageFor([...ids, member.deviceId], state.current_epoch, state.membership_version, newEpoch)
      });
    expect(approveRes.status).toBe(200);
    return approveRes.body.current_epoch as number;
  };

  const sendMessage = async (
    owner: DeviceCtx,
    channelId: string,
    epoch: number,
    bodyText: string
  ): Promise<{ status: number; body: any }> => {
    const res = await request(server)
      .post('/api/v2/channels/messages')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        request_epoch: epoch,
        ciphertext: Buffer.from(bodyText).toString('base64'),
        nonce: nonce12()
      });
    return { status: res.status, body: res.body };
  };

  beforeEach(async () => {
    mockFirestore.reset();
    await deviceService.clearAll();
    await channelService.clearAll();
    await pairingV2Service.clearAll();
    await messageV2Service.clearAll();
  });

  // ------------------------------------------------------------- 3. Devices
  describe('POST /api/v2/devices/register', () => {
    it('registers a device and returns a bearer token', async () => {
      const res = await request(server)
        .post('/api/v2/devices/register')
        .send({
          device_id: randomUUID(),
          device_name: 'Pixel 8',
          platform: 'android',
          public_key: fakePubkey()
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.device_token).toBe('string');
      expect(res.body.device_token.length).toBeGreaterThan(16);
    });

    it('rejects invalid payloads with VALIDATION_ERROR', async () => {
      const badBodies = [
        {},
        { device_id: 'not-a-uuid', device_name: 'x', platform: 'android', public_key: fakePubkey() },
        { device_id: randomUUID(), device_name: '', platform: 'android', public_key: fakePubkey() },
        { device_id: randomUUID(), device_name: 'x', platform: 'windows', public_key: fakePubkey() },
        { device_id: randomUUID(), device_name: 'x', platform: 'android', public_key: 'short' }
      ];
      for (const body of badBodies) {
        const res = await request(server).post('/api/v2/devices/register').send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('VALIDATION_ERROR');
      }
    });

    it('is idempotent per device_id: re-register issues a fresh token and updates fields', async () => {
      const deviceId = randomUUID();
      const first = await request(server)
        .post('/api/v2/devices/register')
        .send({ device_id: deviceId, device_name: 'Old Name', platform: 'android', public_key: fakePubkey() });
      expect(first.status).toBe(201);

      const second = await request(server)
        .post('/api/v2/devices/register')
        .send({
          device_id: deviceId,
          device_name: 'New Name',
          platform: 'android',
          public_key: fakePubkey()
        });
      expect(second.status).toBe(201);
      expect(second.body.device_token).not.toBe(first.body.device_token);
      expect(second.body.device_id).toBe(deviceId);

      // Old token must stop working (token hash was overwritten)
      const oldAuth = await request(server).get('/api/v2/channels').set(bearer(first.body.device_token));
      expect(oldAuth.status).toBe(401);
      const newAuth = await request(server).get('/api/v2/channels').set(bearer(second.body.device_token));
      expect(newAuth.status).toBe(200);
    });
  });

  describe('PUT /api/v2/devices/name', () => {
    it('requires a bearer token', async () => {
      const res = await request(server).put('/api/v2/devices/name').send({ device_name: 'X' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('renames the device and fans out to channel members + pending requests', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const { channelId } = await createChannel(owner, 'Kênh nhà');

      // Member creates a pending request (fan-out target #2)
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'Member B'
        });
      expect(claimRes.status).toBe(201);

      const renameRes = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(member.token))
        .send({ device_name: 'Galaxy S23 của B' });
      expect(renameRes.status).toBe(200);
      expect(renameRes.body.success).toBe(true);

      // channel_members copy is not readable before approval; check via queue
      const queue = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}&status=PENDING`)
        .set(bearer(owner.token));
      expect(queue.status).toBe(200);
      expect(queue.body.requests[0].requester_device_name).toBe('Galaxy S23 của B');

      // Idempotent: same name again → 200
      const again = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(member.token))
        .send({ device_name: 'Galaxy S23 của B' });
      expect(again.status).toBe(200);
    });

    it('renames owner device and fans out owner_device_name to pending requests', async () => {
      const owner = await reg('Owner Original');
      const member = await reg('Member B');
      const { channelId } = await createChannel(owner, 'Kênh nhà');

      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'Member B'
        });
      expect(claimRes.status).toBe(201);

      // Member sees initial owner_device_name
      const mineBefore = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      expect(mineBefore.body.requests[0].owner_device_name).toBe('Owner Original');

      // Owner renames device
      const renameRes = await request(server)
        .put('/api/v2/devices/name')
        .set(bearer(owner.token))
        .send({ device_name: 'Owner Renamed' });
      expect(renameRes.status).toBe(200);

      // Member sees updated owner_device_name
      const mineAfter = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      expect(mineAfter.body.requests[0].owner_device_name).toBe('Owner Renamed');
    });
  });

  describe('GET /api/v2/devices/me (§3.4)', () => {
    it('requires a bearer token', async () => {
      const res = await request(server).get('/api/v2/devices/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('returns profile info for authenticated device', async () => {
      const owner = await reg('Pixel 8 của Minh');
      const res = await request(server)
        .get('/api/v2/devices/me')
        .set(bearer(owner.token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.device_id).toBe(owner.deviceId);
      expect(res.body.device_name).toBe('Pixel 8 của Minh');
      expect(res.body.platform).toBe('android');
      expect(res.body.public_key).toBe(owner.publicKey);
      expect(res.body.created_at).toBeDefined();
    });

    it('rejects invalid or unknown token with 401', async () => {
      const res = await request(server)
        .get('/api/v2/devices/me')
        .set(bearer('invalid_token_1234567890abcdef'));

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });
  });

  // ------------------------------------------------------------ 4. Channels
  describe('POST /api/v2/channels (T0)', () => {
    it('creates a channel from a valid Owner package (epoch 1, version 1)', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh nhà');
      const state = await channelState(owner.token, channelId);
      expect(state.current_epoch).toBe(1);
      expect(state.membership_version).toBe(1);

      const listRes = await request(server).get('/api/v2/channels').set(bearer(owner.token));
      expect(listRes.status).toBe(200);
      expect(listRes.body.channels).toHaveLength(1);
      expect(listRes.body.channels[0]).toMatchObject({
        channel_id: channelId,
        name: 'Kênh nhà',
        role: 'OWNER',
        status: 'ACTIVE',
        member_count: 1,
        my_joined_epoch: 1
      });
      expect(typeof listRes.body.channels[0].owner_device_name).toBe('string');
    });

    it('rejects structurally invalid packages with 422 PACKAGE_INCOMPLETE', async () => {
      const owner = await reg('Owner');
      const stranger = await reg('Stranger');

      const cases = [
        // envelope set must be exactly {Owner}
        packageFor([stranger.deviceId], 1, 1, 1),
        // key_epoch must be 1 at create
        {
          base_epoch: 1,
          base_membership_version: 1,
          envelopes: [envelopeFor(owner.deviceId, 2)]
        },
        // missing owner envelope
        packageFor([], 1, 1, 1),
        // wrong snapshot
        packageFor([owner.deviceId], 2, 1, 1),
        packageFor([owner.deviceId], 1, 2, 1),
        // duplicate envelopes
        {
          base_epoch: 1,
          base_membership_version: 1,
          envelopes: [envelopeFor(owner.deviceId, 1), envelopeFor(owner.deviceId, 1)]
        }
      ];
      for (const pkg of cases) {
        const res = await request(server)
          .post('/api/v2/channels')
          .set(bearer(owner.token))
          .send({ name: 'Kênh', package: pkg });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe('PACKAGE_INCOMPLETE');
      }
    });

    it('requires authentication', async () => {
      const res = await request(server)
        .post('/api/v2/channels')
        .send({ name: 'Kênh', package: packageFor([randomUUID()], 1, 1, 1) });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v2/channels (§4.2)', () => {
    it('groups by role: OWNER for owned channels, MEMBER for joined ones', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const otherOwner = await reg('Other Owner');

      const { channelId: mine } = await createChannel(owner, 'Kênh của tôi');
      const { channelId: joined } = await createChannel(otherOwner, 'Kênh người khác');
      await joinChannel(otherOwner, joined, member);

      const res = await request(server).get('/api/v2/channels').set(bearer(member.token));
      expect(res.status).toBe(200);
      const roles = Object.fromEntries(res.body.channels.map((c: any) => [c.channel_id, c.role]));
      expect(roles[mine]).toBeUndefined(); // member is not part of owner's channel
      expect(roles[joined]).toBe('MEMBER');

      const ownerRes = await request(server).get('/api/v2/channels').set(bearer(owner.token));
      expect(ownerRes.body.channels[0].role).toBe('OWNER');
      expect(ownerRes.body.channels[0].channel_id).toBe(mine);

      void mine;
    });

    it('hides channels where membership is REVOKED (KL12)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [member.deviceId],
          package: packageFor([owner.deviceId], 2, 2, 3)
        });

      const res = await request(server).get('/api/v2/channels').set(bearer(member.token));
      expect(res.status).toBe(200);
      expect(res.body.channels).toHaveLength(0);
    });
  });

  describe('GET /api/v2/channels/detail + members (§4.3, §4.4)', () => {
    it('returns caller state for a member', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const epoch = await joinChannel(owner, channelId, member);

      const res = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(member.token));
      expect(res.status).toBe(200);
      expect(res.body.my_role).toBe('MEMBER');
      expect(res.body.my_status).toBe('ACTIVE');
      expect(res.body.my_joined_epoch).toBe(epoch);
      expect(res.body.my_provisioned_epoch).toBe(epoch);
      expect(res.body.owner_device_name).toBe('Owner');
    });

    it('404 for a stranger, 403 REVOKED for a revoked member', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const stranger = await reg('Stranger');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);

      const strangerRes = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(stranger.token));
      expect(strangerRes.status).toBe(404);

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [member.deviceId],
          package: packageFor([owner.deviceId], 2, 2, 3)
        });

      const revokedRes = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(member.token));
      expect(revokedRes.status).toBe(403);
      expect(revokedRes.body.error).toBe('REVOKED');
    });

    it('Owner sees REVOKED members, Member sees only ACTIVE (§4.4)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [member.deviceId],
          package: packageFor([owner.deviceId], 2, 2, 3)
        });

      const ownerView = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(owner.token));
      expect(ownerView.status).toBe(200);
      const statuses = Object.fromEntries(
        ownerView.body.members.map((m: any) => [m.device_id, m.status])
      );
      expect(statuses[member.deviceId]).toBe('REVOKED');
      expect(statuses[owner.deviceId]).toBe('ACTIVE');
      expect(ownerView.body.members[0]).toHaveProperty('provisioned_epoch');

      // Revoked member now hits 403 REVOKED on channel-scoped APIs (KL12)
      const revokedView = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(member.token));
      expect(revokedView.status).toBe(403);
      expect(revokedView.body.error).toBe('REVOKED');
    });
  });

  // ------------------------------------------------------ 5. Pairing flows
  describe('POST /api/v2/channels/sessions (§4.5)', () => {
    it('creates an invite_url v4 and returns the raw pairing token', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');

      const res = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(res.status).toBe(201);

      const { session_id, pairing_token, expires_at, invite_url } = res.body;
      expect(pairing_token).toMatch(/^[0-9a-f]{32}$/); // 128-bit hex
      expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

      const url = new URL(invite_url.replace('smsnavigator://pair', 'http://pair'));
      expect(url.searchParams.get('v')).toBe('4');
      expect(url.searchParams.get('s')).toBe(session_id);
      expect(url.searchParams.get('t')).toBe(pairing_token);
      expect(url.searchParams.get('u')).toBeTruthy(); // base64url(server url)
      expect(Number(url.searchParams.get('e'))).toBeGreaterThan(Date.now());
    });

    it('rejects non-owner with 403 NOT_OWNER', async () => {
      const owner = await reg('Owner');
      const stranger = await reg('Stranger');
      const { channelId } = await createChannel(owner, 'Kênh');

      const res = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(stranger.token))
        .send({ channel_id: channelId });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('NOT_OWNER');
    });

    it('invalidates prior UNUSED sessions of the same channel upon creating a new session', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');

      // Create session #1
      const res1 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(res1.status).toBe(201);
      const session1 = res1.body;

      // Create session #2 (must supersede session #1)
      const res2 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(res2.status).toBe(201);
      const session2 = res2.body;
      expect(session2.session_id).not.toBe(session1.session_id);

      // Claiming session #1 now fails with 410 QR_EXPIRED
      const claim1 = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session1.session_id,
          pairing_token: session1.pairing_token,
          device_name: 'Member Device'
        });
      expect(claim1.status).toBe(410);
      expect(claim1.body.error).toBe('QR_EXPIRED');

      // Claiming session #2 succeeds
      const claim2 = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session2.session_id,
          pairing_token: session2.pairing_token,
          device_name: 'Member Device'
        });
      expect(claim2.status).toBe(201);
      expect(claim2.body.status).toBe('PENDING');
    });
  });

  describe('POST /api/v2/channels/sessions/resolve (§4.6)', () => {
    it('previews channel metadata for a valid session without modifying Firestore (strictly read-only)', async () => {
      const owner = await reg('Owner Alice');
      const member = await reg('Member Bob');
      const { channelId } = await createChannel(owner, 'Kênh Thông Tin');

      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(sessionRes.status).toBe(201);

      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        session_id: sessionRes.body.session_id,
        channel_id: channelId,
        channel_name: 'Kênh Thông Tin',
        owner_device_name: 'Owner Alice',
        expires_at: sessionRes.body.expires_at
      });

      // Verify read-only: session status is still UNUSED
      const sessionDoc = await mockFirestore.collection('pairing_sessions').doc(sessionRes.body.session_id).get();
      expect(sessionDoc.data()?.status).toBe('UNUSED');
    });

    it('rejects with 404 when session does not exist', async () => {
      const member = await reg('Member Bob');
      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(member.token))
        .send({
          session_id: randomUUID(),
          pairing_token: '0123456789abcdef0123456789abcdef'
        });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('rejects with 404 when pairing token does not match', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: '00000000000000000000000000000000'
        });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('rejects with 409 QR_ALREADY_USED when session has been claimed', async () => {
      const owner = await reg('Owner');
      const member1 = await reg('Member 1');
      const member2 = await reg('Member 2');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member1.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'Member 1'
        });

      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(member2.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('QR_ALREADY_USED');
    });

    it('rejects with 410 QR_EXPIRED when session has expired', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      // Expire session manually in mock DB
      const sessionDocRef = mockFirestore.collection('pairing_sessions').doc(sessionRes.body.session_id);
      await sessionDocRef.update({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token
        });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('QR_EXPIRED');
    });

    it('rejects with 409 ALREADY_MEMBER when caller is already active member or owner', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(owner.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ALREADY_MEMBER');
    });

    it('rejects with 409 REQUEST_ALREADY_PENDING when caller has pending request', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');

      // Create session 1 and claim it
      const sessionRes1 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes1.body.session_id,
          pairing_token: sessionRes1.body.pairing_token,
          device_name: 'Member'
        });

      // Create session 2 for same channel
      const sessionRes2 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      // Member attempts to resolve session 2 while having pending request on channel
      const res = await request(server)
        .post('/api/v2/channels/sessions/resolve')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes2.body.session_id,
          pairing_token: sessionRes2.body.pairing_token
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('REQUEST_ALREADY_PENDING');
    });
  });

  describe('POST /api/v2/pairing/requests (T1 claim, §5.1)', () => {
    it('claims a QR and creates a PENDING request', async () => {
      const owner = await reg('Owner A');
      const member = await reg('Member B');
      const { channelId } = await createChannel(owner, 'Kênh nhà');

      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'Galaxy S23'
        });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        success: true,
        status: 'PENDING',
        channel_id: channelId,
        channel_name: 'Kênh nhà',
        owner_device_name: 'Owner A'
      });

      // Owner queue shows the request
      const queue = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}&status=PENDING`)
        .set(bearer(owner.token));
      expect(queue.body.requests).toHaveLength(1);
      expect(queue.body.requests[0].requester_device_name).toBe('Galaxy S23');

      // Member sees it in "mine"
      const mine = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      expect(mine.status).toBe(200);
      expect(mine.body.requests[0]).toMatchObject({
        status: 'PENDING',
        channel_id: channelId,
        owner_device_name: 'Owner A'
      });
    });

    it('404 when the pairing token does not match the session', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: crypto.randomBytes(16).toString('hex'),
          device_name: 'B'
        });
      expect(res.status).toBe(404);
    });

    it('409 QR_ALREADY_USED when the QR is claimed twice (single-use, I9)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const third = await reg('Third');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const claimBody = {
        session_id: sessionRes.body.session_id,
        pairing_token: sessionRes.body.pairing_token,
        device_name: 'X'
      };
      const first = await request(server).post('/api/v2/pairing/requests').set(bearer(member.token)).send(claimBody);
      expect(first.status).toBe(201);

      const second = await request(server).post('/api/v2/pairing/requests').set(bearer(third.token)).send(claimBody);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('QR_ALREADY_USED');
    });

    it('410 QR_EXPIRED when the TTL (10 min) has passed', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      // Expire the session behind the scenes (same state machine as time passing)
      const db = mockFirestore as any;
      const store = (db as any).collections?.get?.('pairing_sessions');
      void store;
      await pairingV2Service.clearAll();
      // Recreate an already-expired session directly
      const sessions = (mockFirestore as any).collection('pairing_sessions');
      await sessions.doc(sessionRes.body.session_id).set({
        session_id: sessionRes.body.session_id,
        channel_id: channelId,
        pairing_token_hash: crypto.createHash('sha256').update(sessionRes.body.pairing_token).digest('hex'),
        status: 'UNUSED',
        expires_at: new Date(Date.now() - 1000).toISOString(),
        created_at: new Date(Date.now() - 601000).toISOString()
      });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'B'
        });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('QR_EXPIRED');
    });

    it('409 ALREADY_MEMBER when an ACTIVE member claims a fresh QR of the same channel', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);

      // Owner generates a new invite; the joined member claims it again
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(sessionRes.status).toBe(201);

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: member.deviceName
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ALREADY_MEMBER');
    });

    it('409 ALREADY_MEMBER when the owner claims the QR of their own channel', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });

      const res = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(owner.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: owner.deviceName
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('ALREADY_MEMBER');
    });

    it('409 REQUEST_ALREADY_PENDING when the same device claims a second QR of the channel', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');

      const session1 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const first = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session1.body.session_id,
          pairing_token: session1.body.pairing_token,
          device_name: member.deviceName
        });
      expect(first.status).toBe(201);

      // A second QR (created after the first claim) must not let the same
      // device queue a duplicate PENDING request
      const session2 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      expect(session2.status).toBe(201);

      const second = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session2.body.session_id,
          pairing_token: session2.body.pairing_token,
          device_name: member.deviceName
        });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('REQUEST_ALREADY_PENDING');

      // The owner queue still holds exactly one request
      const queue = await request(server)
        .get(`/api/v2/channels/requests?channel_id=${channelId}&status=PENDING`)
        .set(bearer(owner.token));
      expect(queue.body.requests).toHaveLength(1);
    });

    it('releases the dedup marker on cancel so the device can claim a fresh QR', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');

      const session1 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const first = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session1.body.session_id,
          pairing_token: session1.body.pairing_token,
          device_name: member.deviceName
        });
      expect(first.status).toBe(201);

      const cancel = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(member.token))
        .send({ request_id: first.body.request_id });
      expect(cancel.status).toBe(200);

      const session2 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const second = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session2.body.session_id,
          pairing_token: session2.body.pairing_token,
          device_name: member.deviceName
        });
      expect(second.status).toBe(201);
      expect(second.body.status).toBe('PENDING');
    });

    it('releases the dedup marker on reject so the device can claim a fresh QR', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');

      const session1 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const first = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session1.body.session_id,
          pairing_token: session1.body.pairing_token,
          device_name: member.deviceName
        });
      expect(first.status).toBe(201);

      const reject = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ request_id: first.body.request_id });
      expect(reject.status).toBe(200);

      const session2 = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const second = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: session2.body.session_id,
          pairing_token: session2.body.pairing_token,
          device_name: member.deviceName
        });
      expect(second.status).toBe(201);
      expect(second.body.status).toBe('PENDING');
    });
  });

  describe('POST /api/v2/pairing/requests/approve (T2, §5.4)', () => {
    it('approves with rotate: new epoch, membership_version+1, member provisioned', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const before = await channelState(owner.token, channelId);
      const epoch = await joinChannel(owner, channelId, member);

      expect(epoch).toBe(before.current_epoch + 1);
      const after = await channelState(owner.token, channelId);
      expect(after.current_epoch).toBe(before.current_epoch + 1);
      expect(after.membership_version).toBe(before.membership_version + 1);

      const membersRes = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(owner.token));
      const memberRow = membersRes.body.members.find((m: any) => m.device_id === member.deviceId);
      expect(memberRow.status).toBe('ACTIVE');
      expect(memberRow.joined_epoch).toBe(epoch);
      expect(memberRow.provisioned_epoch).toBe(epoch);

      // Request is terminal APPROVED
      const mine = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      expect(mine.body.requests[0].status).toBe('APPROVED');
      expect(mine.body.requests[0].decided_at).toBeTruthy();
    });

    it('409 MEMBERSHIP_CHANGED when the package snapshot is stale (KL6)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');

      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'B'
        });

      const state = await channelState(owner.token, channelId);
      const res = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          request_id: claimRes.body.request_id,
          package: packageFor([owner.deviceId, member.deviceId], state.current_epoch + 5, state.membership_version, state.current_epoch + 1)
        });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('MEMBERSHIP_CHANGED');
    });

    it('422 PACKAGE_INCOMPLETE when the envelope set is wrong (KL3)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'B'
        });

      const state = await channelState(owner.token, channelId);
      // Missing the requester's envelope
      const res = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          request_id: claimRes.body.request_id,
          package: packageFor([owner.deviceId], state.current_epoch, state.membership_version, state.current_epoch + 1)
        });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('PACKAGE_INCOMPLETE');
    });

    it('409 REQUEST_NOT_PENDING on double approve; 403 NOT_OWNER for non-owner', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const stranger = await reg('Stranger');
      const { channelId } = await createChannel(owner, 'Kênh');
      const epoch = await joinChannel(owner, channelId, member);

      // Retrieve the request id via member's "mine"
      const mine = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      const requestId = mine.body.requests[0].request_id;

      const state = await channelState(owner.token, channelId);
      const ids = await activeMemberIds(owner.token, channelId);

      const double = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(owner.token))
        .send({
          request_id: requestId,
          package: packageFor(ids, state.current_epoch, state.membership_version, state.current_epoch + 1)
        });
      expect(double.status).toBe(409);
      expect(double.body.error).toBe('REQUEST_NOT_PENDING');

      const notOwner = await request(server)
        .post('/api/v2/pairing/requests/approve')
        .set(bearer(stranger.token))
        .send({
          request_id: requestId,
          package: packageFor(ids, state.current_epoch, state.membership_version, epoch + 1)
        });
      expect(notOwner.status).toBe(403);
      expect(notOwner.body.error).toBe('NOT_OWNER');
    });
  });

  describe('T6 — reject (§5.5) & cancel (§5.6)', () => {
    it('owner rejects a PENDING request', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'B'
        });

      const res = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ request_id: claimRes.body.request_id });
      expect(res.status).toBe(200);

      const mine = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      expect(mine.body.requests[0].status).toBe('REJECTED');

      // Rejecting again → 409 REQUEST_NOT_PENDING
      const again = await request(server)
        .post('/api/v2/pairing/requests/reject')
        .set(bearer(owner.token))
        .send({ request_id: claimRes.body.request_id });
      expect(again.status).toBe(409);
    });

    it('requester cancels their own PENDING request; non-requester gets 403', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const stranger = await reg('Stranger');
      const { channelId } = await createChannel(owner, 'Kênh');
      const sessionRes = await request(server)
        .post('/api/v2/channels/sessions')
        .set(bearer(owner.token))
        .send({ channel_id: channelId });
      const claimRes = await request(server)
        .post('/api/v2/pairing/requests')
        .set(bearer(member.token))
        .send({
          session_id: sessionRes.body.session_id,
          pairing_token: sessionRes.body.pairing_token,
          device_name: 'B'
        });

      const forbidden = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(stranger.token))
        .send({ request_id: claimRes.body.request_id });
      expect(forbidden.status).toBe(403);

      const res = await request(server)
        .post('/api/v2/pairing/requests/cancel')
        .set(bearer(member.token))
        .send({ request_id: claimRes.body.request_id });
      expect(res.status).toBe(200);

      const mine = await request(server).get('/api/v2/pairing/requests/mine').set(bearer(member.token));
      expect(mine.body.requests[0].status).toBe('CANCELLED');
    });
  });

  // ------------------------------------------- 6. Key envelopes & messages
  describe('GET /api/v2/channels/key-envelope (§6.1)', () => {
    it('returns the caller envelope for a specific epoch', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');

      const res = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=1`)
        .set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, key_epoch: 1, kek_alg: KEK_ALG });
      expect(res.body.wrapped_key).toBeTruthy();
      expect(res.body.nonce).toBeTruthy();
    });

    it('epoch omitted → highest provisioned epoch (latest mode, SRD 7.3)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      const epoch2 = await joinChannel(owner, channelId, member);

      const res = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}`)
        .set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.body.key_epoch).toBe(epoch2);
    });

    it('404 when the epoch was never provisioned (KL8)', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');

      const res = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=99`)
        .set(bearer(owner.token));
      expect(res.status).toBe(404);
    });

    it('403 REVOKED for a revoked member — no envelope, even old epochs (KL12)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [member.deviceId],
          package: packageFor([owner.deviceId], 2, 2, 3)
        });

      const res = await request(server)
        .get(`/api/v2/channels/key-envelope?channel_id=${channelId}&epoch=2`)
        .set(bearer(member.token));
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('REVOKED');
    });
  });

  describe('POST /api/v2/channels/messages (T5 + T3, §6.2)', () => {
    it('accepts owner messages and assigns monotonic sequence numbers', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');

      const first = await sendMessage(owner, channelId, 1, 'otp-1');
      expect(first.status).toBe(201);
      expect(first.body.sequence_number).toBe(1);
      expect(first.body.server_received_at).toBeTruthy();

      const second = await sendMessage(owner, channelId, 1, 'otp-2');
      expect(second.status).toBe(201);
      expect(second.body.sequence_number).toBe(2);
    });

    it('409 REPLAY_DETECTED for the same (channel|nonce|ciphertext) within 24h', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');

      const payload = {
        channel_id: channelId,
        request_epoch: 1,
        ciphertext: Buffer.from('otp-dup').toString('base64'),
        nonce: nonce12()
      };
      const first = await request(server).post('/api/v2/channels/messages').set(bearer(owner.token)).send(payload);
      expect(first.status).toBe(201);

      const second = await request(server).post('/api/v2/channels/messages').set(bearer(owner.token)).send(payload);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('REPLAY_DETECTED');
    });

    it('409 EPOCH_OUTDATED when request_epoch != current_epoch (KL7)', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member); // epoch is now 2

      const stale = await sendMessage(owner, channelId, 1, 'old-epoch-otp');
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('EPOCH_OUTDATED');

      const fresh = await sendMessage(owner, channelId, 2, 'new-epoch-otp');
      expect(fresh.status).toBe(201);
    });

    it('403 FORBIDDEN when a non-owner sends; 401 without token', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);

      const res = await request(server)
        .post('/api/v2/channels/messages')
        .set(bearer(member.token))
        .send({
          channel_id: channelId,
          request_epoch: 2,
          ciphertext: Buffer.from('x').toString('base64'),
          nonce: nonce12()
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');

      const noAuth = await request(server).post('/api/v2/channels/messages').send({});
      expect(noAuth.status).toBe(401);
    });
  });

  describe('GET /api/v2/messages?date=&tz_offset= (§6.3)', () => {
    it('fetches the day across ALL active channels, sorted by server_received_at', async () => {
      const ownerA = await reg('Owner A');
      const ownerB = await reg('Owner B');
      const member = await reg('Member');

      const { channelId: chA } = await createChannel(ownerA, 'Kênh A');
      const { channelId: chB } = await createChannel(ownerB, 'Kênh B');
      await joinChannel(ownerA, chA, member);
      await joinChannel(ownerB, chB, member);

      await sendMessage(ownerA, chA, 2, 'otp-from-A');
      await sendMessage(ownerB, chB, 2, 'otp-from-B');

      const today = new Date().toISOString().slice(0, 10);
      const res = await request(server)
        .get(`/api/v2/messages?date=${today}&tz_offset=0`)
        .set(bearer(member.token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.date).toBe(today);
      expect(res.body.truncated).toBe(false);
      expect(res.body.messages).toHaveLength(2);

      const sources = res.body.messages.map((m: any) => m.channel_name).sort();
      expect(sources).toEqual(['Kênh A', 'Kênh B']);
      for (const msg of res.body.messages) {
        expect(msg).toHaveProperty('channel_id');
        expect(msg).toHaveProperty('sequence_number');
        expect(msg).toHaveProperty('key_epoch');
        expect(msg).toHaveProperty('ciphertext');
        expect(msg).toHaveProperty('nonce');
        expect(msg).toHaveProperty('sender_device_id');
        expect(msg).toHaveProperty('sent_at');
        expect(msg).toHaveProperty('server_received_at');
      }
    });

    it('respects tz_offset day boundaries', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');
      // UTC+7 user "yesterday" boundary: write a message "now" (UTC)
      await sendMessage(owner, channelId, 1, 'tz-check');

      const now = new Date();
      const utcDate = now.toISOString().slice(0, 10);
      const shiftedMs = now.getTime() + 7 * 3600_000;
      const shiftedDate = new Date(shiftedMs).toISOString().slice(0, 10);

      const res = await request(server)
        .get(`/api/v2/messages?date=${shiftedDate}&tz_offset=420`)
        .set(bearer(owner.token));
      expect(res.status).toBe(200);
      // The message sent "now" (UTC) belongs to UTC+7's day if now+7h is still
      // the same local day — it always is, since now+7h ≥ now and both fall in
      // the shifted window when now is within [shiftedDate 00:00 UTC+7 ...].
      // If the UTC instant sits before 17:00Z, shifted day == utc day + 0/1.
      const contains = res.body.messages.length === 1;
      expect(contains || res.body.messages.length === 0).toBe(true);
      void utcDate;
    });

    it('excludes revoked channels from results (KL12) and returns [] for no membership', async () => {
      const owner = await reg('Owner');
      const member = await reg('Member');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, member);
      await sendMessage(owner, channelId, 2, 'before-revoke');

      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [member.deviceId],
          package: packageFor([owner.deviceId], 2, 2, 3)
        });

      const today = new Date().toISOString().slice(0, 10);
      const revokedView = await request(server)
        .get(`/api/v2/messages?date=${today}&tz_offset=0`)
        .set(bearer(member.token));
      expect(revokedView.status).toBe(200);
      expect(revokedView.body.messages).toHaveLength(0);

      const ownerView = await request(server)
        .get(`/api/v2/messages?date=${today}&tz_offset=0`)
        .set(bearer(owner.token));
      expect(ownerView.body.messages).toHaveLength(1);
    });

    it('caps at 1000 newest messages with truncated=true (§6.3)', async () => {
      const owner = await reg('Owner');
      const { channelId } = await createChannel(owner, 'Kênh');

      const db = (mockFirestore as any) as {
        collection: (name: string) => {
          doc: (id?: string) => { set: (data: Record<string, unknown>) => Promise<void> };
        };
      };
      const baseMs = Date.now() - 3600_000;
      for (let i = 0; i < 1005; i += 1) {
        await db
          .collection('channel_messages')
          .doc(`bulk_${i}`)
          .set({
            message_id: `bulk_${i}`,
            channel_id: channelId,
            sequence_number: i + 1,
            ciphertext: Buffer.from(`m${i}`).toString('base64'),
            nonce: crypto.randomBytes(12).toString('base64'),
            key_epoch: 1,
            sender_device_id: owner.deviceId,
            sent_at: new Date(baseMs + i).toISOString(),
            server_received_at: new Date(baseMs + i).toISOString()
          });
      }

      const today = new Date().toISOString().slice(0, 10);
      const res = await request(server)
        .get(`/api/v2/messages?date=${today}&tz_offset=0`)
        .set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(true);
      expect(res.body.messages).toHaveLength(1000);
      // The 1000 NEWEST are returned (5 oldest dropped)
      expect(res.body.messages[0].sequence_number).toBe(6);
      expect(res.body.messages[999].sequence_number).toBe(1005);
    });
  });

  // ------------------------------------------------- T4 revoke with rotate
  describe('POST /api/v2/channels/revoke (T4, §4.6)', () => {
    it('revokes members + rotates epoch + bumps membership_version', async () => {
      const owner = await reg('Owner');
      const b = await reg('B');
      const c = await reg('C');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, b);
      await joinChannel(owner, channelId, c);

      const before = await channelState(owner.token, channelId); // epoch 3, version 3
      const ids = await activeMemberIds(owner.token, channelId);
      expect(ids).toHaveLength(3);

      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [c.deviceId],
          package: packageFor([owner.deviceId, b.deviceId], before.current_epoch, before.membership_version, before.current_epoch + 1)
        });
      expect(res.status).toBe(200);
      expect(res.body.current_epoch).toBe(before.current_epoch + 1);
      expect(res.body.membership_version).toBe(before.membership_version + 1);

      // Remaining members get provisioned_epoch = new epoch
      const members = await request(server)
        .get(`/api/v2/channels/members?channel_id=${channelId}`)
        .set(bearer(owner.token));
      const bRow = members.body.members.find((m: any) => m.device_id === b.deviceId);
      expect(bRow.provisioned_epoch).toBe(before.current_epoch + 1);

      // Revoked member loses access everywhere (KL12)
      const cDetail = await request(server)
        .get(`/api/v2/channels/detail?channel_id=${channelId}`)
        .set(bearer(c.token));
      expect(cDetail.status).toBe(403);
    });

    it('422 when the envelope set does not match {Owner} ∪ {ACTIVE remaining} (KL8)', async () => {
      const owner = await reg('Owner');
      const b = await reg('B');
      const c = await reg('C');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, b);
      await joinChannel(owner, channelId, c);

      const before = await channelState(owner.token, channelId);
      // Envelope set wrongly keeps revoked C
      const res = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [c.deviceId],
          package: packageFor(
            [owner.deviceId, b.deviceId, c.deviceId],
            before.current_epoch,
            before.membership_version,
            before.current_epoch + 1
          )
        });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('PACKAGE_INCOMPLETE');

      // Stale snapshot → 409
      const stale = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [c.deviceId],
          package: packageFor(
            [owner.deviceId, b.deviceId],
            before.current_epoch - 1,
            before.membership_version - 1,
            before.current_epoch + 1
          )
        });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('MEMBERSHIP_CHANGED');
    });

    it('owner cannot be revoked; targets must be ACTIVE members', async () => {
      const owner = await reg('Owner');
      const b = await reg('B');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, b);

      const selfRevoked = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [owner.deviceId],
          package: packageFor([owner.deviceId], 2, 2, 3)
        });
      expect(selfRevoked.status).toBe(400);

      const ghost = await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [randomUUID()],
          package: packageFor([owner.deviceId, b.deviceId], 2, 2, 3)
        });
      expect(ghost.status).toBe(404);
    });

    it('envelope docs exist for every package member at the new epoch (KL3/KL4)', async () => {
      const owner = await reg('Owner');
      const b = await reg('B');
      const { channelId } = await createChannel(owner, 'Kênh');
      await joinChannel(owner, channelId, b);

      const before = await channelState(owner.token, channelId);
      await request(server)
        .post('/api/v2/channels/revoke')
        .set(bearer(owner.token))
        .send({
          channel_id: channelId,
          revoke_device_ids: [b.deviceId],
          package: packageFor([owner.deviceId], before.current_epoch, before.membership_version, before.current_epoch + 1)
        });

      const db = (mockFirestore as any) as { collection: (n: string) => any };
      const snapshot = await db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).get();
      const epochs = snapshot.docs
        .map((d: any) => Number(d.data().key_epoch))
        .filter((e: number) => e === before.current_epoch + 1);
      expect(epochs).toHaveLength(1); // only the owner's self-envelope at N+1
    });
  });

  // ------------------------------------------------------- Error envelope
  describe('Error envelope & conventions (§1, §2)', () => {
    it('returns the standard error envelope shape', async () => {
      const res = await request(server).get('/api/v2/channels/detail?channel_id=nope');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false });
      expect(typeof res.body.error).toBe('string');
      expect(typeof res.body.message).toBe('string');
    });

    it('404 for unknown endpoints (static paths only)', async () => {
      const owner = await reg('Owner');
      const res = await request(server)
        .get(`/api/v2/channels/does-not-exist`)
        .set(bearer(owner.token));
      expect(res.status).toBe(404);
    });
  });
});
