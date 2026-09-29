import { Router } from 'express';
import { PairController } from '../controllers/pair.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody, validateParams } from '../middlewares/validate.middleware.js';
import { pairConfirmSchema, pairIdParamSchema, pairInitSchema } from '../schemas/pair.schema.js';
import { pairRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Device A initiates pairing: generates a single-use 6-digit code (stored as SHA-256 hash)
router.post('/init', authenticate, pairRateLimiter, validateBody(pairInitSchema), PairController.initPairing);

// Device B confirms pairing & registers its FCM token
router.post('/confirm', authenticate, pairRateLimiter, validateBody(pairConfirmSchema), PairController.confirmPairing);

// Query pairing status (restricted to Device A / Device B of the pair)
router.get('/status/:pairId', authenticate, validateParams(pairIdParamSchema), PairController.getPairStatus);

// Revoke pairing (restricted to Device A / Device B of the pair)
router.delete('/:pairId', authenticate, validateParams(pairIdParamSchema), PairController.revokePairing);

export const pairRoutes = router;
