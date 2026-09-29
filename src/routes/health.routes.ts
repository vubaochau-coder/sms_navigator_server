import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';

const router = Router();

router.get('/', HealthController.check);

export const healthRoutes = router;
