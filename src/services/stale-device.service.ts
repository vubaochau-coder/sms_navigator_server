import { getFirestoreDb } from '../config/firebase.js';
import { CHANNEL_MEMBERS_COLLECTION, CHANNELS_COLLECTION, DEVICES_COLLECTION } from './collections.js';

export interface StaleDeviceReport {
  device_id: string;
  device_name: string;
  last_seen_at: string;
  /** ACTIVE memberships — what an operator would have to decide about. */
  active_channels: Array<{ channel_id: string; channel_name: string; is_owner: boolean }>;
}

/**
 * BACKLOG §1 (device lifecycle after uninstall) — **report only**. A device is
 * "stale" when it has not been seen for `days` AND holds no FCM token (cleared
 * when FCM reported it unregistered, i.e. most likely uninstalled). Nothing is
 * revoked or deleted: whether to revoke memberships is a business decision,
 * and a device restored from a backup comes back with the same device_id.
 */
export class StaleDeviceService {
  public async findStaleDevices(days: number, now: Date = new Date()): Promise<StaleDeviceReport[]> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const snapshot = await db.collection(DEVICES_COLLECTION).where('last_seen_at', '<', cutoff).get();
    const stale = snapshot.docs
      .map((doc) => ({ id: doc.id, data: doc.data() ?? {} }))
      .filter(({ data }) => !data.fcm_token);

    const reports: StaleDeviceReport[] = [];
    for (const { id, data } of stale) {
      const memberships = await db
        .collection(CHANNEL_MEMBERS_COLLECTION)
        .where('device_id', '==', id)
        .where('status', '==', 'ACTIVE')
        .get();
      const channels = await Promise.all(
        memberships.docs.map(async (doc) => {
          const channelId = String(doc.data()?.channel_id ?? '');
          const channel = (await db.collection(CHANNELS_COLLECTION).doc(channelId).get()).data() ?? {};
          return {
            channel_id: channelId,
            channel_name: String(channel.name ?? ''),
            is_owner: channel.owner_device_id === id
          };
        })
      );
      reports.push({
        device_id: id,
        device_name: String(data.device_name ?? ''),
        last_seen_at: String(data.last_seen_at ?? ''),
        active_channels: channels
      });
    }
    return reports.sort((a, b) => a.last_seen_at.localeCompare(b.last_seen_at));
  }
}

export const staleDeviceService = new StaleDeviceService();
