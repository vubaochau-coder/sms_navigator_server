import { Request, Response } from 'express';
import { isFirebaseReady } from '../config/firebase.js';
import { nowIso } from '../utils/time.js';

export class HealthController {
  public static async check(_req: Request, res: Response): Promise<void> {
    res.status(200).json({
      status: 'healthy',
      timestamp: nowIso(),
      uptime: process.uptime(),
      firebaseConnected: isFirebaseReady()
    });
  }
}
