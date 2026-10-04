import { createApp } from './app.js';
import { env } from './config/env.js';
import { initFirebase } from './config/firebase.js';
import { logger } from './utils/logger.js';

// Catch unhandled Promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Promise Rejection at:', reason, { promise: String(promise) });
});

// Catch uncaught synchronous exceptions
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception thrown:', error);
  // Give process time to flush logs before exit
  setTimeout(() => process.exit(1), 500);
});

async function bootstrap() {
  // Initialize Firebase Admin SDK
  initFirebase();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 SMS Navigator OTP Relay Server running on http://localhost:${env.PORT}`);
    logger.info(`⚡ Environment: ${env.NODE_ENV} | Mock Firebase: ${env.FIREBASE_MOCK_MODE}`);
  });

  const shutdown = () => {
    logger.info('🛑 Gracefully shutting down server...');
    server.close(() => {
      logger.info('✅ Server closed. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  logger.error('💥 Fatal error during server startup:', err);
  process.exit(1);
});
