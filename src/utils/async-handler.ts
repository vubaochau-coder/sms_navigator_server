import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not forward rejected promises from async handlers to the
 * error middleware - wrap every async route handler with this helper so
 * `HttpError`s thrown inside services reach `errorHandler`.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
