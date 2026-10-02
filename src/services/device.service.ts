import { createHash, randomBytes, randomUUID } from 'crypto';
import { DeviceEntity } from '../types/index.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso, toIsoString } from '../utils/time.js';

export const DEVICES_COLLECTION = 'devices';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface DeviceRegisterInput {
  device_id?: string;
  public_key?: string;
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
  if (device.public_key !== undefined) doc.public_key = device.public_key;
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
    public_key: data.public_key as string | undefined,
    device_name: data.device_name as string | undefined,
    platform: data.platform as string | undefined,
    fcm_token: data.fcm_token as string | undefined,
    created_at: toIsoString(data.created_at),
    last_active_at: toIsoString(data.last_active_at)
  };
}

export class DeviceService {
  public async registerDevice(input: DeviceRegisterInput): Promise<{ device: DeviceEntity; token: string }> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const now = nowIso();
    const deviceId = input.device_id?.trim() || randomUUID();

    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    // Re-registration invalidates the previously issued token: the doc is
    // overwritten with the new token_hash, so the old hash stops matching.
    const existing = await this.findByDeviceId(deviceId);

    const device: DeviceEntity = {
      device_id: deviceId,
      token_hash: tokenHash,
      public_key: input.public_key ?? existing?.public_key,
      device_name: input.device_name ?? existing?.device_name,
      platform: input.platform ?? existing?.platform,
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

  /** v2 register idempotency: re-calling with the same public_key reuses the device. */
  public async findByPublicKey(publicKey: string): Promise<DeviceEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const snapshot = await db
      .collection(DEVICES_COLLECTION)
      .where('public_key', '==', publicKey)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return fromDocument(doc.id, doc.data());
  }

  public async updateFcmToken(deviceId: string, fcmToken: string): Promise<DeviceEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const docRef = db.collection(DEVICES_COLLECTION).doc(deviceId);
    const snapshot = await docRef.get();
    if (!snapshot.exists) return null;

    const now = nowIso();
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
        .update({ last_active_at: nowIso() });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[DeviceService] Failed to touch device ${deviceId}:`, error);
    }
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const snapshot = await db.collection(DEVICES_COLLECTION).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
}

export const deviceService = new DeviceService();
