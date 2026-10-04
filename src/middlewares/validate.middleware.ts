import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { logger } from '../utils/logger.js';

export const validateBody = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message
        }));

        logger.warn(`[Validation Error] ${req.method} ${req.originalUrl} payload validation failed`, {
          ip: req.ip,
          deviceId: req.device?.device_id,
          details
        });

        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid request payload',
          details
        });
        return;
      }
      next(error);
    }
  };
};

export const validateParams = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.params = await schema.parseAsync(req.params);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message
        }));

        logger.warn(`[Validation Error] ${req.method} ${req.originalUrl} URL parameters validation failed`, {
          ip: req.ip,
          deviceId: req.device?.device_id,
          details
        });

        res.status(400).json({
          success: false,
          error: 'INVALID_PARAMETERS',
          message: 'Invalid URL parameters',
          details
        });
        return;
      }
      next(error);
    }
  };
};

/** v2 convention (spec §1): GET endpoints carry every parameter in the query string. */
export const validateQuery = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.query = (await schema.parseAsync(req.query)) as typeof req.query;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message
        }));

        logger.warn(`[Validation Error] ${req.method} ${req.originalUrl} query validation failed`, {
          ip: req.ip,
          deviceId: req.device?.device_id,
          details
        });

        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details
        });
        return;
      }
      next(error);
    }
  };
};
