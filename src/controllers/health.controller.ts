import { Request, Response } from 'express';
import { isFirebaseReady } from '../config/firebase.js';
import { sessionService } from '../services/session.service.js';
import { nowIso } from '../utils/time.js';

export class HealthController {
  public static async check(req: Request, res: Response): Promise<void> {
    const activeSessions = await sessionService.count().catch(() => 0);

    res.status(200).json({
      status: 'healthy',
      timestamp: nowIso(),
      uptime: process.uptime(),
      firebaseConnected: isFirebaseReady(),
      activeSessions
    });
  }
}
