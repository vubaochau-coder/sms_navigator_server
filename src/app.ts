import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { apiV1Routes } from './routes/api.routes.js';
import { apiV2Routes } from './routes/v2.routes.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { logger } from './utils/logger.js';

export function createApp(): express.Application {
  const app = express();

  // Trust reverse proxy headers from Render/Cloudflare for rate limiter and client IP
  app.set('trust proxy', 1);

  // HTTP request logger with status and duration
  app.use((req: Request, res: Response, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const deviceStr = req.device?.device_id ? ` [device: ${req.device.device_id.slice(0, 8)}]` : '';
      const logMessage = `[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms${deviceStr}`;

      if (res.statusCode >= 500) {
        logger.error(logMessage);
      } else if (res.statusCode >= 400) {
        logger.warn(logMessage);
      } else {
        logger.info(logMessage);
      }
    });
    next();
  });

  // Basic security and parsing
  app.use(helmet());
  // CORS whitelist (GĐ4.3): CORS_ORIGIN rỗng (mặc định) = chặn mọi
  // cross-origin request; '*' = mở cho mọi origin; 'a.com,b.com' = whitelist.
  // Request không mang Origin header (app mobile, curl) không bị ảnh hưởng.
  app.use(
    cors({
      origin: parseCorsOrigins(env.CORS_ORIGIN),
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // API v1 routes (legacy, kept until v2 migration completes)
  app.use('/api/v1', apiV1Routes);

  // API v2 routes (Channel 1-to-N E2EE architecture)
  app.use('/api/v2', apiV2Routes);

  // 404 Handler
  app.use((req: Request, res: Response) => {
    logger.warn(`[404 Not Found] ${req.method} ${req.originalUrl}`, { ip: req.ip });
    res.status(404).json({
      success: false,
      error: 'NOT_FOUND',
      message: `Endpoint ${req.method} ${req.originalUrl} not found`
    });
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

/** Parse CORS_ORIGIN env: '' → [] (chặn cross-origin), '*' → mọi origin, 'a,b' → whitelist. */
function parseCorsOrigins(raw: string): string[] | boolean {
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) return false;
  if (origins.includes('*')) return true;
  return origins;
}
