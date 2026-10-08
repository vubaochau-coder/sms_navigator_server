import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';
import { healthRateLimiter } from '../middlewares/rate-limit.middleware.js';

const router = Router();

router.get('/', healthRateLimiter, HealthController.check);

export const healthRoutes = router;
