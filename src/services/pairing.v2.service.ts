import { randomBytes, randomUUID } from 'crypto';
import {
  ChannelEntity,
  ChannelMemberEntity,
  MemberStatus,
  PairingRequestEntity,
  PairingSessionEntity,
  PackageInput
} from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { env } from '../config/env.js';
import { nowIso } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { sha256Hex, DEVICES_COLLECTION } from './device.service.js';
import {
  CHANNELS_COLLECTION,
  CHANNEL_MEMBERS_COLLECTION,
  CHANNEL_KEY_ENVELOPES_COLLECTION,
  channelMemberDocId,
  envelopeDocId,
  envelopeToDocInput,
  validatePackage
} from './channel.service.js';

export const PAIRING_SESSIONS_COLLECTION = 'pairing_sessions';
export const PAIRING_REQUESTS_COLLECTION = 'pairing_requests';
/** One pending-join marker per (channel, requester) — dedup guard for T1. */
export const PAIRING_PENDING_COLLECTION = 'pairing_pending';

/** Document id per SRD 3.5b: `{channelId}__{requesterDeviceId}` (double underscore). */
export function pairingPendingDocId(channelId: string, requesterDeviceId: string): string {
  return `${channelId}__${requesterDeviceId}`;
}

/** N5/I9: QR invite is single-use with a 10-minute TTL. */
export const SESSION_TTL_MS = 10 * 60 * 1000;

export interface SessionCreateResult {
  session_id: string;
  pairing_token: string;
  expires_at: string;
  invite_url: string;
}

export interface SessionResolveResult {
  session_id: string;
  channel_id: string;
  channel_name: string;
  owner_device_name: string;
  expires_at: string;
}

export interface ClaimResult {
  request_id: string;
  channel_id: string;
  channel_name: string;
  owner_device_name: string;
}

export interface ApproveResult {
  requester_device_id: string;
  current_epoch: number;
  membership_version: number;
}

function requestFromDocument(data: Record<string, unknown> | undefined): PairingRequestEntity | null {
  if (!data || typeof data.request_id !== 'string') return null;
  return {
    request_id: data.request_id,
    channel_id: String(data.channel_id ?? ''),
    session_id: String(data.session_id ?? ''),
    requester_device_id: String(data.requester_device_id ?? ''),
    requester_device_name: String(data.requester_device_name ?? ''),
    requester_public_key: String(data.requester_public_key ?? ''),
    owner_device_name: data.owner_device_name as string | undefined,
    status: (data.status as PairingRequestEntity['status']) ?? 'PENDING',
    decided_by: data.decided_by as string | undefined,
    decided_at: data.decided_at as string | undefined,
    created_at: String(data.created_at ?? nowIso()),
    terminal_at: data.terminal_at as string | undefined
  };
}

