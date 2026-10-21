import { createHash } from 'crypto';
import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore';
import { PackageInput } from '../types/v2.js';
import {
  CHANNELS_COLLECTION,
  CHANNEL_MEMBERS_COLLECTION,
  CHANNEL_KEY_ENVELOPES_COLLECTION,
  channelMemberDocId,
  envelopeDocId
} from './collections.js';

export type RotationKind = 'APPROVE' | 'REVOKE';

/**
 * Receipt of the most recent epoch rotation, stored on the channel doc
 * (`channels/{id}.last_rotation`). It lets the server recognise a client
 * retry of a rotation that already committed (e.g. the HTTP response was lost
 * to a timeout) and answer it idempotently instead of with a misleading
 * 409 MEMBERSHIP_CHANGED — which the client could not tell apart from a real
 * concurrent change.
 */
export interface LastRotation {
  kind: RotationKind;
  package_hash: string;
  base_epoch: number;
  base_membership_version: number;
  new_epoch: number;
  new_membership_version: number;
  request_id?: string;
  revoked_device_ids?: string[];
  committed_at: string;
}

export interface RotationCommitInput {
  kind: RotationKind;
  channelId: string;
  base: { current_epoch: number; membership_version: number };
  pkg: PackageInput;
  /** Remaining ACTIVE members (excluding a newly added one) whose provisioned_epoch moves to the new epoch. */
  provisionDeviceIds: string[];
  memberCount: number;
  now: string;
  requestId?: string;
  revokedDeviceIds?: string[];
}

export interface RotationCommitResult {
  current_epoch: number;
  membership_version: number;
}

/**
 * Deterministic fingerprint of a rotation package. Envelopes carry fresh
 * random wrapped keys/nonces, so two different rotations never collide, while
 * a byte-identical retry always matches.
 */
export function packageFingerprint(pkg: PackageInput): string {
  const envelopes = [...pkg.envelopes]
    .map((e) => [e.device_id, e.key_epoch, e.wrapped_key, e.nonce, e.kek_alg])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256')
    .update(JSON.stringify([pkg.base_epoch, pkg.base_membership_version, envelopes]))
    .digest('hex');
}

function parseLastRotation(raw: unknown): LastRotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.package_hash !== 'string' || (r.kind !== 'APPROVE' && r.kind !== 'REVOKE')) return null;
  return {
    kind: r.kind,
    package_hash: r.package_hash,
    base_epoch: Number(r.base_epoch ?? 0),
    base_membership_version: Number(r.base_membership_version ?? 0),
    new_epoch: Number(r.new_epoch ?? 0),
    new_membership_version: Number(r.new_membership_version ?? 0),
    request_id: typeof r.request_id === 'string' ? r.request_id : undefined,
    revoked_device_ids: Array.isArray(r.revoked_device_ids) ? r.revoked_device_ids.map(String) : undefined,
    committed_at: String(r.committed_at ?? '')
  };
}

function sameIdSet(a: string[] = [], b: string[] = []): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Owns every write that changes a channel's epoch / membership_version /
 * envelopes. Pairing (T2 approve) and channel (T4 revoke) both commit their
 * rotation through here, so the KL5 invariants live in exactly one place.
 */
export class ChannelMembershipService {
  /**
   * Returns the stored receipt when `pkg` is a byte-identical retry of the
   * channel's latest rotation; null otherwise. Only the latest rotation is
   * replayable — if anything rotated after it, the retry is genuinely stale.
   */
  public findReplay(
    channelData: Record<string, unknown> | undefined,
    pkg: PackageInput,
    match: { kind: RotationKind; requestId?: string; revokedDeviceIds?: string[] }
  ): LastRotation | null {
    const last = parseLastRotation(channelData?.last_rotation);
    if (!last || last.kind !== match.kind) return null;
    if (last.new_epoch !== Number(channelData?.current_epoch ?? 0)) return null;
    if (last.package_hash !== packageFingerprint(pkg)) return null;
    if (match.kind === 'APPROVE' && last.request_id !== match.requestId) return null;
    if (match.kind === 'REVOKE' && !sameIdSet(last.revoked_device_ids, match.revokedDeviceIds)) return null;
    return last;
  }

  /**
   * Writes the epoch rotation inside the caller's transaction (all reads must
   * already be done): provisioned_epoch bump, channel counters + receipt, and
   * the new envelope set. The caller is responsible for validatePackage().
   */
  public commitRotation(tx: Transaction, db: Firestore, input: RotationCommitInput): RotationCommitResult {
    const newEpoch = input.base.current_epoch + 1;
    const newVersion = input.base.membership_version + 1;
    const channelRef: DocumentReference = db.collection(CHANNELS_COLLECTION).doc(input.channelId);

    for (const deviceId of input.provisionDeviceIds) {
      tx.update(db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(input.channelId, deviceId)), {
        provisioned_epoch: newEpoch
      });
    }

    const receipt: LastRotation = {
      kind: input.kind,
      package_hash: packageFingerprint(input.pkg),
      base_epoch: input.base.current_epoch,
      base_membership_version: input.base.membership_version,
      new_epoch: newEpoch,
      new_membership_version: newVersion,
      committed_at: input.now,
      ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.revokedDeviceIds ? { revoked_device_ids: input.revokedDeviceIds } : {})
    };

    tx.update(channelRef, {
      current_epoch: newEpoch,
      membership_version: newVersion,
      member_count: input.memberCount,
      updated_at: input.now,
      last_rotation: receipt
    });

    for (const envelope of input.pkg.envelopes) {
      tx.set(db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(input.channelId, envelope.device_id, newEpoch)), {
        channel_id: input.channelId,
        device_id: envelope.device_id,
        key_epoch: envelope.key_epoch,
        wrapped_key: envelope.wrapped_key,
        nonce: envelope.nonce,
        kek_alg: envelope.kek_alg,
        created_at: input.now
      });
    }

    return { current_epoch: newEpoch, membership_version: newVersion };
  }
}

export const channelMembershipService = new ChannelMembershipService();
