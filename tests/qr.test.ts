/// <reference types="jest" />

import request from 'supertest';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { createApp } from '../src/app.js';
import { mockFirestore } from '../src/config/firestore-mock.js';
import { getFirestoreDb } from '../src/config/firebase.js';
import { KEK_ALG } from '../src/types/v2.js';
import { QR_CODES_COLLECTION } from '../src/services/collections.js';
import { qrCodeDocId } from '../src/services/qr-code.service.js';

/** Universal Opaque QR — roadmap v3.3 §2.3 / §6.1. */
describe('Universal Opaque QR (roadmap v3.3)', () => {
  const app = createApp();
  let server: any;

  beforeAll((done) => {
    server = app.listen(0, done);
  });
  afterAll((done) => {
    if (server) server.close(done);
    else done();
  });
  beforeEach(() => {
    mockFirestore.reset();
  });

  interface Dev {
    deviceId: string;
    token: string;
    name: string;
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const reg = async (name: string): Promise<Dev> => {
    const res = await request(server)
      .post('/api/v2/devices/register')
      .send({
        device_id: randomUUID(),
        device_name: name,
        platform: 'android',
        public_key: crypto.randomBytes(32).toString('base64')
      });
    expect(res.status).toBe(201);
    return { deviceId: res.body.device_id, token: res.body.device_token, name };
  };

  const createChannel = async (owner: Dev, name = 'Kênh VCB OTP'): Promise<string> => {
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
              nonce: crypto.randomBytes(12).toString('base64'),
              kek_alg: KEK_ALG
            }
          ]
        }
      });
    expect(res.status).toBe(201);
    return res.body.channel_id;
  };

  const createSession = async (owner: Dev, channelId: string) => {
    const res = await request(server)
      .post('/api/v2/channels/sessions')
      .set(bearer(owner.token))
      .send({ channel_id: channelId });
    expect(res.status).toBe(201);
    return res.body as { session_id: string; code: string; qr_url: string; expires_at: string; pairing_token: string };
  };

  const resolve = (dev: Dev, code: string) =>
    request(server).get(`/api/v2/qr/resolve?code=${encodeURIComponent(code)}`).set(bearer(dev.token));

  const claim = (dev: Dev, body: Record<string, unknown>) =>
    request(server).post('/api/v2/pairing/requests').set(bearer(dev.token)).send({ device_name: dev.name, ...body });

  // ------------------------------------------------------------------ create
  it('createSession returns an opaque 22-char code and an HTTPS qr_url', async () => {
    const owner = await reg('Owner');
    const channelId = await createChannel(owner);
    const session = await createSession(owner, channelId);

    expect(session.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(session.qr_url).toMatch(new RegExp(`/qr/${session.code}$`));
    expect(session).not.toHaveProperty('pairing_token');
  });

  it('stores only sha256(code) — never the raw code', async () => {
    const owner = await reg('Owner');
    const { code, session_id } = await createSession(owner, await createChannel(owner));
    const db = getFirestoreDb()!;

    const byHash = await db.collection(QR_CODES_COLLECTION).doc(qrCodeDocId(code)).get();
    expect(byHash.exists).toBe(true);
    expect(byHash.data()).toMatchObject({ type: 'PAIRING', target_id: session_id, created_by: owner.deviceId });
    expect(JSON.stringify(byHash.data())).not.toContain(code);

    const byRaw = await db.collection(QR_CODES_COLLECTION).doc(code).get();
    expect(byRaw.exists).toBe(false);
  });

  // ----------------------------------------------------------------- resolve
  it('resolve returns a typed preview without session_id or pairing_token', async () => {
    const owner = await reg('Pixel 7 Pro');
    const member = await reg('Member');
    const channelId = await createChannel(owner, 'Kênh VCB OTP');
    const { code, expires_at } = await createSession(owner, channelId);

    const res = await resolve(member, code);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      type: 'PAIRING',
      version: 1,
      data: {
        channel_id: channelId,
        channel_name: 'Kênh VCB OTP',
        owner_device_name: 'Pixel 7 Pro',
        expires_at
      }
    });
    expect(JSON.stringify(res.body)).not.toMatch(/pairing_token|session_id/);
  });

  it('resolve requires device auth', async () => {
    const owner = await reg('Owner');
    const { code } = await createSession(owner, await createChannel(owner));
    const res = await request(server).get(`/api/v2/qr/resolve?code=${code}`);
    expect(res.status).toBe(401);
  });

  it('400 for a malformed code, 404 for an unknown one', async () => {
    const member = await reg('Member');
    const bad = await resolve(member, 'not-a-code');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('VALIDATION_ERROR');

    const unknown = await resolve(member, crypto.randomBytes(16).toString('base64url'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('NOT_FOUND');
  });

  it('410 QR_EXPIRED after the TTL', async () => {
    const owner = await reg('Owner');
    const member = await reg('Member');
    const { code } = await createSession(owner, await createChannel(owner));

    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'] });
    jest.setSystemTime(Date.now() + 11 * 60 * 1000);
    try {
      const res = await resolve(member, code);
      expect(res.status).toBe(410);
      expect(res.body.error).toBe('QR_EXPIRED');
    } finally {
      jest.useRealTimers();
    }
  });

  it('410 QR_EXPIRED when the owner replaced the invite with a new one', async () => {
    const owner = await reg('Owner');
    const member = await reg('Member');
    const channelId = await createChannel(owner);
    const first = await createSession(owner, channelId);
    await createSession(owner, channelId);

    const res = await resolve(member, first.code);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('QR_EXPIRED');
  });

  it('409 ALREADY_MEMBER when the owner scans their own code', async () => {
    const owner = await reg('Owner');
    const { code } = await createSession(owner, await createChannel(owner));
    const res = await resolve(owner, code);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ALREADY_MEMBER');
  });

  it('422 UNSUPPORTED_QR_TYPE for a pointer type this build does not know', async () => {
    const member = await reg('Member');
    const code = crypto.randomBytes(16).toString('base64url');
    await getFirestoreDb()!
      .collection(QR_CODES_COLLECTION)
      .doc(qrCodeDocId(code))
      .set({
        type: 'BACKUP',
        target_id: 'x',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        created_at: new Date().toISOString(),
        created_by: 'someone'
      });

    const res = await resolve(member, code);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('UNSUPPORTED_QR_TYPE');
    expect(res.body.type).toBe('BACKUP');
  });

  // ------------------------------------------------------------------- claim
  it('claim by code → 201 PENDING; the code is then single-use', async () => {
    const owner = await reg('Owner');
    const member = await reg('Member');
    const other = await reg('Other');
    const channelId = await createChannel(owner);
    const { code } = await createSession(owner, channelId);

    const claimed = await claim(member, { code });
    expect(claimed.status).toBe(201);
    expect(claimed.body).toMatchObject({ status: 'PENDING', channel_id: channelId });

    const again = await resolve(other, code);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('QR_ALREADY_USED');

    const reclaim = await claim(other, { code });
    expect(reclaim.status).toBe(409);
    expect(reclaim.body.error).toBe('QR_ALREADY_USED');
  });

  it('409 REQUEST_ALREADY_PENDING when the same device resolves a fresh code', async () => {
    const owner = await reg('Owner');
    const member = await reg('Member');
    const channelId = await createChannel(owner);
    const first = await createSession(owner, channelId);
    expect((await claim(member, { code: first.code })).status).toBe(201);

    const second = await createSession(owner, channelId);
    const res = await resolve(member, second.code);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('REQUEST_ALREADY_PENDING');
  });

  it('claim without a code → 400', async () => {
    const member = await reg('Member');
    const res = await claim(member, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('v4 is gone (roadmap phase 6): token claim → 400, /channels/sessions/resolve → 404', async () => {
    const owner = await reg('Owner');
    const member = await reg('Member');
    const session = await createSession(owner, await createChannel(owner));
    expect(session).not.toHaveProperty('pairing_token');

    const res = await claim(member, { session_id: session.session_id, pairing_token: 'a'.repeat(32) });
    expect(res.status).toBe(400);

    const resolve = await request(server)
      .post('/api/v2/channels/sessions/resolve')
      .set(bearer(member.token))
      .send({ session_id: session.session_id, pairing_token: 'a'.repeat(32) });
    expect(resolve.status).toBe(404);
  });

  // ---------------------------------------------------------- public routes
  it('serves assetlinks.json and apple-app-site-association as JSON', async () => {
    const android = await request(server).get('/.well-known/assetlinks.json');
    expect(android.status).toBe(200);
    expect(android.headers['content-type']).toMatch(/application\/json/);
    expect(Array.isArray(android.body)).toBe(true);

    const ios = await request(server).get('/.well-known/apple-app-site-association');
    expect(ios.status).toBe(200);
    expect(ios.headers['content-type']).toMatch(/application\/json/);
    expect(ios.body).toHaveProperty('applinks.details');
  });

  it('fallback page links to the app for a valid code', async () => {
    const owner = await reg('Owner');
    const { code } = await createSession(owner, await createChannel(owner));
    const res = await request(server).get(`/qr/${code}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(`smsnavigator://qr?code=${code}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('fallback page never reflects an invalid code', async () => {
    const payload = '<script>alert(1)</script>';
    const res = await request(server).get(`/qr/${encodeURIComponent(payload)}`);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('<script>');
    expect(res.text).not.toContain('smsnavigator://qr');
  });
});
