/// <reference types="jest" />

import type { Server } from 'http';
import { createApp } from '../src/app.js';
import { mockFirestore } from '../src/config/firestore-mock.js';
import { bearer, v2Client, type DeviceCtx } from './helpers/v2-client.js';

describe('GET /api/v2/channels/requests?status=HISTORY (§5.3, BACKLOG 2.3)', () => {
  let server: Server;
  const c = v2Client(() => server);

  beforeAll((done) => {
    server = createApp().listen(0, done);
  });
  afterAll((done) => {
    server.close(done);
  });
  beforeEach(() => mockFirestore.reset());

  // decided_at has ms resolution: keep decisions strictly ordered
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const list = (owner: DeviceCtx, channelId: string, query: string) =>
    c.api().get(`/api/v2/channels/requests?channel_id=${channelId}&${query}`).set(bearer(owner.token));

  /** One request in each state: approved (A), rejected (R), cancelled (C), still pending (P). */
  const seed = async () => {
    const owner = await c.reg('Owner');
    const channelId = await c.createChannel(owner);
    const [a, r, cx, p] = [await c.reg('A'), await c.reg('R'), await c.reg('C'), await c.reg('P')];

    await c.join(owner, channelId, a);
    await tick();
    const rId = await c.claim(owner, channelId, r);
    await c.api().post('/api/v2/pairing/requests/reject').set(bearer(owner.token)).send({ request_id: rId });
    await tick();
    const cId = await c.claim(owner, channelId, cx);
    await c.api().post('/api/v2/pairing/requests/cancel').set(bearer(cx.token)).send({ request_id: cId });
    await tick();
    await c.claim(owner, channelId, p);
    return { owner, channelId, a };
  };

  it('returns every processed request, newest decision first, never the pending one', async () => {
    const { owner, channelId } = await seed();

    const res = await list(owner, channelId, 'status=HISTORY');
    expect(res.status).toBe(200);
    expect(res.body.requests.map((r: any) => [r.requester_device_name, r.status])).toEqual([
      ['C', 'CANCELLED'],
      ['R', 'REJECTED'],
      ['A', 'APPROVED']
    ]);
    expect(res.body.requests.every((r: any) => typeof r.decided_at === 'string')).toBe(true);
    expect(res.body.next_before).toBeNull();
  });

  it('pages with limit + next_before', async () => {
    const { owner, channelId } = await seed();

    const first = await list(owner, channelId, 'status=HISTORY&limit=2');
    expect(first.body.requests.map((r: any) => r.requester_device_name)).toEqual(['C', 'R']);
    expect(first.body.next_before).toEqual(expect.any(String));

    const second = await list(owner, channelId, `status=HISTORY&limit=2&before=${encodeURIComponent(first.body.next_before)}`);
    expect(second.body.requests.map((r: any) => r.requester_device_name)).toEqual(['A']);
    expect(second.body.next_before).toBeNull();
  });

  it('the approval queue (default PENDING) still works and now carries status', async () => {
    const { owner, channelId } = await seed();

    const res = await list(owner, channelId, '');
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({ requester_device_name: 'P', status: 'PENDING' });
    expect(res.body.requests[0].requester_public_key).toBeTruthy();
  });

  it('403 for a member, 400 for a bad status / limit / cursor', async () => {
    const { owner, channelId, a } = await seed();

    expect((await list(a, channelId, 'status=HISTORY')).status).toBe(403);
    for (const query of ['status=DONE', 'status=HISTORY&limit=0', 'status=HISTORY&limit=101', 'status=HISTORY&before=yesterday']) {
      expect((await list(owner, channelId, query)).status).toBe(400);
    }
  });
});
