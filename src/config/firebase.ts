import * as admin from 'firebase-admin';
import fs from 'fs';
import { env } from './env.js';

let isFirebaseInitialized = false;

export function initFirebase(): typeof admin {
  if (isFirebaseInitialized) {
    return admin;
  }

  if (env.FIREBASE_MOCK_MODE || env.NODE_ENV === 'test') {
    // eslint-disable-next-line no-console
    console.log('[Firebase] Running in MOCK mode (No external FCM calls will be dispatched).');
    isFirebaseInitialized = true;
    return admin;
  }

  try {
    let credential: admin.credential.Credential | undefined;

    if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(parsed);
    } else if (env.FIREBASE_SERVICE_ACCOUNT_PATH && fs.existsSync(env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
      credential = admin.credential.cert(env.FIREBASE_SERVICE_ACCOUNT_PATH);
    } else {
      // Try Application Default Credentials (e.g. Google Cloud Run)
      credential = admin.credential.applicationDefault();
    }

    admin.initializeApp({
      credential
    });

    isFirebaseInitialized = true;
    // eslint-disable-next-line no-console
    console.log('[Firebase] Admin SDK initialized successfully.');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[Firebase] Warning: Failed to initialize Firebase Admin SDK. Fallback to Mock mode.', error);
    isFirebaseInitialized = true;
  }

  return admin;
}

export function isFirebaseReady(): boolean {
  return isFirebaseInitialized;
}
