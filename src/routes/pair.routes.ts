import { Router } from 'express';
import { PairController } from '../controllers/pair.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody, validateParams } from '../middlewares/validate.middleware.js';
import { pairConfirmSchema, pairIdParamSchema, pairInitSchema } from '../schemas/pair.schema.js';
import { pairRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Device A initiates pairing: creates the pair session confirmed via QR payload
router.post('/init', authenticate, pairRateLimiter, validateBody(pairInitSchema), PairController.initPairing);

// Device B confirms pairing (QR flow) & registers its FCM token
router.post('/confirm', authenticate, pairRateLimiter, validateBody(pairConfirmSchema), PairController.confirmPairing);

// Query pairing status (restricted to Device A / Device B of the pair)
router.get('/status/:pairId', authenticate, validateParams(pairIdParamSchema), PairController.getPairStatus);

// Sender view: list all receivers paired with this sender
router.get('/receivers', authenticate, PairController.getPairedReceivers);

// Receiver view: list all senders paired with this receiver (read-only active status)
router.get('/senders', authenticate, PairController.getPairedSenders);

// Sender toggle: enable/pause relaying to a specific pair
router.patch('/:pairId/toggle', authenticate, validateParams(pairIdParamSchema), PairController.togglePairActive);

// Revoke pairing (restricted to Device A / Device B of the pair)
router.delete('/:pairId', authenticate, validateParams(pairIdParamSchema), PairController.revokePairing);

export const pairRoutes = router;
