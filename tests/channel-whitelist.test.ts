/// <reference types="jest" />

import request from 'supertest';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { createApp } from '../src/app.js';
import { deviceService } from '../src/services/device.service.js';
import { channelService } from '../src/services/channel.service.js';
import { KEK_ALG } from '../src/types/v2.js';

describe('PUT /api/v2/channels/whitelist & GET /api/v2/channels/detail (Whitelist E2EE)', () => {
  const expressApp = createApp();
  let server: any;

  beforeAll((done) => {
    server = expressApp.listen(0, done);
  });

  afterAll((done) => {
    if (server) server.close(done);
    else done();
  });

  beforeEach(async () => {
    await channelService.clearAll();
    await deviceService.clearAll();
  });

  interface DeviceCtx {
    deviceId: string;
    token: string;
    publicKey: string;
    deviceName: string;
  }

  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  const fakePubkey = (): string => crypto.randomBytes(32).toString('base64');
  const nonce12 = (): string => crypto.randomBytes(12).toString('base64');

  const reg = async (deviceName: string): Promise<DeviceCtx> => {
    const publicKey = fakePubkey();
    const deviceId = randomUUID();
    const res = await request(server)
      .post('/api/v2/devices/register')
      .send({ device_id: deviceId, device_name: deviceName, platform: 'android', public_key: publicKey });
    expect(res.status).toBe(201);
    return { deviceId: res.body.device_id, token: res.body.device_token, publicKey, deviceName };
  };

  const createChannel = async (owner: DeviceCtx, name = 'Kênh OTP'): Promise<string> => {
    const res = await request(server)
      .post('/api/v2/channels')
      .set(bearer(owner.token))
      .send({
        name,
        package: {
          base_epoch: 1,
          base_membership_version: 1,
          envelopes: [
            {
              device_id: owner.deviceId,
              key_epoch: 1,
              wrapped_key: crypto.randomBytes(32).toString('base64'),
              nonce: nonce12(),
              kek_alg: KEK_ALG
            }
          ]
        }
      });
    expect(res.status).toBe(201);
    return res.body.channel_id;
  };

  it('initially returns whitelist: null in GET /channels/detail', async () => {
    const owner = await reg('Owner Device');
    const channelId = await createChannel(owner);

    const res = await request(server)
      .get(`/api/v2/channels/detail?channel_id=${channelId}`)
      .set(bearer(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.whitelist).toBeNull();
  });

  it('allows owner to update whitelist with valid E2EE blob', async () => {
    const owner = await reg('Owner Device');
    const channelId = await createChannel(owner);

    const nonce = nonce12();
    const ciphertext = Buffer.from('encrypted_whitelist_data').toString('base64');

    const putRes = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext,
        nonce,
        whitelist_version: 1
      });

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);
    expect(putRes.body.whitelist).toMatchObject({
      key_epoch: 1,
      ciphertext,
      nonce,
      whitelist_version: 1
    });
    expect(putRes.body.whitelist.updated_at).toBeDefined();

    // Verify GET /channels/detail returns updated whitelist
    const detailRes = await request(server)
      .get(`/api/v2/channels/detail?channel_id=${channelId}`)
      .set(bearer(owner.token));

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.whitelist).toMatchObject({
      key_epoch: 1,
      ciphertext,
      nonce,
      whitelist_version: 1
    });
  });

  it('includes the opaque whitelist blob in GET /channels for owner and members', async () => {
    const owner = await reg('Owner Device');
    const channelId = await createChannel(owner);

    const before = await request(server).get('/api/v2/channels').set(bearer(owner.token));
    expect(before.status).toBe(200);
    expect(before.body.channels[0].whitelist).toBeNull();

    const nonce = nonce12();
    const ciphertext = Buffer.from('encrypted_whitelist_data').toString('base64');
    await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({ channel_id: channelId, key_epoch: 1, ciphertext, nonce, whitelist_version: 1 })
      .expect(200);

    const after = await request(server).get('/api/v2/channels').set(bearer(owner.token));
    expect(after.body.channels[0].whitelist).toMatchObject({
      key_epoch: 1,
      ciphertext,
      nonce,
      whitelist_version: 1
    });
  });

  it('rejects non-owner with 403 NOT_OWNER', async () => {
    const owner = await reg('Owner Device');
    const stranger = await reg('Stranger Device');
    const channelId = await createChannel(owner);

    const putRes = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(stranger.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext: Buffer.from('test').toString('base64'),
        nonce: nonce12(),
        whitelist_version: 1
      });

    expect(putRes.status).toBe(403);
    expect(putRes.body.error).toBe('NOT_OWNER');
  });

  it('rejects stale whitelist_version with 409 STALE_WHITELIST', async () => {
    const owner = await reg('Owner Device');
    const channelId = await createChannel(owner);

    // First update: version 2
    const firstPut = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext: Buffer.from('version_2').toString('base64'),
        nonce: nonce12(),
        whitelist_version: 2
      });
    expect(firstPut.status).toBe(200);

    // Stale update: version 1 (less than 2)
    const stalePut = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext: Buffer.from('version_1').toString('base64'),
        nonce: nonce12(),
        whitelist_version: 1
      });
    expect(stalePut.status).toBe(409);
    expect(stalePut.body.error).toBe('STALE_WHITELIST');

    // Duplicate update: version 2 (equal to 2)
    const dupPut = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext: Buffer.from('version_2_again').toString('base64'),
        nonce: nonce12(),
        whitelist_version: 2
      });
    expect(dupPut.status).toBe(409);
    expect(dupPut.body.error).toBe('STALE_WHITELIST');

    // Newer update: version 3 succeeds
    const newerPut = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext: Buffer.from('version_3').toString('base64'),
        nonce: nonce12(),
        whitelist_version: 3
      });
    expect(newerPut.status).toBe(200);
    expect(newerPut.body.whitelist.whitelist_version).toBe(3);
  });

  it('rejects invalid payload (nonce not 12 bytes or missing fields) with 400 VALIDATION_ERROR', async () => {
    const owner = await reg('Owner Device');
    const channelId = await createChannel(owner);

    // Nonce only 4 bytes (invalid)
    const invalidNonce = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        ciphertext: Buffer.from('test').toString('base64'),
        nonce: Buffer.from('1234').toString('base64'),
        whitelist_version: 1
      });
    expect(invalidNonce.status).toBe(400);
    expect(invalidNonce.body.error).toBe('VALIDATION_ERROR');

    // Missing ciphertext
    const missingCipher = await request(server)
      .put('/api/v2/channels/whitelist')
      .set(bearer(owner.token))
      .send({
        channel_id: channelId,
        key_epoch: 1,
        nonce: nonce12(),
        whitelist_version: 1
      });
    expect(missingCipher.status).toBe(400);
    expect(missingCipher.body.error).toBe('VALIDATION_ERROR');
  });
});
