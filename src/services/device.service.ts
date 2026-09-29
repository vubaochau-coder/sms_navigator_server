import { createHash, randomBytes, randomUUID } from 'crypto';
import { DeviceEntity } from '../types/index.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface DeviceRegisterInput {
  device_id?: string;
  device_name?: string;
  platform?: string;
}

export class DeviceService {
  private devicesByTokenHash = new Map<string, DeviceEntity>();
  private devicesByDeviceId = new Map<string, DeviceEntity>();

  public registerDevice(input: DeviceRegisterInput): { device: DeviceEntity; token: string } {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);
    const deviceId = input.device_id?.trim() || randomUUID();

    const existing = this.devicesByDeviceId.get(deviceId);
    if (existing) {
      // Re-registration invalidates the previously issued token
      this.devicesByTokenHash.delete(existing.token_hash);
    }

    const device: DeviceEntity = {
      device_id: deviceId,
      token_hash: tokenHash,
      device_name: input.device_name,
      platform: input.platform,
      fcm_token: existing?.fcm_token,
      created_at: existing?.created_at ?? now,
      last_active_at: now
    };

    this.devicesByTokenHash.set(tokenHash, device);
    this.devicesByDeviceId.set(deviceId, device);

    return { device, token };
  }

  public findByTokenHash(tokenHash: string): DeviceEntity | null {
    return this.devicesByTokenHash.get(tokenHash) ?? null;
  }

  public findByDeviceId(deviceId: string): DeviceEntity | null {
    return this.devicesByDeviceId.get(deviceId) ?? null;
  }

  public updateFcmToken(deviceId: string, fcmToken: string): DeviceEntity | null {
    const device = this.devicesByDeviceId.get(deviceId);
    if (!device) return null;

    device.fcm_token = fcmToken;
    device.last_active_at = Math.floor(Date.now() / 1000);
    return device;
  }

  public count(): number {
    return this.devicesByDeviceId.size;
  }

  public clearAll(): void {
    this.devicesByTokenHash.clear();
    this.devicesByDeviceId.clear();
  }
}

export const deviceService = new DeviceService();
