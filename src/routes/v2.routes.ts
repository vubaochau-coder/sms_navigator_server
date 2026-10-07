import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validateBody, validateQuery } from '../middlewares/validate.middleware.js';
import {
  DeviceV2Controller
} from '../controllers/device.v2.controller.js';
import {
  ChannelV2Controller,
  PairingChannelV2Controller,
  MessageV2Controller
} from '../controllers/channel.v2.controller.js';
import { PairingV2Controller } from '../controllers/pairing.v2.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  deviceRegisterV2Schema,
  fcmTokenV2Schema,
  deviceNameV2Schema,
  channelCreateSchema,
  channelIdQuerySchema,
  channelSessionCreateSchema,
  channelSessionResolveSchema,
  pairingRequestClaimSchema,
  channelRequestsQuerySchema,
  pairingApproveSchema,
  pairingRequestIdSchema,
  keyEnvelopeQuerySchema,
  messageSendV2Schema,
  messagesFetchQuerySchema,
  channelRevokeSchema
} from '../schemas/v2.schema.js';
import {
  v2RegisterRateLimiter,
  v2NameRateLimiter,
  v2SessionRateLimiter,
  v2ResolveRateLimiter,
  v2ClaimRateLimiter,
  v2ApproveRateLimiter,
  v2MessageRateLimiter,
  v2ReadRateLimiter
} from '../middlewares/rate-limit.middleware.js';

const router = Router();

// ---- Devices ----------------------------------------------------------------
// POST /api/v2/devices/register — no bearer (the token is the response)
router.post(
  '/devices/register',
  v2RegisterRateLimiter,
  validateBody(deviceRegisterV2Schema),
  asyncHandler(DeviceV2Controller.registerDevice)
);

// PUT /api/v2/devices/name — display-only rename with fan-out
router.put(
  '/devices/name',
  authenticate,
  v2NameRateLimiter,
  validateBody(deviceNameV2Schema),
  asyncHandler(DeviceV2Controller.updateName)
);

// PUT /api/v2/devices/fcm-token — wake-up bell registration
router.put(
  '/devices/fcm-token',
  authenticate,
  validateBody(fcmTokenV2Schema),
  asyncHandler(DeviceV2Controller.updateFcmToken)
);

// GET /api/v2/devices/me — profile & token validity check
router.get(
  '/devices/me',
  authenticate,
  v2ReadRateLimiter,
  asyncHandler(DeviceV2Controller.getMe)
);

// ---- Channels ---------------------------------------------------------------
router.post(
  '/channels',
  authenticate,
  validateBody(channelCreateSchema),
  asyncHandler(ChannelV2Controller.createChannel)
);

router.get('/channels', authenticate, asyncHandler(ChannelV2Controller.listChannels));

router.get(
  '/channels/detail',
  authenticate,
  validateQuery(channelIdQuerySchema),
  asyncHandler(ChannelV2Controller.getDetail)
);

router.get(
  '/channels/members',
  authenticate,
  validateQuery(channelIdQuerySchema),
  asyncHandler(ChannelV2Controller.getMembers)
);

router.get(
  '/channels/requests',
  authenticate,
  validateQuery(channelRequestsQuerySchema),
  asyncHandler(PairingChannelV2Controller.listRequests)
);

router.get(
  '/channels/key-envelope',
  authenticate,
  validateQuery(keyEnvelopeQuerySchema),
  asyncHandler(ChannelV2Controller.getKeyEnvelope)
);

router.post(
  '/channels/sessions',
  authenticate,
  v2SessionRateLimiter,
  validateBody(channelSessionCreateSchema),
  asyncHandler(PairingChannelV2Controller.createSession)
);

router.post(
  '/channels/sessions/resolve',
  authenticate,
  v2ResolveRateLimiter,
  validateBody(channelSessionResolveSchema),
  asyncHandler(PairingChannelV2Controller.resolveSession)
);

router.post(
  '/channels/messages',
  authenticate,
  v2MessageRateLimiter,
  validateBody(messageSendV2Schema),
  asyncHandler(MessageV2Controller.sendMessage)
);

router.post(
  '/channels/revoke',
  authenticate,
  v2ApproveRateLimiter,
  validateBody(channelRevokeSchema),
  asyncHandler(ChannelV2Controller.revoke)
);

// ---- Pairing ----------------------------------------------------------------
router.post(
  '/pairing/requests',
  authenticate,
  v2ClaimRateLimiter,
  validateBody(pairingRequestClaimSchema),
  asyncHandler(PairingV2Controller.claimRequest)
);

// GET /api/v2/pairing/requests/mine — statuses of requests sent by the caller
router.get(
  '/pairing/requests/mine',
  authenticate,
  asyncHandler(PairingV2Controller.listMyRequests)
);

router.post(
  '/pairing/requests/approve',
  authenticate,
  v2ApproveRateLimiter,
  validateBody(pairingApproveSchema),
  asyncHandler(PairingV2Controller.approveRequest)
);

router.post(
  '/pairing/requests/reject',
  authenticate,
  validateBody(pairingRequestIdSchema),
  asyncHandler(PairingV2Controller.rejectRequest)
);

router.post(
  '/pairing/requests/cancel',
  authenticate,
  validateBody(pairingRequestIdSchema),
  asyncHandler(PairingV2Controller.cancelRequest)
);

// ---- Messages (channel-agnostic day fetch) ----------------------------------
router.get(
  '/messages',
  authenticate,
  v2ReadRateLimiter,
  validateQuery(messagesFetchQuerySchema),
  asyncHandler(MessageV2Controller.fetchMessages)
);

export const apiV2Routes = router;
