import request from 'supertest';
import * as crypto from 'crypto';
import { createApp } from '../src/app.js';
import { sessionService } from '../src/services/session.service.js';
import { deviceService } from '../src/services/device.service.js';
import { fcmService } from '../src/services/fcm.service.js';

describe('SMS Navigator Server Integration Tests', () => {
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

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  const expectIso8601 = (value: string) => {
    expect(typeof value).toBe('string');
    expect(new Date(value).toISOString()).toBe(value);
  };

  const registerDevice = async (deviceId?: string): Promise<{ deviceId: string; token: string }> => {
    const res = await request(server)
      .post('/api/v1/devices/register')
      .send(deviceId ? { device_id: deviceId } : {});
    return { deviceId: res.body.device_id, token: res.body.token };
  };

  const bearer = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`
  });

  const createPendingPair = async (pairId: string, senderId?: string, receiverId?: string) => {
    const a = await registerDevice(senderId ?? `A_${pairId}`);
    const b = await registerDevice(receiverId ?? `B_${pairId}`);
    await request(server)
      .post('/api/v1/pair/init')
      .set(bearer(a.token))
      .send({ pair_id: pairId });
    return { a, b };
  };

  const createPairedPair = async (pairId: string) => {
    const a = await registerDevice(`A_${pairId}`);
    const b = await registerDevice(`B_${pairId}`);
    const c = await registerDevice(`C_${pairId}`);
    await request(server)
      .post('/api/v1/pair/init')
      .set(bearer(a.token))
      .send({ pair_id: pairId });
    await request(server)
      .post('/api/v1/pair/confirm')
      .set(bearer(b.token))
      .send({
        pair_id: pairId,
        fcm_token: `fcm_receiver_${pairId}_12345`,
        device_name: 'Receiver Phone',
        platform: 'android'
      });
    return { a, b, c, pairId };
  };

  beforeEach(async () => {
    await sessionService.clearAll();
    await deviceService.clearAll();
    jest.restoreAllMocks();
  });

  describe('GET /api/v1/health', () => {
    it('should return healthy status', async () => {
      const res = await request(server).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });
  });

  describe('POST /api/v1/devices/register', () => {
    it('should register a device and return a raw CSPRNG token (201)', async () => {
      const res = await request(server).post('/api/v1/devices/register').send({
        device_id: 'device_A_register',
        device_name: 'Pixel 8 (Vietnam)',
        platform: 'android'
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.device_id).toBe('device_A_register');
      expect(res.body.token).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.token_type).toBe('Bearer');
      expect(res.body.created_at).toBeDefined();
      expectIso8601(res.body.created_at);
      expect(new Date(res.body.created_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should auto-generate a unique device_id when not provided', async () => {
      const first = await request(server).post('/api/v1/devices/register').send({});
      const second = await request(server).post('/api/v1/devices/register').send({});

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.device_id).toBeDefined();
      expect(second.body.device_id).toBeDefined();
      expect(first.body.device_id).not.toBe(second.body.device_id);
    });

    it('should store only the SHA-256 hash of the token, never the plaintext', async () => {
      const { token } = await registerDevice('device_hash_check');
      const device = await deviceService.findByDeviceId('device_hash_check');

      expect(device).not.toBeNull();
      expect(device!.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(device)).not.toContain(token);
    });

    it('should invalidate the previously issued token when re-registering the same device_id', async () => {
      const first = await registerDevice('device_re_register');
      const second = await registerDevice('device_re_register');
      expect(first.token).not.toBe(second.token);

      const oldTokenRes = await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(first.token))
        .send({ fcm_token: 'fcm_attempt_with_old_token_12345' });
      expect(oldTokenRes.status).toBe(401);

      const newTokenRes = await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(second.token))
        .send({ fcm_token: 'fcm_attempt_with_new_token_12345' });
      expect(newTokenRes.status).toBe(200);
    });

    it('should reject invalid payload with 400', async () => {
      const res = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'ab', platform: 'unknown_platform' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('PUT /api/v1/devices/fcm-token', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(server)
        .put('/api/v1/devices/fcm-token')
        .send({ fcm_token: 'fcm_token_without_auth_12345' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 for an unknown token', async () => {
      const res = await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer('totally_unknown_token_value_12345'))
        .send({ fcm_token: 'fcm_token_with_bad_auth_12345' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 for malformed Authorization header (not Bearer)', async () => {
      const res = await request(server)
        .put('/api/v1/devices/fcm-token')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .send({ fcm_token: 'fcm_token_basic_auth_12345' });

      expect(res.status).toBe(401);
    });

    it('should return 400 when fcm_token is missing or too short', async () => {
      const { token } = await registerDevice('device_fcm_invalid');

      const missing = await request(server).put('/api/v1/devices/fcm-token').set(bearer(token)).send({});
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('VALIDATION_ERROR');

      const tooShort = await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(token))
        .send({ fcm_token: 'short' });
      expect(tooShort.status).toBe(400);
    });

    it('should update the FCM token of the authenticated device', async () => {
      const { token, deviceId } = await registerDevice('device_fcm_update');

      const res = await request(server)
        .put('/api/v1/devices/fcm-token')
        .set(bearer(token))
        .send({ fcm_token: 'fcm_updated_token_value_12345' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.device_id).toBe(deviceId);
      expect((await deviceService.findByDeviceId(deviceId))?.fcm_token).toBe('fcm_updated_token_value_12345');
    });
  });

  describe('POST /api/v1/pair/init (Device A)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(server).post('/api/v1/pair/init').send({ pair_id: 'pair_no_auth' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should create a pair and return pair_id (201)', async () => {
      const { token } = await registerDevice('device_A_init');

      const res = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(token))
        .send({ pair_id: 'pair_init_001' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.pair_id).toBe('pair_init_001');
      expect(res.body.pairing_code).toBeUndefined();

      const pair = await sessionService.getPair('pair_init_001');
      expect(pair?.sender_device_id).toBe('device_A_init');
    });

    it('should auto-generate pair_id when omitted', async () => {
      const { token } = await registerDevice('device_A_init_auto');

      const res = await request(server).post('/api/v1/pair/init').set(bearer(token)).send({});

      expect(res.status).toBe(201);
      expect(res.body.pair_id).toBeDefined();
      expect((await sessionService.getPair(res.body.pair_id))?.sender_device_id).toBe('device_A_init_auto');
    });

    it('should let Device A re-init the same pending pair', async () => {
      const a = await registerDevice('device_A_reinit');
      const b = await registerDevice('device_B_reinit');

      const first = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ pair_id: 'pair_reinit' });
      const second = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ pair_id: 'pair_reinit' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.pair_id).toBe('pair_reinit');

      const confirm = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pair_id: 'pair_reinit', fcm_token: 'fcm_reinit_receiver_12345' });
      expect(confirm.status).toBe(200);
    });

    it('should return 403 when a foreign device (Device C) initializes an existing pair_id', async () => {
      const a = await registerDevice('device_A_owner');
      const c = await registerDevice('device_C_intruder');

      await request(server).post('/api/v1/pair/init').set(bearer(a.token)).send({ pair_id: 'pair_hijack' });

      const res = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(c.token))
        .send({ pair_id: 'pair_hijack' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('should return 409 when the pair has already been confirmed', async () => {
      const { a, pairId } = await createPairedPair('pair_conflicted');

      const res = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ pair_id: pairId });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PAIR_ALREADY_CONFIRMED');
    });
  });

  describe('POST /api/v1/pair/confirm (Device B)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .send({ pair_id: 'pair_confirm_noauth', fcm_token: 'fcm_token_123456' });
      expect(res.status).toBe(401);
    });

    it('should reject invalid payload with 400', async () => {
      const { token } = await registerDevice('device_B_invalid_payload');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(token))
        .send({ pair_id: 'ab' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for an unknown pair_id', async () => {
      const { token } = await registerDevice('device_B_unknown_pair');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(token))
        .send({ pair_id: 'pair_missing', fcm_token: 'fcm_token_123456' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PAIR_NOT_FOUND');
    });

    it('should block Device A from confirming its own pair (400)', async () => {
      const { a } = await createPendingPair('pair_self_block');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(a.token))
        .send({ pair_id: 'pair_self_block', fcm_token: 'fcm_self_pair_12345' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('SELF_PAIRING_NOT_ALLOWED');
      expect((await sessionService.getPair('pair_self_block'))?.receiver_device_id).toBeUndefined();
    });

    it('should bind Device B and register its FCM token (200)', async () => {
      const { b } = await createPendingPair('pair_confirm_ok');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({
          pair_id: 'pair_confirm_ok',
          fcm_token: 'fcm_receiver_confirmed_12345',
          device_name: 'Samsung S24 (Malaysia)',
          platform: 'android'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pair_id).toBe('pair_confirm_ok');
      expectIso8601(res.body.paired_at);
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(nowSeconds() * 1000);

      const pair = await sessionService.getPair('pair_confirm_ok');
      expect(pair?.receiver_device_id).toBe(`B_pair_confirm_ok`);
      expect(pair?.fcm_token).toBe('fcm_receiver_confirmed_12345');

      const reuse = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pair_id: 'pair_confirm_ok', fcm_token: 'fcm_receiver_confirmed_12345' });
      expect(reuse.status).toBe(409);
      expect(reuse.body.error).toBe('PAIR_ALREADY_CONFIRMED');
    });

    it('should confirm pairing via the QR flow (no code, 200)', async () => {
      const a = await registerDevice('A_pair_qr_flow');
      const b = await registerDevice('B_pair_qr_flow');

      const init = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ pair_id: 'pair_qr_flow' });
      expect(init.status).toBe(201);

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({
          pair_id: 'pair_qr_flow',
          fcm_token: 'fcm_qr_receiver_12345',
          device_name: 'QR Receiver',
          platform: 'android'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pair_id).toBe('pair_qr_flow');
      expectIso8601(res.body.paired_at);
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(nowSeconds() * 1000);

      const pair = await sessionService.getPair('pair_qr_flow');
      expect(pair?.receiver_device_id).toBe('B_pair_qr_flow');
      expect(pair?.fcm_token).toBe('fcm_qr_receiver_12345');

      const second = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pair_id: 'pair_qr_flow', fcm_token: 'fcm_qr_receiver_12345' });
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('PAIR_ALREADY_CONFIRMED');
    });

    it('should block Device A from QR-confirming its own pair (400)', async () => {
      const a = await registerDevice('A_pair_qr_self');

      await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ pair_id: 'pair_qr_self' });

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(a.token))
        .send({ pair_id: 'pair_qr_self', fcm_token: 'fcm_qr_self_12345' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('SELF_PAIRING_NOT_ALLOWED');
      expect((await sessionService.getPair('pair_qr_self'))?.receiver_device_id).toBeUndefined();
    });
  });

  describe('GET /api/v1/pair/status/:pairId (ownership enforced)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(server).get('/api/v1/pair/status/pair_status_noauth');
      expect(res.status).toBe(401);
    });

    it('should return 404 when the pair does not exist', async () => {
      const { token } = await registerDevice('device_status_unknown');

      const res = await request(server)
        .get('/api/v1/pair/status/pair_unknown_404')
        .set(bearer(token));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PAIR_NOT_FOUND');
    });

    it('should let Device A (sender) view pending pair status', async () => {
      const { a } = await createPendingPair('pair_status_pending');

      const res = await request(server).get('/api/v1/pair/status/pair_status_pending').set(bearer(a.token));

      expect(res.status).toBe(200);
      expect(res.body.pair_id).toBe('pair_status_pending');
      expect(res.body.is_paired).toBe(false);
      expect(res.body.sender_device_id).toBe(`A_pair_status_pending`);
    });

    it('should let Device B (receiver) view paired status', async () => {
      const { b } = await createPairedPair('pair_status_paired');

      const res = await request(server).get('/api/v1/pair/status/pair_status_paired').set(bearer(b.token));

      expect(res.status).toBe(200);
      expect(res.body.is_paired).toBe(true);
      expect(res.body.receiver_device_id).toBe(`B_pair_status_paired`);
      expect(res.body.device_name).toBe('Receiver Phone');
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(nowSeconds() * 1000);
    });

    it('should return 403 Forbidden for Device C (not a participant)', async () => {
      const { c } = await createPairedPair('pair_status_forbidden');

      const res = await request(server).get('/api/v1/pair/status/pair_status_forbidden').set(bearer(c.token));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /api/v1/pair/:pairId (ownership enforced)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(server).delete('/api/v1/pair/pair_revoke_noauth');
      expect(res.status).toBe(401);
    });

    it('should return 404 when the pair does not exist', async () => {
      const { token } = await registerDevice('device_revoke_unknown');

      const res = await request(server).delete('/api/v1/pair/pair_unknown_revoke').set(bearer(token));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PAIR_NOT_FOUND');
    });

    it('should return 403 Forbidden for Device C (not a participant)', async () => {
      const { c } = await createPairedPair('pair_revoke_forbidden');

      const res = await request(server).delete('/api/v1/pair/pair_revoke_forbidden').set(bearer(c.token));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
      expect(await sessionService.getPair('pair_revoke_forbidden')).not.toBeNull();
    });

    it('should let Device A revoke the pair', async () => {
      const { a } = await createPairedPair('pair_revoke_by_a');

      const res = await request(server).delete('/api/v1/pair/pair_revoke_by_a').set(bearer(a.token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await request(server)
        .get('/api/v1/pair/status/pair_revoke_by_a')
        .set(bearer(a.token));
      expect(check.status).toBe(404);
    });

    it('should let Device B revoke the pair', async () => {
      const { b } = await createPairedPair('pair_revoke_by_b');

      const res = await request(server).delete('/api/v1/pair/pair_revoke_by_b').set(bearer(b.token));
      expect(res.status).toBe(200);
      expect(await sessionService.getPair('pair_revoke_by_b')).toBeNull();
    });
  });

  describe('POST /api/v1/relay (Blind Relay)', () => {
    const relayBody = (pairId: string, messageId?: string) => ({
      pair_id: pairId,
      ...(messageId ? { message_id: messageId } : {}),
      encrypted_payload: 'U2FsdGVkX19mock_encrypted_otp_bytes==',
      iv: 'aXZfc2FsdF8xMmJ5dGVz',
      sent_at: nowSeconds(),
      ttl_seconds: 300
    });

    it('should return 401 without auth', async () => {
      const res = await request(server)
        .post('/api/v1/relay')
        .send(relayBody('pair_relay_noauth', 'msg_noauth_1'));

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 404 when the pair does not exist', async () => {
      const { a } = await createPairedPair('pair_relay_suite');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody('pair_never_created', 'msg_missing_pair_1'));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('RECEIVER_NOT_PAIRED');
    });

    it('should return 404 when the receiver has not confirmed the pair yet', async () => {
      const { a } = await createPendingPair('pair_relay_pending');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody('pair_relay_pending', 'msg_pending_pair_1'));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('RECEIVER_NOT_PAIRED');
    });

    it('should return 400 PAYLOAD_EXPIRED when sent_at is too old', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_expired');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_expired_1'), sent_at: nowSeconds() - 500 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PAYLOAD_EXPIRED');
    });

    it('should apply a 2-minute grace buffer before declaring the payload expired', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_skew_buffer');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_skew_buffer_1'), sent_at: nowSeconds() - 400 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should accept sent_at up to 2 minutes in the future (device clock skew)', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_skew_future');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_skew_future_1'), sent_at: nowSeconds() + 60 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 400 INVALID_SENT_AT when sent_at is more than 2 minutes in the future', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_skew_invalid');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_skew_invalid_1'), sent_at: nowSeconds() + 180 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_SENT_AT');
    });

    it('should return 403 when Device B (receiver) tries to relay', async () => {
      const { b, pairId } = await createPairedPair('pair_relay_by_receiver');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(b.token))
        .send(relayBody(pairId, 'msg_from_receiver_1'));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('should return 403 when Device C (foreign device) tries to relay', async () => {
      const { c, pairId } = await createPairedPair('pair_relay_by_c');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(c.token))
        .send(relayBody(pairId, 'msg_from_c_1'));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('should relay the OTP payload when sent by Device A (sender)', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_by_sender');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_from_sender_1'));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message_id).toBe('msg_from_sender_1');
      expect(res.body.duplicate).toBeUndefined();
      expectIso8601(res.body.relayed_at);
      expect(new Date(res.body.relayed_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should accept sent_at as ISO 8601 string, epoch seconds or epoch milliseconds', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_time_formats');

      const iso = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_time_iso'), sent_at: new Date().toISOString() });
      expect(iso.status).toBe(200);

      const seconds = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_time_seconds'), sent_at: nowSeconds() });
      expect(seconds.status).toBe(200);

      const millis = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_time_millis'), sent_at: Date.now() });
      expect(millis.status).toBe(200);

      const pending = await request(server)
        .get(`/api/v1/relay/pending/${pairId}`)
        .set(bearer(a.token));
      expect(pending.status).toBe(200);
      const sentAts = pending.body.messages as any[];
      expect(sentAts).toHaveLength(3);
      for (const message of sentAts) {
        expectIso8601(message.sent_at);
      }
    });

    it('should return 400 when sent_at is not a valid timestamp', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_time_invalid');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({ ...relayBody(pairId, 'msg_time_bad'), sent_at: 'not-a-timestamp' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should ignore duplicate message_id within the 10 minute window', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_dedup');
      const spy = jest
        .spyOn(fcmService, 'sendRelayDataMessage')
        .mockResolvedValue('projects/mock/messages/dedup_1');

      const first = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_dup_001'));
      expect(first.status).toBe(200);
      expect(first.body.duplicate).toBeUndefined();

      const duplicate = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_dup_001'));
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.success).toBe(true);
      expect(duplicate.body.duplicate).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);

      const differentMessage = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_dup_002'));
      expect(differentMessage.status).toBe(200);
      expect(differentMessage.body.duplicate).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('should forward the payload untouched to the receiver FCM token (blind relay)', async () => {
      const { a, pairId } = await createPairedPair('pair_relay_blind');
      const spy = jest
        .spyOn(fcmService, 'sendRelayDataMessage')
        .mockResolvedValue('projects/mock/messages/blind_1');

      const res = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_blind_1'));

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          fcmToken: 'fcm_receiver_pair_relay_blind_12345',
          pairId,
          encryptedPayload: 'U2FsdGVkX19mock_encrypted_otp_bytes==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          relayMessageId: 'msg_blind_1'
        })
      );
    });
  });

  describe('GET /api/v1/relay/pending/:pairId (Pending Messages Queue)', () => {
    const relayBody = (pairId: string, messageId: string) => ({
      pair_id: pairId,
      message_id: messageId,
      encrypted_payload: `encrypted_${messageId}==`,
      iv: 'aXZfc2FsdF8xMmJ5dGVz',
      sent_at: nowSeconds(),
      ttl_seconds: 300
    });

    it('should return 401 without auth', async () => {
      const res = await request(server).get('/api/v1/relay/pending/pair_pending_noauth');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 404 when the pair does not exist', async () => {
      const { token } = await registerDevice('device_pending_unknown');

      const res = await request(server)
        .get('/api/v1/relay/pending/pair_never_pending')
        .set(bearer(token));

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PAIR_NOT_FOUND');
    });

    it('should return 403 for Device C (not a participant)', async () => {
      const { c, pairId } = await createPairedPair('pair_pending_forbidden');

      const res = await request(server)
        .get(`/api/v1/relay/pending/${pairId}`)
        .set(bearer(c.token));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('should return relayed messages and auto-clear the queue after fetch', async () => {
      const { a, b, pairId } = await createPairedPair('pair_pending_drain');

      const relay1 = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_pending_001'));
      const relay2 = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_pending_002'));
      expect(relay1.status).toBe(200);
      expect(relay2.status).toBe(200);

      const fetch1 = await request(server)
        .get(`/api/v1/relay/pending/${pairId}`)
        .set(bearer(b.token));
      expect(fetch1.status).toBe(200);
      expect(fetch1.body.success).toBe(true);
      expect(fetch1.body.count).toBe(2);
      expect(fetch1.body.messages).toHaveLength(2);
      expect(fetch1.body.messages.map((m: any) => m.message_id).sort()).toEqual([
        'msg_pending_001',
        'msg_pending_002'
      ]);
      for (const message of fetch1.body.messages) {
        expect(message.encrypted_payload).toBe(`encrypted_${message.message_id}==`);
        expect(message.iv).toBe('aXZfc2FsdF8xMmJ5dGVz');
        expectIso8601(message.sent_at);
        expect(new Date(message.sent_at).getTime()).toBeLessThanOrEqual(Date.now());
        expect(message.ttl_seconds).toBe(300);
      }

      // Queue is drained: the second fetch must be empty
      const fetch2 = await request(server)
        .get(`/api/v1/relay/pending/${pairId}`)
        .set(bearer(b.token));
      expect(fetch2.status).toBe(200);
      expect(fetch2.body.count).toBe(0);
      expect(fetch2.body.messages).toEqual([]);

      // New relayed messages land in the queue again
      await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_pending_003'));

      const fetch3 = await request(server)
        .get(`/api/v1/relay/pending/${pairId}`)
        .set(bearer(b.token));
      expect(fetch3.status).toBe(200);
      expect(fetch3.body.count).toBe(1);
      expect(fetch3.body.messages[0].message_id).toBe('msg_pending_003');
    });

    it('should let Device A (sender) fetch its own queued messages too', async () => {
      const { a, pairId } = await createPairedPair('pair_pending_sender_fetch');

      await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send(relayBody(pairId, 'msg_sender_fetch_1'));

      const res = await request(server)
        .get(`/api/v1/relay/pending/${pairId}`)
        .set(bearer(a.token));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });

    describe('GET /api/v1/relay/history (ISO 8601 range + timezone aware)', () => {
      it('should return 401 without auth', async () => {
        const res = await request(server).get('/api/v1/relay/history');
        expect(res.status).toBe(401);
      });

      it('should return OTP records filtered by ISO from/to range and pairId', async () => {
        const { a, b, pairId } = await createPairedPair('pair_history_test');

        await request(server)
          .post('/api/v1/relay')
          .set(bearer(a.token))
          .send(relayBody(pairId, 'hist_msg_001'));
        await request(server)
          .post('/api/v1/relay')
          .set(bearer(a.token))
          .send(relayBody(pairId, 'hist_msg_002'));

        const from = new Date(Date.now() - 3600_000).toISOString();
        const to = new Date(Date.now() + 3600_000).toISOString();

        const res = await request(server)
          .get(`/api/v1/relay/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&pair_id=${pairId}`)
          .set(bearer(b.token));

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.from).toBe(from);
        expect(res.body.to).toBe(to);
        expect(res.body.count).toBeGreaterThanOrEqual(2);
        expect(res.body.records).toBeDefined();

        for (const record of res.body.records as any[]) {
          expectIso8601(record.sent_at);
          expectIso8601(record.relayed_at);
        }

        const ids = res.body.records.map((r: any) => r.message_id);
        expect(ids).toContain('hist_msg_001');
        expect(ids).toContain('hist_msg_002');
      });

      it('should default to the current UTC day when no range is provided', async () => {
        const { a, pairId } = await createPairedPair('pair_history_default');

        await request(server)
          .post('/api/v1/relay')
          .set(bearer(a.token))
          .send(relayBody(pairId, 'hist_default_001'));

        const res = await request(server)
          .get(`/api/v1/relay/history?pair_id=${pairId}`)
          .set(bearer(a.token));

        expect(res.status).toBe(200);
        const fromMs = new Date(res.body.from).getTime();
        const toMs = new Date(res.body.to).getTime();
        expectIso8601(res.body.from);
        expectIso8601(res.body.to);
        expect(toMs - fromMs).toBe(24 * 3600_000 - 1);
        expect(fromMs).toBeLessThanOrEqual(Date.now());
        expect(res.body.count).toBe(1);
      });

      it('should honor tz=+07:00 so the Vietnam day is not shifted (UTC+7)', async () => {
        const { a, pairId } = await createPairedPair('pair_history_vn_tz');

        await request(server)
          .post('/api/v1/relay')
          .set(bearer(a.token))
          .send(relayBody(pairId, 'hist_vn_001'));

        // "Today" in Vietnam (UTC+7) may differ from the UTC calendar date
        const vnDateStr = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

        const res = await request(server)
          .get(`/api/v1/relay/history?date=${vnDateStr}&tz=%2B07%3A00&pair_id=${pairId}`)
          .set(bearer(a.token));

        expect(res.status).toBe(200);
        // from = Vietnam midnight converted back to UTC: T00:00+07:00 == T17:00Z of the previous UTC day
        expectIso8601(res.body.from);
        const fromMs = new Date(`${vnDateStr}T00:00:00+07:00`).getTime();
        expect(new Date(res.body.from).getTime()).toBe(fromMs);
        expect(new Date(res.body.to).getTime()).toBe(fromMs + 24 * 3600_000 - 1);
        expect(res.body.count).toBe(1);
        expect(res.body.records[0].message_id).toBe('hist_vn_001');
      });

      it('should accept tz as plain minutes (420 == +07:00)', async () => {
        const { a, pairId } = await createPairedPair('pair_history_tz_minutes');
        const vnDateStr = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

        const res = await request(server)
          .get(`/api/v1/relay/history?date=${vnDateStr}&tz=420&pair_id=${pairId}`)
          .set(bearer(a.token));

        expect(res.status).toBe(200);
        const fromMs = new Date(`${vnDateStr}T00:00:00+07:00`).getTime();
        expect(new Date(res.body.from).getTime()).toBe(fromMs);
      });

      it('should return 400 for invalid from/to/tz params', async () => {
        const { a } = await createPairedPair('pair_history_invalid');
        const auth = bearer(a.token);

        const onlyFrom = await request(server)
          .get('/api/v1/relay/history?from=2026-09-30T00:00:00Z')
          .set(auth);
        expect(onlyFrom.status).toBe(400);

        const badFrom = await request(server)
          .get('/api/v1/relay/history?from=not-a-date&to=2026-09-30T00:00:00Z')
          .set(auth);
        expect(badFrom.status).toBe(400);

        const inverted = await request(server)
          .get('/api/v1/relay/history?from=2026-09-30T10:00:00Z&to=2026-09-30T09:00:00Z')
          .set(auth);
        expect(inverted.status).toBe(400);

        const badTz = await request(server)
          .get('/api/v1/relay/history?date=2026-09-30&tz=%2B99%3A99')
          .set(auth);
        expect(badTz.status).toBe(400);

        const badDate = await request(server)
          .get('/api/v1/relay/history?date=30-09-2026')
          .set(auth);
        expect(badDate.status).toBe(400);
      });
    });
  });

  describe('End-to-end pairing & relay flow', () => {
    it('should complete register → init → confirm → status → relay → dedup → revoke', async () => {
      const regA = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'e2e_device_A', device_name: 'Sender', platform: 'android' });
      const regB = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'e2e_device_B', device_name: 'Receiver', platform: 'android' });
      expect(regA.status).toBe(201);
      expect(regB.status).toBe(201);

      const tokenA = regA.body.token as string;
      const tokenB = regB.body.token as string;

      const init = await request(server).post('/api/v1/pair/init').set(bearer(tokenA)).send({});
      expect(init.status).toBe(201);
      const pairId = init.body.pair_id as string;

      const statusBefore = await request(server)
        .get(`/api/v1/pair/status/${pairId}`)
        .set(bearer(tokenA));
      expect(statusBefore.status).toBe(200);
      expect(statusBefore.body.is_paired).toBe(false);

      const confirm = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(tokenB))
        .send({
          pair_id: pairId,
          fcm_token: 'e2e_fcm_receiver_token_12345',
          device_name: 'Receiver Phone',
          platform: 'android'
        });
      expect(confirm.status).toBe(200);

      const statusAfter = await request(server)
        .get(`/api/v1/pair/status/${pairId}`)
        .set(bearer(tokenB));
      expect(statusAfter.status).toBe(200);
      expect(statusAfter.body.is_paired).toBe(true);
      expect(statusAfter.body.receiver_device_id).toBe('e2e_device_B');

      const relay = await request(server)
        .post('/api/v1/relay')
        .set(bearer(tokenA))
        .send({
          pair_id: pairId,
          message_id: 'e2e_msg_001',
          encrypted_payload: 'e2e_encrypted_payload_bytes==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: nowSeconds()
        });
      expect(relay.status).toBe(200);
      expect(relay.body.success).toBe(true);
      expect(relay.body.message_id).toBe('e2e_msg_001');

      const relayDuplicate = await request(server)
        .post('/api/v1/relay')
        .set(bearer(tokenA))
        .send({
          pair_id: pairId,
          message_id: 'e2e_msg_001',
          encrypted_payload: 'e2e_encrypted_payload_bytes==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: nowSeconds()
        });
      expect(relayDuplicate.status).toBe(200);
      expect(relayDuplicate.body.duplicate).toBe(true);

      const relayByReceiver = await request(server)
        .post('/api/v1/relay')
        .set(bearer(tokenB))
        .send({
          pair_id: pairId,
          message_id: 'e2e_msg_002',
          encrypted_payload: 'e2e_encrypted_payload_bytes==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: nowSeconds()
        });
      expect(relayByReceiver.status).toBe(403);

      const revoke = await request(server).delete(`/api/v1/pair/${pairId}`).set(bearer(tokenA));
      expect(revoke.status).toBe(200);

      const statusRevoked = await request(server)
        .get(`/api/v1/pair/status/${pairId}`)
        .set(bearer(tokenA));
      expect(statusRevoked.status).toBe(404);
    });
  });

  describe('Paired Devices & Active Toggle Management', () => {
    it('should list paired receivers for sender and allow sender to toggle is_active', async () => {
      const { a, b, pairId } = await createPairedPair('pair_toggle_mgmt_01');

      // 1. Sender lists paired receivers
      const listReceivers1 = await request(server)
        .get('/api/v1/pair/receivers')
        .set(bearer(a.token));
      expect(listReceivers1.status).toBe(200);
      expect(listReceivers1.body.receivers).toHaveLength(1);
      expect(listReceivers1.body.receivers[0].pair_id).toBe(pairId);
      expect(listReceivers1.body.receivers[0].receiver_device_id).toBe(b.deviceId);
      expect(listReceivers1.body.receivers[0].is_active).toBe(true);

      // 2. Receiver lists paired senders (read-only view)
      const listSenders1 = await request(server)
        .get('/api/v1/pair/senders')
        .set(bearer(b.token));
      expect(listSenders1.status).toBe(200);
      expect(listSenders1.body.senders).toHaveLength(1);
      expect(listSenders1.body.senders[0].pair_id).toBe(pairId);
      expect(listSenders1.body.senders[0].sender_device_id).toBe(a.deviceId);
      expect(listSenders1.body.senders[0].is_active).toBe(true);

      // 3. Sender toggles is_active to false (paused)
      const toggleRes = await request(server)
        .patch(`/api/v1/pair/${pairId}/toggle`)
        .set(bearer(a.token))
        .send({ is_active: false });
      expect(toggleRes.status).toBe(200);
      expect(toggleRes.body.success).toBe(true);
      expect(toggleRes.body.is_active).toBe(false);

      // 4. Relay attempt when paused should return 403 RELAY_PAUSED_BY_SENDER
      const relayPaused = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({
          pair_id: pairId,
          message_id: 'msg_paused_01',
          encrypted_payload: 'paused_payload==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: nowSeconds()
        });
      expect(relayPaused.status).toBe(403);
      expect(relayPaused.body.error).toBe('RELAY_PAUSED_BY_SENDER');

      // 5. Receiver checks list, should see is_active = false
      const listSenders2 = await request(server)
        .get('/api/v1/pair/senders')
        .set(bearer(b.token));
      expect(listSenders2.status).toBe(200);
      expect(listSenders2.body.senders[0].is_active).toBe(false);

      // 6. Receiver tries to toggle -> should fail with 403 FORBIDDEN
      const receiverToggle = await request(server)
        .patch(`/api/v1/pair/${pairId}/toggle`)
        .set(bearer(b.token))
        .send({ is_active: true });
      expect(receiverToggle.status).toBe(403);
      expect(receiverToggle.body.error).toBe('FORBIDDEN');

      // 7. Sender re-enables is_active -> relay should work again
      await request(server)
        .patch(`/api/v1/pair/${pairId}/toggle`)
        .set(bearer(a.token))
        .send({ is_active: true });

      const relayResumed = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({
          pair_id: pairId,
          message_id: 'msg_resumed_01',
          encrypted_payload: 'resumed_payload==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: nowSeconds()
        });
      expect(relayResumed.status).toBe(200);
      expect(relayResumed.body.success).toBe(true);
    });
  });
});

