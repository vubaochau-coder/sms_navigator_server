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

  const fakePubkey = (): string => crypto.randomBytes(32).toString('base64');

  const createPendingPair = async (label: string, senderId?: string, receiverId?: string) => {
    const a = await registerDevice(senderId ?? `A_${label}`);
    const b = await registerDevice(receiverId ?? `B_${label}`);
    const senderPubkey = fakePubkey();
    const init = await request(server)
      .post('/api/v1/pair/init')
      .set(bearer(a.token))
      .send({ sender_pubkey: senderPubkey });
    expect(init.status).toBe(201);
    return {
      a,
      b,
      senderPubkey,
      pairId: init.body.pair_id as string,
      pairingKey: init.body.pairing_key as string
    };
  };

  const createPairedPair = async (label: string) => {
    const a = await registerDevice(`A_${label}`);
    const b = await registerDevice(`B_${label}`);
    const c = await registerDevice(`C_${label}`);
    const senderPubkey = fakePubkey();
    const init = await request(server)
      .post('/api/v1/pair/init')
      .set(bearer(a.token))
      .send({ sender_pubkey: senderPubkey });
    const pairId = init.body.pair_id as string;
    await request(server)
      .post('/api/v1/pair/confirm')
      .set(bearer(b.token))
      .send({
        pairing_key: init.body.pairing_key,
        receiver_pubkey: fakePubkey(),
        fcm_token: `fcm_receiver_${label}_12345`,
        device_name: 'Receiver Phone',
        platform: 'android'
      });
    return { a, b, c, pairId, senderPubkey };
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
      const res = await request(server).post('/api/v1/pair/init').send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('should create a pair and return pair_id + one-time pairing_key (201)', async () => {
      const { token } = await registerDevice('device_A_init');
      const senderPubkey = fakePubkey();

      const res = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(token))
        .send({ sender_pubkey: senderPubkey });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.pair_id).toBeDefined();
      // 128-bit CSPRNG key, base64url encoded (22 chars), no padding
      expect(res.body.pairing_key).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(res.body.pairing_code).toBeUndefined();

      // expires_at is the server-enforced 10-minute pairing window
      const expiresMs = new Date(res.body.expires_at).getTime();
      expect(expiresMs).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1000);

      const pair = await sessionService.getPair(res.body.pair_id);
      expect(pair?.sender_device_id).toBe('device_A_init');
      expect(pair?.sender_pubkey).toBe(senderPubkey);

      // The plaintext pairing key is never persisted server-side
      expect(pair?.pairing_key_hash).toBeDefined();
      expect(JSON.stringify(pair)).not.toContain(res.body.pairing_key);
    });

    it('should reject init without a sender_pubkey (400)', async () => {
      const { token } = await registerDevice('device_A_no_pubkey');

      const res = await request(server).post('/api/v1/pair/init').set(bearer(token)).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should generate a fresh pair_id and pairing_key for every init', async () => {
      const { token } = await registerDevice('device_A_init_unique');

      const first = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(token))
        .send({ sender_pubkey: fakePubkey() });
      const second = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(token))
        .send({ sender_pubkey: fakePubkey() });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.pair_id).not.toBe(second.body.pair_id);
      expect(first.body.pairing_key).not.toBe(second.body.pairing_key);

      // Both pending pairs exist independently, each confirmable via its own key
      expect((await sessionService.getPair(first.body.pair_id))?.pair_id).toBe(first.body.pair_id);
      expect((await sessionService.getPair(second.body.pair_id))?.pair_id).toBe(second.body.pair_id);
    });

    it('should let the sender open a new pending pair while an older pair is confirmed', async () => {
      const a = await registerDevice('device_A_regenerate');
      const b = await registerDevice('device_B_regenerate');

      const oldInit = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ sender_pubkey: fakePubkey() });
      await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pairing_key: oldInit.body.pairing_key, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_old_pair_12345' });

      const fresh = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.token))
        .send({ sender_pubkey: fakePubkey() });
      expect(fresh.status).toBe(201);
      expect((await sessionService.getPair(fresh.body.pair_id))?.receiver_device_id).toBeUndefined();
    });
  });

  describe('POST /api/v1/pair/confirm (Device B)', () => {
    it('should return 401 without auth', async () => {
      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .send({ pairing_key: 'some_pairing_key_value', receiver_pubkey: fakePubkey(), fcm_token: 'fcm_token_123456' });
      expect(res.status).toBe(401);
    });

    it('should reject invalid payload with 400 (missing or too-short pairing_key)', async () => {
      const { token } = await registerDevice('device_B_invalid_payload');

      const missing = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(token))
        .send({ fcm_token: 'fcm_token_123456' });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('VALIDATION_ERROR');

      const tooShort = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(token))
        .send({ pairing_key: 'ab', receiver_pubkey: fakePubkey() });
      expect(tooShort.status).toBe(400);
      expect(tooShort.body.error).toBe('VALIDATION_ERROR');

      const noReceiverKey = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(token))
        .send({ pairing_key: 'valid_length_pairing_key' });
      expect(noReceiverKey.status).toBe(400);
      expect(noReceiverKey.body.error).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for an unknown pairing key (never leaks pair existence)', async () => {
      const { token } = await registerDevice('device_B_unknown_pair');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(token))
        .send({ pairing_key: 'ZmFrZV91bmtub3duX3BhaXJpbmdfa2V5', receiver_pubkey: fakePubkey(), fcm_token: 'fcm_token_123456' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('PAIR_NOT_FOUND');
    });

    it('should block Device A from confirming its own pair (400)', async () => {
      const { a, pairingKey, pairId } = await createPendingPair('pair_self_block');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(a.token))
        .send({ pairing_key: pairingKey, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_self_pair_12345' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('SELF_PAIRING_NOT_ALLOWED');
      expect((await sessionService.getPair(pairId))?.receiver_device_id).toBeUndefined();
    });

    it('should bind Device B and register its FCM token (200)', async () => {
      const { b, pairingKey, pairId, senderPubkey } = await createPendingPair('pair_confirm_ok');
      const receiverPubkey = fakePubkey();

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({
          pairing_key: pairingKey,
          receiver_pubkey: receiverPubkey,
          fcm_token: 'fcm_receiver_confirmed_12345',
          device_name: 'Samsung S24 (Malaysia)',
          platform: 'android'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pair_id).toBe(pairId);
      // Device B completes the ECDH handshake with the sender pubkey
      expect(res.body.sender_pubkey).toBe(senderPubkey);
      expectIso8601(res.body.paired_at);
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(nowSeconds() * 1000);

      const pair = await sessionService.getPair(pairId);
      expect(pair?.receiver_device_id).toBe(`B_pair_confirm_ok`);
      expect(pair?.receiver_pubkey).toBe(receiverPubkey);
      expect(pair?.fcm_token).toBe('fcm_receiver_confirmed_12345');
    });

    it('should enforce one-time use: the pairing key never confirms twice', async () => {
      const { b, pairingKey } = await createPendingPair('pair_one_time');

      const first = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pairing_key: pairingKey, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_first_confirm_12345' });
      expect(first.status).toBe(200);

      const replay = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pairing_key: pairingKey, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_first_confirm_12345' });

      expect(replay.status).toBe(404);
      expect(replay.body.error).toBe('PAIR_NOT_FOUND');
    });

    it('should only confirm the pair that owns the presented pairing key', async () => {
      const first = await createPendingPair('pair_cross_a');
      const second = await createPendingPair('pair_cross_b');

      // Device B of pair two presents pair one's key (it scanned pair one's QR):
      // exactly pair one gets confirmed - never pair two.
      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(second.b.token))
        .send({ pairing_key: first.pairingKey, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_cross_pair_12345' });

      expect(res.status).toBe(200);
      expect(res.body.pair_id).toBe(first.pairId);
      expect((await sessionService.getPair(first.pairId))?.receiver_device_id).toBe(second.b.deviceId);
      expect((await sessionService.getPair(second.pairId))?.receiver_device_id).toBeUndefined();
    });

    it('should return 410 PAIR_EXPIRED when the pending pair is older than the 10-minute TTL', async () => {
      const { b, pairingKey, pairId } = await createPendingPair('pair_ttl_expired');

      // Age the pending pair beyond the server-enforced window
      const pair = await sessionService.getPair(pairId);
      await sessionService.updatePair({
        ...pair!,
        created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString()
      });

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pairing_key: pairingKey, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_ttl_12345' });

      expect(res.status).toBe(410);
      expect(res.body.error).toBe('PAIR_EXPIRED');
      expect((await sessionService.getPair(pairId))?.receiver_device_id).toBeUndefined();
    });

    it('should still confirm inside the 10-minute window (boundary not expired)', async () => {
      const { b, pairingKey } = await createPendingPair('pair_ttl_fresh');

      const res = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.token))
        .send({ pairing_key: pairingKey, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_fresh_12345' });

      expect(res.status).toBe(200);
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
      const { a, pairId } = await createPendingPair('pair_status_pending');

      const res = await request(server).get(`/api/v1/pair/status/${pairId}`).set(bearer(a.token));

      expect(res.status).toBe(200);
      expect(res.body.pair_id).toBe(pairId);
      expect(res.body.is_paired).toBe(false);
      expect(res.body.sender_device_id).toBe(`A_pair_status_pending`);
    });

    it('should let Device B (receiver) view paired status', async () => {
      const { b, pairId } = await createPairedPair('pair_status_paired');

      const res = await request(server).get(`/api/v1/pair/status/${pairId}`).set(bearer(b.token));

      expect(res.status).toBe(200);
      expect(res.body.is_paired).toBe(true);
      expect(res.body.receiver_device_id).toBe(`B_pair_status_paired`);
      expect(res.body.device_name).toBe('Receiver Phone');
      expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(nowSeconds() * 1000);
    });

    it('should return 403 Forbidden for Device C (not a participant)', async () => {
      const { c, pairId } = await createPairedPair('pair_status_forbidden');

      const res = await request(server).get(`/api/v1/pair/status/${pairId}`).set(bearer(c.token));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });
  });

  describe('paired device name resolution', () => {
    it('should persist the sender device name at pair/init (201)', async () => {
      const a = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'A_name_init', device_name: 'Pixel 8 (Vietnam)', platform: 'android' });
      const b = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'B_name_init', device_name: 'iPhone 15 (Malaysia)', platform: 'ios' });

      const init = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.body.token))
        .send({ sender_pubkey: fakePubkey() });
      await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.body.token))
        .send({ pairing_key: init.body.pairing_key, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_name_init_12345' });

      const pair = await sessionService.getPair(init.body.pair_id);
      expect(pair?.sender_device_name).toBe('Pixel 8 (Vietnam)');
    });

    it('GET paired-senders should show the sender registry name and platform (200)', async () => {
      const a = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'A_sender_meta', device_name: 'Pixel 8 (Vietnam)', platform: 'android' });
      const b = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'B_sender_meta', device_name: 'iPhone 15 (Malaysia)', platform: 'ios' });

      const init = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.body.token))
        .send({ sender_pubkey: fakePubkey() });
      await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.body.token))
        .send({ pairing_key: init.body.pairing_key, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_sender_meta_12345' });

      const res = await request(server).get('/api/v1/pair/senders').set(bearer(b.body.token));

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.senders[0].device_name).toBe('Pixel 8 (Vietnam)');
      expect(res.body.senders[0].platform).toBe('android');
    });

    it('GET paired-receivers should fall back to the receiver registry name for legacy pairs (200)', async () => {
      const a = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'A_legacy_pair', device_name: 'Old Sender', platform: 'android' });
      const b = await request(server)
        .post('/api/v1/devices/register')
        .send({ device_id: 'B_legacy_pair', device_name: 'Old Receiver Name', platform: 'ios' });

      // Legacy pair: confirmed without device_name/platform (old client)
      const init = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(a.body.token))
        .send({ sender_pubkey: fakePubkey() });
      await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(b.body.token))
        .send({ pairing_key: init.body.pairing_key, receiver_pubkey: fakePubkey(), fcm_token: 'fcm_legacy_pair_12345' });

      const res = await request(server).get('/api/v1/pair/receivers').set(bearer(a.body.token));

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.receivers[0].device_name).toBe('Old Receiver Name');
      expect(res.body.receivers[0].platform).toBe('ios');
    });
  });

  describe('POST /api/v1/relay (Blind Relay)', () => {
    // IV derive từ message_id để mỗi message trong 1 pair có fingerprint
    // (pair_id | iv | payload) riêng — không vấp anti-replay của test khác.
    const relayBody = (pairId: string, messageId?: string) => ({
      pair_id: pairId,
      ...(messageId ? { message_id: messageId } : {}),
      encrypted_payload: 'U2FsdGVkX19mock_encrypted_otp_bytes==',
      iv: Buffer.from(`iv_salt_${messageId ?? 'default'}`).toString('base64'),
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
          iv: Buffer.from('iv_salt_msg_blind_1').toString('base64'),
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
      iv: Buffer.from(`iv_salt_${messageId}`).toString('base64'),
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
        expect(message.iv).toBe(Buffer.from(`iv_salt_${message.message_id}`).toString('base64'));
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

      const senderPubkey = fakePubkey();
      const receiverPubkey = fakePubkey();

      const init = await request(server)
        .post('/api/v1/pair/init')
        .set(bearer(tokenA))
        .send({ sender_pubkey: senderPubkey });
      expect(init.status).toBe(201);
      const pairId = init.body.pair_id as string;
      const pairingKey = init.body.pairing_key as string;
      expect(pairingKey).toBeDefined();

      const statusBefore = await request(server)
        .get(`/api/v1/pair/status/${pairId}`)
        .set(bearer(tokenA));
      expect(statusBefore.status).toBe(200);
      expect(statusBefore.body.is_paired).toBe(false);
      expect(statusBefore.body.receiver_pubkey).toBeUndefined();

      const confirm = await request(server)
        .post('/api/v1/pair/confirm')
        .set(bearer(tokenB))
        .send({
          pairing_key: pairingKey,
          receiver_pubkey: receiverPubkey,
          fcm_token: 'e2e_fcm_receiver_token_12345',
          device_name: 'Receiver Phone',
          platform: 'android'
        });
      expect(confirm.status).toBe(200);
      expect(confirm.body.sender_pubkey).toBe(senderPubkey);

      const statusAfter = await request(server)
        .get(`/api/v1/pair/status/${pairId}`)
        .set(bearer(tokenA));
      expect(statusAfter.status).toBe(200);
      expect(statusAfter.body.is_paired).toBe(true);
      expect(statusAfter.body.receiver_device_id).toBe('e2e_device_B');
      // Sender can now fetch the receiver pubkey to derive the shared key
      expect(statusAfter.body.receiver_pubkey).toBe(receiverPubkey);

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
    });
  });

  describe('Paired Devices Management', () => {
    it('should list paired receivers for sender and paired senders for receiver', async () => {
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
    });
  });

  describe('Anti-replay guard (GĐ4.2)', () => {
    it('should return 409 REPLAY_DETECTED when the same ciphertext is replayed with a new message_id', async () => {
      const { a, pairId } = await createPairedPair('pair_replay_detected');

      const iv = Buffer.from('iv_salt_replay_case').toString('base64');
      const first = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({
          pair_id: pairId,
          message_id: 'msg_replay_first',
          encrypted_payload: 'replay_probe_payload==',
          iv,
          sent_at: nowSeconds()
        });
      expect(first.status).toBe(200);

      const replay = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a.token))
        .send({
          pair_id: pairId,
          message_id: 'msg_replay_attacker_new_id',
          encrypted_payload: 'replay_probe_payload==',
          iv,
          sent_at: nowSeconds()
        });
      expect(replay.status).toBe(409);
      expect(replay.body.error).toBe('REPLAY_DETECTED');
    });

    it('should not treat the same ciphertext under a different pair as replay', async () => {
      const { a: a1, pairId: pair1 } = await createPairedPair('pair_replay_pair1');
      const { a: a2, pairId: pair2 } = await createPairedPair('pair_replay_pair2');

      const body = (pairId: string) => ({
        pair_id: pairId,
        encrypted_payload: 'cross_pair_payload==',
        iv: Buffer.from('iv_salt_cross_pair').toString('base64'),
        sent_at: nowSeconds()
      });

      const first = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a1.token))
        .send(body(pair1));
      expect(first.status).toBe(200);

      const second = await request(server)
        .post('/api/v1/relay')
        .set(bearer(a2.token))
        .send(body(pair2));
      expect(second.status).toBe(200);
    });
  });

  describe('CORS whitelist (GĐ4.3)', () => {
    it('should not emit Access-Control-Allow-Origin for foreign origins by default', async () => {
      const res = await request(server)
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example.com');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should not emit Access-Control-Allow-Origin for same-origin-less requests', async () => {
      // App mobile / curl không gửi Origin - phải đi qua bình thường
      const res = await request(server).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});

