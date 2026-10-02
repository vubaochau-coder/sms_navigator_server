import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  SESSION_TTL_HOURS: z.coerce.number().default(720), // 30 days
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
  CORS_ORIGIN: z.string().default('')
});

export const env = envSchema.parse(process.env);
