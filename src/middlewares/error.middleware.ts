import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const statusCode = err.status || err.statusCode || 500;
  const errorCode = err.code || (statusCode >= 500 ? 'SERVER_ERROR' : 'REQUEST_ERROR');
  const message = err.message || 'Internal Server Error';

  const context: Record<string, unknown> = {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    deviceId: req.device?.device_id,
    statusCode,
    errorCode,
    query: Object.keys(req.query).length > 0 ? req.query : undefined
  };

  if (statusCode >= 500) {
    // 5xx Server Error: Log as ERROR with full stack trace and body context for debugging
    context.body = req.body;
    logger.error(`[Server Error] ${req.method} ${req.originalUrl} responded ${statusCode} (${errorCode})`, err, context);
  } else {
    // 4xx Client Error: Log as WARN with reason and context
    logger.warn(`[Client Error] ${req.method} ${req.originalUrl} responded ${statusCode} (${errorCode}): ${message}`, context);
  }

  res.status(statusCode).json({
    success: false,
    error: errorCode,
    message
  });
}
