import { Router } from 'express';
import { RelayController } from '../controllers/relay.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody, validateParams } from '../middlewares/validate.middleware.js';
import { relayPayloadSchema } from '../schemas/relay.schema.js';
import { pairIdParamSchema } from '../schemas/pair.schema.js';
import { relayRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Endpoint for OtpRelayWorker.kt: POST /api/v1/relay
router.post('/', authenticate, relayRateLimiter, validateBody(relayPayloadSchema), RelayController.relayOtp);

// Alias: POST /api/v1/relay/otp
router.post('/otp', authenticate, relayRateLimiter, validateBody(relayPayloadSchema), RelayController.relayOtp);

// Receiver polls encrypted payloads queued for this pair (auto-clears on fetch)
router.get('/pending/:pairId', authenticate, validateParams(pairIdParamSchema), RelayController.getPendingMessages);

// Alias: GET /api/v1/relay/otp/pending/:pairId
router.get('/otp/pending/:pairId', authenticate, validateParams(pairIdParamSchema), RelayController.getPendingMessages);

// History endpoint: GET /api/v1/relay/history?date=YYYY-MM-DD&pair_id=...
router.get('/history', authenticate, RelayController.getRelayHistory);
router.get('/otp/history', authenticate, RelayController.getRelayHistory);

export const relayRoutes = router;
