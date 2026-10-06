import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { logger } from '../utils/logger.js';

interface ValidateOptions {
  /** HTTP status error code returned in the error envelope. */
  errorCode: string;
  /** Human-readable reason returned to the client. */
  message: string;
  /** Log label identifying the request part that failed. */
  label: string;
}

/**
 * Shared zod-validation middleware factory. v2 convention (spec §1): GET
 * endpoints carry every parameter in the query string, POST/PUT in the body.
 */
function createValidator(
  schema: AnyZodObject,
  extract: (req: Request) => unknown,
  assign: (req: Request, parsed: unknown) => void,
  options: ValidateOptions
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      assign(req, await schema.parseAsync(extract(req)));
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message
        }));

        logger.warn(`[Validation Error] ${req.method} ${req.originalUrl} ${options.label} failed`, {
          ip: req.ip,
          deviceId: req.device?.device_id,
          details
        });

        res.status(400).json({
          success: false,
          error: options.errorCode,
          message: options.message,
          details
        });
        return;
      }
      next(error);
    }
  };
}

export const validateBody = (schema: AnyZodObject) =>
  createValidator(
    schema,
    (req) => req.body,
    (req, parsed) => {
      req.body = parsed;
    },
    { errorCode: 'VALIDATION_ERROR', message: 'Invalid request payload', label: 'payload validation' }
  );

export const validateParams = (schema: AnyZodObject) =>
  createValidator(
    schema,
    (req) => req.params,
    (req, parsed) => {
      req.params = parsed as typeof req.params;
    },
    { errorCode: 'INVALID_PARAMETERS', message: 'Invalid URL parameters', label: 'URL parameters validation' }
  );

export const validateQuery = (schema: AnyZodObject) =>
  createValidator(
    schema,
    (req) => req.query,
    (req, parsed) => {
      req.query = parsed as typeof req.query;
    },
    { errorCode: 'VALIDATION_ERROR', message: 'Invalid query parameters', label: 'query validation' }
  );
