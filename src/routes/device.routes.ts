import { Router } from 'express';
import { DeviceController } from '../controllers/device.controller.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { deviceRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { validateBody } from '../middlewares/validate.middleware.js';
import { deviceFcmTokenSchema, deviceRegisterSchema } from '../schemas/device.schema.js';

const router = Router();

// Register a device: issues a CSPRNG bearer token (only its SHA-256 hash is stored)
router.post('/register', deviceRateLimiter, validateBody(deviceRegisterSchema), DeviceController.registerDevice);

// Update the FCM token of the authenticated (receiver) device
router.put('/fcm-token', authenticate, validateBody(deviceFcmTokenSchema), DeviceController.updateFcmToken);

export const deviceRoutes = router;
