/// <reference types="jest" />

import { mockFirestore } from '../src/config/firestore-mock.js';
import { DEVICES_COLLECTION, CHANNELS_COLLECTION, CHANNEL_MEMBERS_COLLECTION } from '../src/services/collections.js';
import { staleDeviceService } from '../src/services/stale-device.service.js';

describe('StaleDeviceService (BACKLOG §1, report only)', () => {
  const now = new Date('2026-10-22T00:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  beforeEach(async () => {
    mockFirestore.reset();
    const devices = mockFirestore.collection(DEVICES_COLLECTION);
    await devices.doc('gone').set({ device_id: 'gone', token_hash: 'h', device_name: 'Máy cũ', last_seen_at: daysAgo(90) });
    await devices.doc('old-but-reachable').set({ device_id: 'old-but-reachable', token_hash: 'h', fcm_token: 't', last_seen_at: daysAgo(90) });
    await devices.doc('recent').set({ device_id: 'recent', token_hash: 'h', last_seen_at: daysAgo(5) });
    await mockFirestore.collection(CHANNELS_COLLECTION).doc('ch').set({ name: 'Kênh nhà', owner_device_id: 'gone' });
    await mockFirestore
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .doc('ch__gone')
      .set({ channel_id: 'ch', device_id: 'gone', status: 'ACTIVE' });
  });

  it('lists only long-unseen devices without an FCM token, with their active channels', async () => {
    const reports = await staleDeviceService.findStaleDevices(60, now);
    expect(reports).toEqual([
      {
        device_id: 'gone',
        device_name: 'Máy cũ',
        last_seen_at: daysAgo(90),
        active_channels: [{ channel_id: 'ch', channel_name: 'Kênh nhà', is_owner: true }]
      }
    ]);
  });

  it('never writes anything', async () => {
    await staleDeviceService.findStaleDevices(60, now);
    const member = await mockFirestore.collection(CHANNEL_MEMBERS_COLLECTION).doc('ch__gone').get();
    expect(member.data()?.status).toBe('ACTIVE');
  });
});
