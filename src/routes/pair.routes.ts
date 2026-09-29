import { Router } from 'express';
import { PairController } from '../controllers/pair.controller.js';
import { validateBody, validateParams } from '../middlewares/validate.middleware.js';
import { pairConfirmSchema, pairIdParamSchema } from '../schemas/pair.schema.js';
import { pairRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Receiver confirms pairing & registers FCM token
router.post('/confirm', pairRateLimiter, validateBody(pairConfirmSchema), PairController.confirmPairing);

// Query pairing status
router.get('/status/:pairId', validateParams(pairIdParamSchema), PairController.getPairStatus);

// Revoke pairing
router.delete('/:pairId', validateParams(pairIdParamSchema), PairController.revokePairing);

export const pairRoutes = router;
