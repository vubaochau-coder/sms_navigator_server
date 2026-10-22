/// <reference types="jest" />

import type { Server } from 'http';
import { createApp } from '../src/app.js';
import { mockFirestore } from '../src/config/firestore-mock.js';
import { bearer, v2Client } from './helpers/v2-client.js';

describe('PUT /api/v2/channels/name (§4.8, BACKLOG 2.1)', () => {
  let server: Server;
  const c = v2Client(() => server);

  beforeAll((done) => {
    server = createApp().listen(0, done);
  });
  afterAll((done) => {
    server.close(done);
  });
  beforeEach(() => mockFirestore.reset());

  const rename = (token: string, body: Record<string, unknown>) =>
    c.api().put('/api/v2/channels/name').set(bearer(token)).send(body);

  it('owner renames; detail, list and members all see the new name, epoch untouched', async () => {
    const owner = await c.reg('Owner');
    const member = await c.reg('Member');
    const channelId = await c.createChannel(owner, 'Kênh cũ');
    const epoch = await c.join(owner, channelId, member);

    const res = await rename(owner.token, { channel_id: channelId, name: '  Kênh VCB  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, channel_id: channelId, name: 'Kênh VCB' });

    const detail = await c.detail(member, channelId);
    expect(detail.body.channel.name).toBe('Kênh VCB');
    expect(detail.body.channel.current_epoch).toBe(epoch);

    const list = await c.api().get('/api/v2/channels').set(bearer(member.token));
    expect(list.body.channels.map((ch: any) => ch.name)).toEqual(['Kênh VCB']);
  });

  it('403 NOT_OWNER for a member, 404 for an unknown channel', async () => {
    const owner = await c.reg('Owner');
    const member = await c.reg('Member');
    const channelId = await c.createChannel(owner);
    await c.join(owner, channelId, member);

    const forbidden = await rename(member.token, { channel_id: channelId, name: 'Hack' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('NOT_OWNER');

    const missing = await rename(owner.token, { channel_id: 'nope', name: 'X' });
    expect(missing.status).toBe(404);
  });

  it('400 for an empty / whitespace / >100 char name; 401 without token', async () => {
    const owner = await c.reg('Owner');
    const channelId = await c.createChannel(owner);

    for (const name of ['', '   ', 'x'.repeat(101)]) {
      const res = await rename(owner.token, { channel_id: channelId, name });
      expect(res.status).toBe(400);
    }
    const ok = await rename(owner.token, { channel_id: channelId, name: 'x'.repeat(100) });
    expect(ok.status).toBe(200);

    const noAuth = await c.api().put('/api/v2/channels/name').send({ channel_id: channelId, name: 'X' });
    expect(noAuth.status).toBe(401);
  });
});
