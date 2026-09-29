import { createApp } from './app.js';
import { env } from './config/env.js';
import { initFirebase } from './config/firebase.js';

async function bootstrap() {
  // Initialize Firebase Admin SDK
  initFirebase();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`🚀 SMS Navigator OTP Relay Server running on http://localhost:${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`⚡ Environment: ${env.NODE_ENV} | Mock Firebase: ${env.FIREBASE_MOCK_MODE}`);
  });

  const shutdown = () => {
    // eslint-disable-next-line no-console
    console.log('\n🛑 Gracefully shutting down server...');
    server.close(() => {
      // eslint-disable-next-line no-console
      console.log('✅ Server closed. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('💥 Fatal error during server startup:', err);
  process.exit(1);
});
