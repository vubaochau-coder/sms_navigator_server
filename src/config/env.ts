import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  // Firebase Service Account Credentials can be passed as path or base64 JSON string
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Mock mode for local dev/testing without Firebase credentials
  FIREBASE_MOCK_MODE: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  // CORS whitelist (GĐ4.3): danh sách origin phân tách bởi dấu phẩy.
  // Mặc định RỖNG = chặn mọi cross-origin request (client chính là app mobile,
  // không dùng CORS). Dùng '*' chỉ khi thật sự cần mở cho mọi origin.
  CORS_ORIGIN: z.string().default(''),
  // Public base URL embedded in v2 QR invite payloads (srv= parameter)
  SERVER_BASE_URL: z.string().default('http://localhost:3000'),
  // App Links (Android): package + SHA-256 cert fingerprints, comma-separated
  // (debug, release, Play App Signing). Empty list → assetlinks.json is [].
  ANDROID_APP_PACKAGE: z.string().default('com.example.sms_navigator'),
  ANDROID_CERT_SHA256: z.string().default(''),
  // Universal Links (iOS): comma-separated `TEAMID.bundle.id`.
  IOS_APP_IDS: z.string().default(''),
  // Optional "get the app" link on the /qr/:code fallback page.
  APP_DOWNLOAD_URL: z.string().default('')
});

export const env = envSchema.parse(process.env);
