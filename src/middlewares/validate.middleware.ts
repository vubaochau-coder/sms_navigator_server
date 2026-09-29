import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';

export const validateBody = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid request payload',
          details: error.errors.map((err) => ({
            field: err.path.join('.'),
            message: err.message
          }))
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
        res.status(400).json({
          success: false,
          error: 'INVALID_PARAMETERS',
          message: 'Invalid URL parameters',
          details: error.errors.map((err) => ({
            field: err.path.join('.'),
            message: err.message
          }))
        });
        return;
      }
      next(error);
    }
  };
};
