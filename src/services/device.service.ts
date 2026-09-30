import { createHash, randomBytes, randomUUID } from 'crypto';
import { DeviceEntity } from '../types/index.js';
import { getFirestoreDb } from '../config/firebase.js';

export const DEVICES_COLLECTION = 'devices';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface DeviceRegisterInput {
  device_id?: string;
  device_name?: string;
  platform?: string;
}

function toDocument(device: DeviceEntity): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    device_id: device.device_id,
    token_hash: device.token_hash,
    created_at: device.created_at,
    last_active_at: device.last_active_at
  };
  if (device.device_name !== undefined) doc.device_name = device.device_name;
  if (device.platform !== undefined) doc.platform = device.platform;
  if (device.fcm_token !== undefined) doc.fcm_token = device.fcm_token;
  return doc;
}

function fromDocument(id: string, data: Record<string, unknown> | undefined): DeviceEntity | null {
  if (!data || typeof data.token_hash !== 'string') return null;
  return {
    device_id: typeof data.device_id === 'string' ? data.device_id : id,
    token_hash: data.token_hash,
    device_name: data.device_name as string | undefined,
    platform: data.platform as string | undefined,
    fcm_token: data.fcm_token as string | undefined,
    created_at: Number(data.created_at ?? 0),
    last_active_at: Number(data.last_active_at ?? 0)
  };
}

export class DeviceService {
  public async registerDevice(input: DeviceRegisterInput): Promise<{ device: DeviceEntity; token: string }> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);
    const deviceId = input.device_id?.trim() || randomUUID();

    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    // Re-registration invalidates the previously issued token: the doc is
    // overwritten with the new token_hash, so the old hash stops matching.
    const existing = await this.findByDeviceId(deviceId);

    const device: DeviceEntity = {
      device_id: deviceId,
      token_hash: tokenHash,
      device_name: input.device_name,
      platform: input.platform,
      fcm_token: existing?.fcm_token,
      created_at: existing?.created_at ?? now,
      last_active_at: now
    };

    await db.collection(DEVICES_COLLECTION).doc(deviceId).set(toDocument(device));

    return { device, token };
  }

  public async findByTokenHash(tokenHash: string): Promise<DeviceEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const snapshot = await db
      .collection(DEVICES_COLLECTION)
      .where('token_hash', '==', tokenHash)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return fromDocument(doc.id, doc.data());
  }

  public async findByDeviceId(deviceId: string): Promise<DeviceEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const doc = await db.collection(DEVICES_COLLECTION).doc(deviceId).get();
    if (!doc.exists) return null;
    return fromDocument(doc.id, doc.data());
  }

  public async updateFcmToken(deviceId: string, fcmToken: string): Promise<DeviceEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const docRef = db.collection(DEVICES_COLLECTION).doc(deviceId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) return null;

    const now = Math.floor(Date.now() / 1000);
    await docRef.update({ fcm_token: fcmToken, last_active_at: now });

    const device = fromDocument(deviceId, snapshot.data());
    if (device) {
      device.fcm_token = fcmToken;
      device.last_active_at = now;
    }
    return device;
  }

  public async touchDevice(deviceId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    try {
      await db
        .collection(DEVICES_COLLECTION)
        .doc(deviceId)
        .update({ last_active_at: Math.floor(Date.now() / 1000) });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[DeviceService] Failed to touch device ${deviceId}:`, error);
    }
  }

  public async count(): Promise<number> {
    const db = getFirestoreDb();
    if (!db) return 0;
    const snapshot = await db.collection(DEVICES_COLLECTION).get();
    return snapshot.size;
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const snapshot = await db.collection(DEVICES_COLLECTION).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
}

export const deviceService = new DeviceService();
