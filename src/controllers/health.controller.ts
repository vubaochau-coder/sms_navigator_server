import { Request, Response } from 'express';
import { isFirebaseReady } from '../config/firebase.js';
import { sessionService } from '../services/session.service.js';

export class HealthController {
  public static async check(req: Request, res: Response): Promise<void> {
    const activeSessions = await sessionService.count().catch(() => 0);

    res.status(200).json({
      status: 'healthy',
      timestamp: Math.floor(Date.now() / 1000),
      uptime: process.uptime(),
      firebaseConnected: isFirebaseReady(),
      activeSessions
    });
  }
}
