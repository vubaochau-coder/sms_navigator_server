import { Router } from 'express';
import { PairController } from '../controllers/pair.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody, validateParams } from '../middlewares/validate.middleware.js';
import { pairConfirmSchema, pairIdParamSchema, pairInitSchema } from '../schemas/pair.schema.js';
import { pairConfirmRateLimiter, pairRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Device A initiates pairing: the server issues pair_id + one-time pairing_key
router.post('/init', authenticate, pairRateLimiter, validateBody(pairInitSchema), PairController.initPairing);

// Device B confirms pairing (QR flow) & registers its FCM token.
// Requires the QR's pairing_key as proof of possession - tightly rate limited.
router.post('/confirm', authenticate, pairConfirmRateLimiter, validateBody(pairConfirmSchema), PairController.confirmPairing);

// Query pairing status (restricted to Device A / Device B of the pair)
router.get('/status/:pairId', authenticate, validateParams(pairIdParamSchema), PairController.getPairStatus);

// Sender view: list all receivers paired with this sender
router.get('/receivers', authenticate, PairController.getPairedReceivers);

// Receiver view: list all senders paired with this receiver (read-only active status)
router.get('/senders', authenticate, PairController.getPairedSenders);

export const pairRoutes = router;
