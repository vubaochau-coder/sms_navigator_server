import rateLimit from 'express-rate-limit';
import { Request } from 'express';

const skipInTest = (): boolean => process.env.NODE_ENV === 'test';

// ---------------------------------------------------------------------------
// API v2 budgets (spec §10). All no-ops under jest (skipInTest).
// ---------------------------------------------------------------------------

/** Per-device bucket for authenticated v2 mutations; IP fallback pre-auth. */
const v2KeyGenerator = (req: Request): string => req.device?.device_id ?? req.ip ?? 'unknown';

const v2Message = (messageText: string) => ({
  success: false,
  error: 'RATE_LIMITED',
  message: messageText
});

// POST /api/v2/devices/register - 10 / 5 min / IP
export const v2RegisterRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: v2Message('Too many device registrations. Please try again later.')
});

// PUT /api/v2/devices/name - 10 / min / device
export const v2NameRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Too many rename requests. Please slow down.')
});

// POST /api/v2/channels/sessions - 10 / 5 min / device
export const v2SessionRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Too many pairing sessions created. Please wait before creating more.')
});

// POST /api/v2/channels/sessions/resolve - 30 / 5 min / device
export const v2ResolveRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Too many session resolve attempts. Please try again later.')
});

// POST /api/v2/pairing/requests (claim) - 10 / 5 min / device (anti brute token)
export const v2ClaimRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Too many pairing claim attempts. Please try again later.')
});

// POST approve / revoke - 20 / min / device
export const v2ApproveRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Too many membership changes. Please slow down.')
});

// POST /api/v2/channels/messages - 60 / min / device
export const v2MessageRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Message rate limit exceeded. Please wait a moment.')
});

// GET /api/v2/messages - 120 / min / device
export const v2ReadRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: v2KeyGenerator,
  message: v2Message('Read rate limit exceeded. Please wait a moment.')
});

// GET /health, GET /api/v1/health - 20 / min / IP
export const healthRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    success: false,
    error: 'RATE_LIMITED',
    message: 'Too many health check requests. Please try again later.'
  }
});

