import { Router } from 'express';
import { RelayController } from '../controllers/relay.controller.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { relayPayloadSchema } from '../schemas/relay.schema.js';
import { relayRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

// Endpoint for OtpRelayWorker.kt: POST /api/v1/relay
router.post('/', relayRateLimiter, validateBody(relayPayloadSchema), RelayController.relayOtp);

// Alias: POST /api/v1/relay/otp
router.post('/otp', relayRateLimiter, validateBody(relayPayloadSchema), RelayController.relayOtp);

export const relayRoutes = router;
