import { createHash, randomBytes } from 'crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { getFirestoreDb } from '../config/firebase.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { assertNotProduction } from '../utils/test-only.js';
import { QR_CODES_COLLECTION } from './collections.js';

/**
 * Universal Opaque QR (ROADMAP_DEEPLINK_QR_V2 v3.3).
 *
 * A QR / deeplink carries only a random 128-bit `code`. The server maps it to
 * a business target (`type` + `target_id`) through an immutable ingress
 * pointer `qr_codes/{sha256(code)}` — the raw code is never stored, so a
 * Firestore dump cannot be replayed as live invites.
 */

export type QrType = 'PAIRING';
export const SUPPORTED_QR_TYPES: readonly QrType[] = ['PAIRING'];

/** 16 random bytes → base64url without padding = 22 chars. */
export const QR_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export interface QrPointer {
  type: string;
  target_id: string;
  expires_at: string;
  created_at: string;
  created_by: string;
}

export function generateQrCode(): string {
  return randomBytes(16).toString('base64url');
}

export function qrCodeDocId(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Canonical HTTPS link (App Links / Universal Links). */
export function qrUrlFor(code: string): string {
  return `${env.SERVER_BASE_URL.replace(/\/+$/, '')}/qr/${code}`;
}

export class QrCodeService {
  /** Writes the ingress pointer inside the caller's transaction (after all reads). */
  public writePointer(
    tx: Transaction,
    db: Firestore,
    input: { code: string; type: QrType; targetId: string; expiresAt: string; createdBy: string; now: string }
  ): void {
    const pointer: QrPointer = {
      type: input.type,
      target_id: input.targetId,
      expires_at: input.expiresAt,
      created_at: input.now,
      created_by: input.createdBy
    };
    tx.set(db.collection(QR_CODES_COLLECTION).doc(qrCodeDocId(input.code)), pointer);
  }

  /**
   * Looks up a live pointer. 400 malformed, 404 unknown, 422 type this server
   * build does not handle, 410 past its TTL. Lifecycle state (claimed /
   * superseded) is still decided by the target document.
   */
  public async findActive(code: string): Promise<QrPointer & { type: QrType }> {
    if (!QR_CODE_PATTERN.test(code)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Malformed QR code');
    }
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const doc = await db.collection(QR_CODES_COLLECTION).doc(qrCodeDocId(code)).get();
    const data = doc.data() as Partial<QrPointer> | undefined;
    if (!doc.exists || !data || typeof data.target_id !== 'string') {
      throw new HttpError(404, 'NOT_FOUND', 'This QR code does not exist');
    }
    if (!SUPPORTED_QR_TYPES.includes(data.type as QrType)) {
      throw new HttpError(422, 'UNSUPPORTED_QR_TYPE', `QR type ${String(data.type)} is not supported`, {
        type: data.type
      });
    }
    if (Date.parse(String(data.expires_at ?? 0)) <= Date.now()) {
      throw new HttpError(410, 'QR_EXPIRED', 'This invite code has expired');
    }
    return {
      type: data.type as QrType,
      target_id: data.target_id,
      expires_at: String(data.expires_at),
      created_at: String(data.created_at ?? ''),
      created_by: String(data.created_by ?? '')
    };
  }

  public async clearAll(): Promise<void> {
    assertNotProduction('qrCodeService.clearAll');
    const db = getFirestoreDb();
    if (!db) return;
    const snapshot = await db.collection(QR_CODES_COLLECTION).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
}

export const qrCodeService = new QrCodeService();
