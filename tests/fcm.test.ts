/// <reference types="jest" />

import { deviceService } from '../src/services/device.service.js';
import { FcmService, isDeadTokenError } from '../src/services/fcm.service.js';
import type { FcmTransport } from '../src/services/fcm.service.js';

const fcmError = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

describe('FcmService dead-token cleanup (BACKLOG §2)', () => {
  beforeEach(async () => {
    await deviceService.clearAll();
  });

  it('classifies only permanent token errors as dead', () => {
    expect(isDeadTokenError(fcmError('messaging/registration-token-not-registered'))).toBe(true);
    expect(isDeadTokenError(fcmError('messaging/invalid-registration-token'))).toBe(true);
    expect(isDeadTokenError(fcmError('messaging/internal-error'))).toBe(false);
    expect(isDeadTokenError(fcmError('messaging/quota-exceeded'))).toBe(false);
    expect(isDeadTokenError(new Error('network down'))).toBe(false);
    expect(isDeadTokenError(null)).toBe(false);
  });

  it('returns the message id and keeps the token on success', async () => {
    const { device } = await deviceService.registerDevice({ device_name: 'A', fcm_token: 'live-token' });
    const service = new FcmService(async () => 'msg-1');

    await expect(service.sendDataNotification('live-token', { type: 'X' })).resolves.toBe('msg-1');
    expect((await deviceService.findByDeviceId(device.device_id))?.fcm_token).toBe('live-token');
  });

  it('clears the token on every device holding it when FCM reports it unregistered', async () => {
    const { device: a } = await deviceService.registerDevice({ device_name: 'A', fcm_token: 'dead-token' });
    const { device: b } = await deviceService.registerDevice({ device_name: 'B', fcm_token: 'other-token' });
    const transport: FcmTransport = async () => {
      throw fcmError('messaging/registration-token-not-registered');
    };

    await expect(new FcmService(transport).sendDataNotification('dead-token', { type: 'X' })).resolves.toBe('');

    const clearedA = await deviceService.findByDeviceId(a.device_id);
    expect(clearedA?.fcm_token).toBeUndefined();
    // The rest of the record survives the rewrite
    expect(clearedA?.device_name).toBe('A');
    expect(clearedA?.token_hash).toBe(a.token_hash);
    expect((await deviceService.findByDeviceId(b.device_id))?.fcm_token).toBe('other-token');
  });

  it('keeps the token on transient errors', async () => {
    const { device } = await deviceService.registerDevice({ device_name: 'A', fcm_token: 'flaky-token' });
    const transport: FcmTransport = async () => {
      throw fcmError('messaging/internal-error');
    };

    await expect(new FcmService(transport).sendDataNotification('flaky-token', { type: 'X' })).resolves.toBe('');
    expect((await deviceService.findByDeviceId(device.device_id))?.fcm_token).toBe('flaky-token');
  });

  it('does not clear a fresh token uploaded after the dead one', async () => {
    const { device } = await deviceService.registerDevice({ device_name: 'A', fcm_token: 'old-token' });
    await deviceService.updateFcmToken(device.device_id, 'new-token');

    await expect(deviceService.clearFcmToken('old-token')).resolves.toBe(0);
    expect((await deviceService.findByDeviceId(device.device_id))?.fcm_token).toBe('new-token');
  });
});
