import request from 'supertest';
import { createApp } from '../src/app.js';
import { sessionService } from '../src/services/session.service.js';

describe('SMS Navigator Server Integration Tests', () => {
  const app = createApp();

  beforeEach(() => {
    sessionService.clearAll();
  });

  afterAll(() => {
    sessionService.destroy();
  });

  describe('GET /health & /api/v1/health', () => {
    it('should return healthy status at root /health', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.uptime).toBeDefined();
    });

    it('should return healthy status at /api/v1/health', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });
  });

  describe('POST /api/v1/pair/confirm', () => {
    it('should reject invalid payload with 400', async () => {
      const res = await request(app)
        .post('/api/v1/pair/confirm')
        .send({ pair_id: 'ab' }); // Too short and missing fcm_token

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('should register receiver device session with 200', async () => {
      const res = await request(app)
        .post('/api/v1/pair/confirm')
        .send({
          pair_id: 'pair_test_abc123',
          fcm_token: 'fake_valid_fcm_token_long_string_12345',
          device_name: 'Samsung S24 (Malaysia)',
          platform: 'android'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pair_id).toBe('pair_test_abc123');
      expect(res.body.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('GET /api/v1/pair/status/:pairId', () => {
    it('should return is_paired false when pairId is not registered', async () => {
      const res = await request(app).get('/api/v1/pair/status/pair_unknown');
      expect(res.status).toBe(200);
      expect(res.body.is_paired).toBe(false);
    });

    it('should return is_paired true when paired', async () => {
      const pairId = 'pair_active_999';
      sessionService.saveSession(pairId, 'fake_token_12345', 'Pixel 8', 'android');

      const res = await request(app).get(`/api/v1/pair/status/${pairId}`);
      expect(res.status).toBe(200);
      expect(res.body.is_paired).toBe(true);
      expect(res.body.device_name).toBe('Pixel 8');
    });
  });

  describe('POST /api/v1/relay and /api/v1/relay/otp', () => {
    const pairId = 'pair_relay_demo';
    const fakeToken = 'fake_fcm_token_for_relay_test_12345';

    beforeEach(() => {
      sessionService.saveSession(pairId, fakeToken, 'Test Device', 'android');
    });

    it('should return 404 RECEIVER_NOT_PAIRED if pair_id does not exist', async () => {
      const res = await request(app)
        .post('/api/v1/relay')
        .send({
          pair_id: 'pair_non_existent',
          encrypted_payload: 'encrypted_content_base64',
          iv: 'dGVzdF9pdg==',
          sent_at: Math.floor(Date.now() / 1000),
          ttl_seconds: 300
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('RECEIVER_NOT_PAIRED');
    });

    it('should return 400 PAYLOAD_EXPIRED if sent_at is too old', async () => {
      const now = Math.floor(Date.now() / 1000);
      const res = await request(app)
        .post('/api/v1/relay')
        .send({
          pair_id: pairId,
          encrypted_payload: 'encrypted_content_base64',
          iv: 'dGVzdF9pdg==',
          sent_at: now - 500, // 500 seconds ago, exceeds 300s TTL
          ttl_seconds: 300
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('PAYLOAD_EXPIRED');
    });

    it('should successfully relay OTP payload to paired receiver', async () => {
      const res = await request(app)
        .post('/api/v1/relay')
        .send({
          pair_id: pairId,
          device_id: 'sender_phone_viettel',
          encrypted_payload: 'U2FsdGVkX19mock_encrypted_otp_bytes==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: Math.floor(Date.now() / 1000),
          ttl_seconds: 300
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message_id).toBeDefined();
      expect(res.body.relayed_at).toBeDefined();
    });

    it('should also work on alias endpoint /api/v1/relay/otp', async () => {
      const res = await request(app)
        .post('/api/v1/relay/otp')
        .send({
          pair_id: pairId,
          encrypted_payload: 'U2FsdGVkX19mock_encrypted_otp_bytes==',
          iv: 'aXZfc2FsdF8xMmJ5dGVz',
          sent_at: Math.floor(Date.now() / 1000)
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message_id).toBeDefined();
    });
  });

  describe('DELETE /api/v1/pair/:pairId', () => {
    it('should revoke paired session', async () => {
      const pairId = 'pair_to_revoke';
      sessionService.saveSession(pairId, 'fcm_token_12345');

      const res = await request(app).delete(`/api/v1/pair/${pairId}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await request(app).get(`/api/v1/pair/status/${pairId}`);
      expect(check.body.is_paired).toBe(false);
    });
  });
});
