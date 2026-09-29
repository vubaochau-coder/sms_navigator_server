import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { apiV1Routes } from './routes/api.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { errorHandler } from './middlewares/error.middleware.js';

export function createApp(): express.Application {
  const app = express();

  // Basic security and parsing
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Root level health check for load balancers / cloud probes
  app.use('/health', healthRoutes);

  // API v1 routes
  app.use('/api/v1', apiV1Routes);

  // 404 Handler
  app.use((req: Request, res: Response) => {
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