/** base64url without padding for the deeplink `u=` parameter (API spec §4.5). */
function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export class PairingV2Service {
  /**
   * POST /channels/sessions (API spec §4.5): Owner creates a single-use QR
   * invite session. The server returns the raw 128-bit pairing token (shown
   * once) plus a fully-formed invite_url v4 so both sides share one parser.
   */
  public async createSession(ownerId: string, channelId: string): Promise<SessionCreateResult> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
    const sessionId = randomUUID();
    const pairingToken = randomBytes(16).toString('hex'); // 128-bit raw token
    const now = nowIso();
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();

    await db.runTransaction(async (tx) => {
      // 1. Transaction reads: verify owner and query previous UNUSED sessions
      const channel = await tx.get(channelRef);
      if (!channel.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      if (String(channel.data()?.owner_device_id ?? '') !== ownerId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can create invite sessions');
      }

      const existingUnusedSnapshot = await tx.get(
        db
          .collection(PAIRING_SESSIONS_COLLECTION)
          .where('channel_id', '==', channelId)
          .where('status', '==', 'UNUSED')
      );

      // 2. Transaction writes (after all reads): invalidate prior UNUSED sessions
      for (const doc of existingUnusedSnapshot.docs) {
        tx.update(doc.ref, { status: 'EXPIRED' });
      }

      tx.set(db.collection(PAIRING_SESSIONS_COLLECTION).doc(sessionId), {
        session_id: sessionId,
        channel_id: channelId,
        pairing_token_hash: sha256Hex(pairingToken),
        status: 'UNUSED',
        expires_at: expiresAt,
        created_at: now
      });
    });

    const inviteUrl =
      `smsnavigator://pair?v=4&s=${sessionId}` +
      `&t=${pairingToken}` +
      `&u=${base64UrlEncode(env.SERVER_BASE_URL)}` +
      `&e=${expiresAtMs}`;

    return { session_id: sessionId, pairing_token: pairingToken, expires_at: expiresAt, invite_url: inviteUrl };
  }

  /**
   * POST /channels/sessions/resolve (API spec §4.6): Member previews channel
   * details before submitting a claim. Strictly read-only: Firestore is never
   * mutated and session remains UNUSED.
   * Performs early dedup checks (409 ALREADY_MEMBER, 409 REQUEST_ALREADY_PENDING)
   * so client fails early before user interaction.
   */
  public async resolveSession(
    requesterDeviceId: string,
    sessionId: string,
    pairingToken: string
  ): Promise<SessionResolveResult> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const tokenHash = sha256Hex(pairingToken);
    const sessionRef = db.collection(PAIRING_SESSIONS_COLLECTION).doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      throw new HttpError(404, 'NOT_FOUND', 'Pairing session does not exist');
    }
    const session = sessionDoc.data() as Partial<PairingSessionEntity>;
    if (String(session.pairing_token_hash ?? '') !== tokenHash) {
      throw new HttpError(404, 'NOT_FOUND', 'Pairing token does not match this session');
    }
    if (session.status === 'CLAIMED') {
      throw new HttpError(409, 'QR_ALREADY_USED', 'This invite code has already been used');
    }
    if (session.status !== 'UNUSED') {
      throw new HttpError(410, 'QR_EXPIRED', 'This invite code is no longer valid');
    }
    if (Date.parse(String(session.expires_at ?? 0)) <= Date.now()) {
      throw new HttpError(410, 'QR_EXPIRED', 'This invite code has expired');
    }

    const channelId = String(session.channel_id ?? '');
    const [channelDoc, memberDoc, pendingDoc] = await Promise.all([
      db.collection(CHANNELS_COLLECTION).doc(channelId).get(),
      db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, requesterDeviceId)).get(),
      db.collection(PAIRING_PENDING_COLLECTION).doc(pairingPendingDocId(channelId, requesterDeviceId)).get()
    ]);

    if (!channelDoc.exists) {
      throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
    }
    const channel = channelDoc.data() as Partial<ChannelEntity>;
    if (channel.status !== 'ACTIVE') {
      throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
    }

    const member = memberDoc.data() as Partial<ChannelMemberEntity> | undefined;
    if (memberDoc.exists && member?.status === 'ACTIVE') {
      throw new HttpError(409, 'ALREADY_MEMBER', 'Your device has already joined this channel');
    }

    if (pendingDoc.exists) {
      throw new HttpError(
        409,
        'REQUEST_ALREADY_PENDING',
        'A join request from this device is already awaiting approval for this channel'
      );
    }

    let ownerDeviceName = '';
    if (channel.owner_device_id) {
      const ownerDoc = await db.collection(DEVICES_COLLECTION).doc(channel.owner_device_id).get();
      ownerDeviceName = String(ownerDoc.data()?.device_name ?? '');
    }

    return {
      session_id: sessionId,
      channel_id: channelId,
      channel_name: String(channel.name ?? ''),
      owner_device_name: ownerDeviceName,
      expires_at: String(session.expires_at ?? '')
    };
  }

  /**
   * T1 (API spec §5.1): member claims the QR. Transaction:
   * `pairing_sessions UNUSED && expires_at > now → CLAIMED` + create
   * pairing_requests PENDING. Errors: 409 QR_ALREADY_USED, 410 QR_EXPIRED,
   * 409 ALREADY_MEMBER (caller is an ACTIVE member, owner included),
   * 409 REQUEST_ALREADY_PENDING (same device already awaiting approval on
   * this channel — enforced via the deterministic `pairing_pending` marker,
   * so concurrent claims with different sessions cannot both commit).
   */
  public async claimSession(
    requesterDeviceId: string,
    requesterPublicKey: string,
    sessionId: string,
    pairingToken: string,
    deviceName: string
  ): Promise<ClaimResult> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();
    const tokenHash = sha256Hex(pairingToken);

    return db.runTransaction(async (tx): Promise<ClaimResult> => {
      const sessionRef = db.collection(PAIRING_SESSIONS_COLLECTION).doc(sessionId);
      const sessionDoc = await tx.get(sessionRef);
      if (!sessionDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', 'Pairing session does not exist');
      }
      const session = sessionDoc.data() as Partial<PairingSessionEntity>;
      if (String(session.pairing_token_hash ?? '') !== tokenHash) {
        throw new HttpError(404, 'NOT_FOUND', 'Pairing token does not match this session');
      }
      if (session.status === 'CLAIMED') {
        throw new HttpError(409, 'QR_ALREADY_USED', 'This invite code has already been used');
      }
      if (session.status !== 'UNUSED') {
        throw new HttpError(410, 'QR_EXPIRED', 'This invite code is no longer valid');
      }
      if (Date.parse(String(session.expires_at ?? 0)) <= Date.now()) {
        tx.update(sessionRef, { status: 'EXPIRED' });
        throw new HttpError(410, 'QR_EXPIRED', 'This invite code has expired');
      }

      const channelId = String(session.channel_id ?? '');
      const channelDoc = await tx.get(db.collection(CHANNELS_COLLECTION).doc(channelId));
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const channel = channelDoc.data() as Partial<ChannelEntity>;
      if (channel.status !== 'ACTIVE') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }

      // Dedup rules (read-only phase — all reads precede writes):
      // 1. ACTIVE member (owner included — Owner has a member doc since T0)
      //    may not re-join. REVOKED may re-claim (reinstall policy SRD 8.2).
      const memberDoc = await tx.get(
        db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, requesterDeviceId))
      );
      const member = memberDoc.data() as Partial<ChannelMemberEntity> | undefined;
      if (memberDoc.exists && member?.status === 'ACTIVE') {
        throw new HttpError(409, 'ALREADY_MEMBER', 'Your device has already joined this channel');
      }

      // 2. Same device already has a PENDING request on this channel. The
      //    deterministic marker doc id serializes concurrent claims: two
      //    transactions that both read the marker as absent still conflict
      //    on commit when both write the same doc id, so only one survives.
      const pendingRef = db
        .collection(PAIRING_PENDING_COLLECTION)
        .doc(pairingPendingDocId(channelId, requesterDeviceId));
      const pendingDoc = await tx.get(pendingRef);
      if (pendingDoc.exists) {
        throw new HttpError(
          409,
          'REQUEST_ALREADY_PENDING',
          'A join request from this device is already awaiting approval for this channel'
        );
      }

      // Read owner device BEFORE writes to guarantee all reads precede writes
      let ownerDeviceName = '';
      if (channel.owner_device_id) {
        const ownerDoc = await tx.get(db.collection(DEVICES_COLLECTION).doc(channel.owner_device_id));
        ownerDeviceName = String(ownerDoc.data()?.device_name ?? '');
      }

      const requestId = randomUUID();
      tx.update(sessionRef, {
        status: 'CLAIMED',
        claimed_by_device_id: requesterDeviceId,
        request_id: requestId
      });
      tx.set(db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId), {
        request_id: requestId,
        channel_id: channelId,
        session_id: sessionId,
        requester_device_id: requesterDeviceId,
        requester_device_name: deviceName,
        requester_public_key: requesterPublicKey,
        owner_device_name: ownerDeviceName,
        status: 'PENDING',
        created_at: now
      });
      tx.set(pendingRef, {
        channel_id: channelId,
        requester_device_id: requesterDeviceId,
        request_id: requestId,
        created_at: now
      });

      return {
        request_id: requestId,
        channel_id: channelId,
        channel_name: String(channel.name ?? ''),
        owner_device_name: ownerDeviceName
      };
    });
  }

  /** GET /pairing/requests/mine (API spec §5.2): requests sent by the caller. */
  public async listMyRequests(requesterDeviceId: string): Promise<Array<Record<string, unknown>>> {
    const db = getFirestoreDb();
    if (!db) return [];

    const snapshot = await db
      .collection(PAIRING_REQUESTS_COLLECTION)
      .where('requester_device_id', '==', requesterDeviceId)
      .get();

    const requests = snapshot.docs
      .map((doc) => requestFromDocument(doc.data()))
      .filter((request): request is PairingRequestEntity => request !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (requests.length === 0) return [];

    // Batched channel-name lookup (no per-request read)
    const channelIds = [...new Set(requests.map((request) => request.channel_id))];
    const channelDocs = await Promise.all(
      channelIds.map((id) => db.collection(CHANNELS_COLLECTION).doc(id).get())
    );
    const channelNameById = new Map<string, string>();
    for (const doc of channelDocs) {
      channelNameById.set(doc.id, String(doc.data()?.name ?? ''));
    }

    return requests.map((request) => ({
      request_id: request.request_id,
      channel_id: request.channel_id,
      channel_name: channelNameById.get(request.channel_id) ?? '',
      owner_device_name: request.owner_device_name ?? '',
      status: request.status,
      created_at: request.created_at,
      decided_at: request.decided_at
    }));
  }

  /** GET /channels/requests (API spec §5.3): Owner approval queue (Q1). */
  public async listChannelRequests(
    ownerId: string,
    channelId: string,
    status: string
  ): Promise<Array<Record<string, unknown>>> {
    const db = getFirestoreDb();
    if (!db) return [];

    const channel = await db.collection(CHANNELS_COLLECTION).doc(channelId).get();
    if (!channel.exists) {
      throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
    }
    if (String(channel.data()?.owner_device_id ?? '') !== ownerId) {
      throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can view the approval queue');
    }

    const snapshot = await db
      .collection(PAIRING_REQUESTS_COLLECTION)
      .where('channel_id', '==', channelId)
      .where('status', '==', status)
      .get();

    return snapshot.docs
      .map((doc) => requestFromDocument(doc.data()))
      .filter((request): request is PairingRequestEntity => request !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((request) => ({
        request_id: request.request_id,
        requester_device_id: request.requester_device_id,
        requester_device_name: request.requester_device_name,
        // Owner cần pk của requester để wrap envelope epoch mới (SRD 7.2)
        requester_public_key: request.requester_public_key,
        created_at: request.created_at
      }));
  }

  /**
   * T2 (API spec §5.4): approve + rotate. Package envelope set must equal
   * {Owner} ∪ {ACTIVE before txn} ∪ {Requester} at epoch N+1 (SRD 4.1).
   * Commit: request APPROVED, requester member ACTIVE (joined_epoch = N+1,
   * provisioned_epoch = N+1), existing members provisioned_epoch = N+1,
   * envelopes, epoch+1, membership_version+1, member_count+1.
   */
  public async approveRequest(
    ownerId: string,
    requestId: string,
    pkg: PackageInput
  ): Promise<ApproveResult> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();

    return db.runTransaction(async (tx): Promise<ApproveResult> => {
      const requestRef = db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId);
      const requestDoc = await tx.get(requestRef);
      if (!requestDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', 'Pairing request does not exist');
      }
      const request = requestFromDocument(requestDoc.data());
      if (!request) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted pairing request document');

      const channelRef = db.collection(CHANNELS_COLLECTION).doc(request.channel_id);
      const channelDoc = await tx.get(channelRef);
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${request.channel_id} does not exist`);
      }
      const channel = channelDoc.data() as Partial<ChannelEntity>;
      // Package Pattern validation order (API spec §8): owner first → 403 NOT_OWNER
      if (String(channel.owner_device_id ?? '') !== ownerId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can approve requests');
      }
      if (request.status !== 'PENDING') {
        throw new HttpError(409, 'REQUEST_NOT_PENDING', `Request is ${request.status}, not PENDING`);
      }
      if (channel.status !== 'ACTIVE') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }

      // Safety (read-only phase): the requester must not already be ACTIVE —
      // approving twice would corrupt member_count and re-rotate for nothing.
      const requesterMemberDoc = await tx.get(
        db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(request.channel_id, request.requester_device_id))
      );
      const requesterMember = requesterMemberDoc.data() as Partial<ChannelMemberEntity> | undefined;
      if (requesterMemberDoc.exists && requesterMember?.status === 'ACTIVE') {
        throw new HttpError(409, 'ALREADY_MEMBER', 'This device has already joined this channel');
      }

      const pendingRef = db
        .collection(PAIRING_PENDING_COLLECTION)
        .doc(pairingPendingDocId(request.channel_id, request.requester_device_id));

      const membersSnapshot = await tx.get(
        db
          .collection(CHANNEL_MEMBERS_COLLECTION)
          .where('channel_id', '==', request.channel_id)
          .where('status', '==', 'ACTIVE')
      );
      const activeMembers = membersSnapshot.docs.map((doc) => doc.data());

      const newEpoch = Number(channel.current_epoch ?? 1) + 1;
      const expectedSet = [
        String(channel.owner_device_id ?? ''),
        ...activeMembers.map((m) => String(m.device_id ?? '')),
        request.requester_device_id
      ];
      validatePackage(
        { current_epoch: Number(channel.current_epoch ?? 1), membership_version: Number(channel.membership_version ?? 1) },
        pkg,
        expectedSet,
        newEpoch
      );

      tx.update(requestRef, {
        status: 'APPROVED',
        decided_by: ownerId,
        decided_at: now,
        terminal_at: now
      });
      tx.delete(pendingRef);

      tx.set(db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(request.channel_id, request.requester_device_id)), {
        channel_id: request.channel_id,
        device_id: request.requester_device_id,
        device_name: request.requester_device_name,
        public_key: request.requester_public_key,
        status: 'ACTIVE' as MemberStatus,
        joined_epoch: newEpoch,
        provisioned_epoch: newEpoch,
        joined_at: now
      });

      for (const member of activeMembers) {
        tx.update(
          db
            .collection(CHANNEL_MEMBERS_COLLECTION)
            .doc(channelMemberDocId(request.channel_id, String(member.device_id ?? ''))),
          { provisioned_epoch: newEpoch }
        );
      }

      tx.update(channelRef, {
        current_epoch: newEpoch,
        membership_version: Number(channel.membership_version ?? 1) + 1,
        member_count: activeMembers.length + 1,
        updated_at: now
      });

      for (const envelope of pkg.envelopes) {
        tx.set(
          db
            .collection(CHANNEL_KEY_ENVELOPES_COLLECTION)
            .doc(envelopeDocId(request.channel_id, envelope.device_id, newEpoch)),
          {
            channel_id: request.channel_id,
            ...envelopeToDocInput(envelope),
            created_at: now
          }
        );
      }

      return {
        requester_device_id: request.requester_device_id,
        current_epoch: newEpoch,
        membership_version: Number(channel.membership_version ?? 1) + 1
      };
    });
  }

  /**
   * T6 (API spec §5.5): Owner rejects a PENDING request. The QR session is
   * burned (never reusable — SRD 4.1 T6).
   */
  public async rejectRequest(ownerId: string, requestId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();
    await db.runTransaction(async (tx) => {
      const requestRef = db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId);
      const requestDoc = await tx.get(requestRef);
      if (!requestDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', 'Pairing request does not exist');
      }
      const request = requestFromDocument(requestDoc.data());
      if (!request) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted pairing request document');

      const channelDoc = await tx.get(db.collection(CHANNELS_COLLECTION).doc(request.channel_id));
      if (String(channelDoc.data()?.owner_device_id ?? '') !== ownerId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can reject requests');
      }
      if (request.status !== 'PENDING') {
        throw new HttpError(409, 'REQUEST_NOT_PENDING', `Request is ${request.status}, not PENDING`);
      }

      tx.update(requestRef, {
        status: 'REJECTED',
        decided_by: ownerId,
        decided_at: now,
        terminal_at: now
      });
      // Release the dedup marker: the device may claim a fresh QR later
      // (a REJECTED request is not a ban — QR already burned by T6).
      tx.delete(
        db.collection(PAIRING_PENDING_COLLECTION).doc(pairingPendingDocId(request.channel_id, request.requester_device_id))
      );
    });
  }

  /** T6 (API spec §5.6): requester cancels their own PENDING request. */
  public async cancelRequest(requesterDeviceId: string, requestId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();
    await db.runTransaction(async (tx) => {
      const requestRef = db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId);
      const requestDoc = await tx.get(requestRef);
      if (!requestDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', 'Pairing request does not exist');
      }
      const request = requestFromDocument(requestDoc.data());
      if (!request) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted pairing request document');
      if (request.requester_device_id !== requesterDeviceId) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the requester can cancel this request');
      }
      if (request.status !== 'PENDING') {
        throw new HttpError(409, 'REQUEST_NOT_PENDING', `Request is ${request.status}, not PENDING`);
      }

      tx.update(requestRef, {
        status: 'CANCELLED',
        decided_at: now,
        terminal_at: now
      });
      tx.delete(
        db.collection(PAIRING_PENDING_COLLECTION).doc(pairingPendingDocId(request.channel_id, request.requester_device_id))
      );
    });
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    for (const name of [PAIRING_SESSIONS_COLLECTION, PAIRING_REQUESTS_COLLECTION, PAIRING_PENDING_COLLECTION]) {
      const snapshot = await db.collection(name).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
  }
}

export const pairingV2Service = new PairingV2Service();
