import rateLimit from 'express-rate-limit';

const skipInTest = (): boolean => process.env.NODE_ENV === 'test';

export const relayRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Limit each IP to 60 relay requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Rate limit exceeded. Please wait a moment before sending more OTP relays.'
  }
});

export const pairRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // Limit each IP to 30 pair requests per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many pairing attempts. Please try again later.'
  }
});

// Confirm attempts are the brute-force surface (guessing QR pairing keys), so
// they get a much tighter budget than the init endpoint.
export const pairConfirmRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // Limit each IP to 10 confirm attempts per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many pairing confirm attempts. Please try again later.'
  }
});

export const deviceRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 device registrations per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many device registrations. Please try again later.'
  }
});
