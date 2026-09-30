import { Request, Response, NextFunction } from 'express';
import { deviceService, sha256Hex } from '../services/device.service.js';

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or malformed Authorization header. Expected format: Bearer <token>'
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const tokenHash = sha256Hex(token);
  const device = await deviceService.findByTokenHash(tokenHash);

  if (!device) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Invalid or unknown device token'
    });
    return;
  }

  req.device = device;
  void deviceService.touchDevice(device.device_id);
  next();
}
