import { Router } from 'express';
import { healthRoutes } from './health.routes.js';
import { pairRoutes } from './pair.routes.js';
import { relayRoutes } from './relay.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/pair', pairRoutes);
router.use('/relay', relayRoutes);

export const apiV1Routes = router;
