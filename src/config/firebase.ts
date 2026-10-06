import { initializeApp, getApps, applicationDefault, cert } from 'firebase-admin/app';
import * as firestoreAdmin from 'firebase-admin/firestore';
import fs from 'fs';
import { env } from './env.js';
import { logger } from '../utils/logger.js';
import { mockFirestore } from './firestore-mock.js';

let isFirebaseInitialized = false;
let cachedDb: firestoreAdmin.Firestore | null = null;

export function initFirebase(): void {
  if (isFirebaseInitialized) {
    return;
  }

  if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
    logger.info('[Firebase] Running in MOCK mode (No external FCM calls will be dispatched).');
    isFirebaseInitialized = true;
    return;
  }

  try {
    let credential: ReturnType<typeof applicationDefault> | ReturnType<typeof cert>;

    if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = cert(parsed);
    } else if (env.FIREBASE_SERVICE_ACCOUNT_PATH && fs.existsSync(env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
      credential = cert(env.FIREBASE_SERVICE_ACCOUNT_PATH);
    } else {
      // Try Application Default Credentials (e.g. Google Cloud Run)
      credential = applicationDefault();
    }

    initializeApp({
      credential
    });

    isFirebaseInitialized = true;
    logger.info('[Firebase] Admin SDK initialized successfully.');
  } catch (error) {
    logger.error('[Firebase] Failed to initialize Firebase Admin SDK.', error);
    if (env.NODE_ENV === 'production') {
      // Fail fast: a prod server must never silently degrade to the in-memory
      // mock (data would be accepted then lost on restart).
      throw error;
    }
    logger.warn('[Firebase] Falling back to Mock mode (dev/test only).');
    isFirebaseInitialized = true;
  }
}

/**
 * Whether the REAL Firebase Admin SDK is connected.
 *
 * Returns `false` in mock/test mode or when SDK initialization failed,
 * so the health check does not report a meaningless hardcoded `true`.
 */
export function isFirebaseReady(): boolean {
  if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
    return false;
  }
  return getApps().length > 0;
}

/**
 * Returns the Firestore database used by all services.
 *
 * - In test / mock mode (`NODE_ENV === 'test'` or `FIREBASE_MOCK_MODE === 'true'`)
 *   an In-Memory Firestore adapter is returned so `npm test` runs 100% offline.
 * - In production the real Firestore instance is used; if the SDK failed to
 *   initialize, `null` is returned (services fail closed).
 */
export function getFirestoreDb(): firestoreAdmin.Firestore | null {
  if (cachedDb) {
    return cachedDb;
  }

  if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
    cachedDb = mockFirestore as unknown as firestoreAdmin.Firestore;
    return cachedDb;
  }

  try {
    initFirebase();
    if (getApps().length === 0) {
      return null;
    }
    cachedDb = firestoreAdmin.getFirestore();
    return cachedDb;
  } catch (error) {
    logger.error('[Firestore] Firestore is unavailable.', error);
    if (env.NODE_ENV === 'production') {
      // Fail fast: prod must never fall back to the in-memory mock.
      throw error;
    }
    logger.warn('[Firestore] Falling back to In-Memory adapter (dev/test only).');
    cachedDb = mockFirestore as unknown as firestoreAdmin.Firestore;
    return cachedDb;
  }
}
