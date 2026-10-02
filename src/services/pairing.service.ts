import { randomBytes, randomUUID } from 'crypto';
import { PairingRequestEntity, PairingSessionEntity, RequestStatus, SessionStatus } from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso, msToIso, isoToMs } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { sha256Hex } from './device.service.js';
import { DeviceEntity } from '../types/index.js';
import {
  CHANNELS_COLLECTION,
  CHANNEL_MEMBERS_COLLECTION,
  CHANNEL_KEY_ENVELOPES_COLLECTION,
  ChannelService,
  channelService,
  EnvelopeInput,
  channelMemberDocId
} from './channel.service.js';

export const PAIRING_SESSIONS_COLLECTION = 'pairing_sessions';
export const PAIRING_REQUESTS_COLLECTION = 'pairing_requests';

/** Server-enforced QR window: single-use + TTL 10 minutes (SRD 3.4 / N5). */
export const PAIRING_SESSION_TTL_MS = 10 * 60 * 1000;

function sessionFromDocument(id: string, data: Record<string, unknown> | undefined): PairingSessionEntity | null {
  if (!data || typeof data.channel_id !== 'string') return null;
  return {
    session_id: typeof data.session_id === 'string' ? data.session_id : id,
    channel_id: data.channel_id,
    token: '',
    token_hash: String(data.token_hash ?? ''),
    owner_device_id: String(data.owner_device_id ?? ''),
    status: (data.status as SessionStatus) ?? 'UNUSED',
    created_at: String(data.created_at ?? nowIso()),
    expires_at: String(data.expires_at ?? nowIso())
  };
}

function requestFromDocument(id: string, data: Record<string, unknown> | undefined): PairingRequestEntity | null {
  if (!data || typeof data.channel_id !== 'string' || typeof data.requester_device_id !== 'string') return null;
  return {
    request_id: typeof data.request_id === 'string' ? data.request_id : id,
    channel_id: data.channel_id,
    session_id: String(data.session_id ?? ''),
    requester_device_id: data.requester_device_id,
    requester_device_name: String(data.requester_device_name ?? ''),
    requester_public_key: String(data.requester_public_key ?? ''),
    status: (data.status as RequestStatus) ?? 'PENDING',
    created_at: String(data.created_at ?? nowIso()),
    responded_at: data.responded_at as string | undefined
  };
}

export interface CreatedSession {
  session_id: string;
  channel_id: string;
  token: string;
  expires_at: string;
}

export interface ClaimedRequest {
  request_id: string;
  channel_id: string;
  channel_name: string;
  owner_device_name: string;
}

export class PairingService {
  constructor(private readonly channels: ChannelService = channelService) {}

  /** Owner creates a single-use QR session (CSPRNG 128-bit token, TTL 10 min). */
  public async createSession(owner: DeviceEntity, channelId: string): Promise<CreatedSession> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const channel = await this.channels.requireOwner(channelId, owner.device_id);
    if (!channel.is_active) {
      throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
    }

    const sessionId = randomUUID();
    // 128-bit CSPRNG token; only its SHA-256 hash is ever stored
    const token = randomBytes(16).toString('hex');
    const now = nowIso();

    await db.collection(PAIRING_SESSIONS_COLLECTION).doc(sessionId).set({
      session_id: sessionId,
      channel_id: channelId,
      token_hash: sha256Hex(token),
      owner_device_id: owner.device_id,
      status: 'UNUSED' as SessionStatus,
      created_at: now,
      expires_at: msToIso(Date.now() + PAIRING_SESSION_TTL_MS)
    });

    return {
      session_id: sessionId,
      channel_id: channelId,
      token,
      expires_at: msToIso(Date.now() + PAIRING_SESSION_TTL_MS)
    };
  }

  public async findSessionById(sessionId: string): Promise<PairingSessionEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;
    const doc = await db.collection(PAIRING_SESSIONS_COLLECTION).doc(sessionId).get();
    if (!doc.exists) return null;
    return sessionFromDocument(doc.id, doc.data());
  }

  /**
   * T1 (Member claim): pairing_sessions UNUSED + not expired → CLAIMED and a
   * PENDING pairing request is created, atomically.
   */
  public async claimSession(
    caller: DeviceEntity,
    token: string,
    encryptedDeviceName?: string
  ): Promise<ClaimedRequest> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const tokenHash = sha256Hex(token);

    return db.runTransaction(async (tx): Promise<ClaimedRequest> => {
      const sessionSnapshot = await tx.get(
        db.collection(PAIRING_SESSIONS_COLLECTION).where('token_hash', '==', tokenHash).limit(1)
      );
      if (sessionSnapshot.empty) {
        throw new HttpError(404, 'NOT_FOUND', 'Invalid or unknown pairing token');
      }
      const session = sessionFromDocument(sessionSnapshot.docs[0].id, sessionSnapshot.docs[0].data());
      if (!session) {
        throw new HttpError(404, 'NOT_FOUND', 'Invalid or unknown pairing token');
      }

      const channelDoc = await tx.get(db.collection(CHANNELS_COLLECTION).doc(session.channel_id));
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', 'The channel of this pairing session no longer exists');
      }
      const channelName = String(channelDoc.data()?.channel_name ?? '');
      const ownerDeviceId = String(channelDoc.data()?.owner_device_id ?? '');
      const isActive = channelDoc.data()?.is_active !== false;

      if (!isActive) {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }
      if (session.status === 'CLAIMED') {
        throw new HttpError(409, 'QR_ALREADY_USED', 'This pairing QR has already been claimed');
      }
      if (session.status === 'EXPIRED' || isoToMs(session.expires_at) <= Date.now()) {
        tx.update(sessionSnapshot.docs[0].ref, { status: 'EXPIRED' as SessionStatus });
        throw new HttpError(410, 'QR_EXPIRED', 'This pairing QR has expired. Ask the owner for a new one.');
      }
      if (ownerDeviceId === caller.device_id) {
        throw new HttpError(409, 'ALREADY_MEMBER', 'The channel owner cannot join their own channel');
      }

      const existingMember = await tx.get(
        db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(session.channel_id, caller.device_id))
      );
      if (existingMember.exists) {
        const status = String(existingMember.data()?.status ?? '');
        if (status === 'ACTIVE') {
          throw new HttpError(409, 'ALREADY_MEMBER', 'You are already an ACTIVE member of this channel');
        }
        // REVOKED membership is terminal (SRD 3.3) - re-joining is not allowed
        throw new HttpError(409, 'MEMBERSHIP_CHANGED', 'Your previous membership was revoked and cannot be restored');
      }

      const ownerDeviceDoc = await tx.get(db.collection('devices').doc(ownerDeviceId));
      const ownerDeviceName = String(ownerDeviceDoc.data()?.device_name ?? '');

      const requestId = randomUUID();
      const now = nowIso();

      tx.update(sessionSnapshot.docs[0].ref, {
        status: 'CLAIMED' as SessionStatus,
        claimed_by_device_id: caller.device_id,
        request_id: requestId
      });

      tx.set(db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId), {
        request_id: requestId,
        channel_id: session.channel_id,
        session_id: session.session_id,
        requester_device_id: caller.device_id,
        requester_device_name: encryptedDeviceName || caller.device_name || '',
        requester_public_key: caller.public_key ?? '',
        status: 'PENDING' as RequestStatus,
        created_at: now
      });

      return {
        request_id: requestId,
        channel_id: session.channel_id,
        channel_name: channelName,
        owner_device_name: ownerDeviceName
      };
    });
  }

  /** Q1: approval queue of one channel, newest first. */
  public async listRequests(channelId: string, status: RequestStatus): Promise<PairingRequestEntity[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const snapshot = await db
      .collection(PAIRING_REQUESTS_COLLECTION)
      .where('channel_id', '==', channelId)
      .where('status', '==', status)
      .get();

    return snapshot.docs
      .map((doc) => requestFromDocument(doc.id, doc.data()))
      .filter((request): request is PairingRequestEntity => request !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  public async findRequestById(requestId: string): Promise<PairingRequestEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;
    const doc = await db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId).get();
    if (!doc.exists) return null;
    return requestFromDocument(doc.id, doc.data());
  }

  /**
   * T2 (Owner package, rotate): request PENDING → APPROVED, requester becomes
   * ACTIVE member at `new_epoch`, envelope set is validated against
   * {Owner} ∪ {ACTIVE before txn} ∪ {Requester} (KL3/KL8), epoch rotates.
   */
  public async approveRequest(
    ownerId: string,
    channelId: string,
    requestId: string,
    newEpoch: number,
    envelopes: EnvelopeInput[]
  ): Promise<{ requester_device_id: string; current_epoch: number }> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();

    return db.runTransaction(async (tx) => {
      const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
      const channelDoc = await tx.get(channelRef);
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const ownerDeviceId = String(channelDoc.data()?.owner_device_id ?? '');
      const isActive = channelDoc.data()?.is_active !== false;
      const currentEpoch = Number(channelDoc.data()?.current_epoch ?? 1);
      if (ownerDeviceId !== ownerId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can approve pairing requests');
      }
      if (!isActive) {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }
      if (newEpoch !== currentEpoch + 1) {
        throw new HttpError(409, 'MEMBERSHIP_CHANGED', `new_epoch must be ${currentEpoch + 1}`);
      }

      const requestRef = db.collection(PAIRING_REQUESTS_COLLECTION).doc(requestId);
      const requestDoc = await tx.get(requestRef);
      if (!requestDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Pairing request ${requestId} does not exist`);
      }
      const request = requestFromDocument(requestDoc.id, requestDoc.data());
      if (!request || request.channel_id !== channelId) {
        throw new HttpError(404, 'NOT_FOUND', `Pairing request ${requestId} does not exist`);
      }
      if (request.status !== 'PENDING') {
        throw new HttpError(409, 'REQUEST_NOT_PENDING', 'This pairing request is no longer pending');
      }

      const requesterMemberDoc = await tx.get(
        db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, request.requester_device_id))
      );
      if (requesterMemberDoc.exists) {
        throw new HttpError(409, 'MEMBERSHIP_CHANGED', 'The requester already has a membership record');
      }

      const activeSnapshot = await tx.get(
        db
          .collection(CHANNEL_MEMBERS_COLLECTION)
          .where('channel_id', '==', channelId)
          .where('status', '==', 'ACTIVE')
      );
      const activeMembers = activeSnapshot.docs
        .map((doc) => ({ id: doc.id, device_id: String(doc.data()?.device_id ?? '') }))
        .filter((member) => member.device_id !== '');

      // KL3: envelope set must be {Owner} ∪ {ACTIVE before txn} ∪ {Requester}
      const expected = new Set(activeMembers.map((member) => member.device_id));
      expected.add(request.requester_device_id);
      const provided = new Set(envelopes.map((envelope) => envelope.device_id));
      if (
        provided.size !== envelopes.length ||
        provided.size !== expected.size ||
        [...expected].some((id) => !provided.has(id))
      ) {
        throw new HttpError(
          422,
          'PACKAGE_INCOMPLETE',
          'envelopes must cover exactly {Owner} ∪ {ACTIVE members} ∪ {requester} for the new epoch'
        );
      }

      tx.update(channelRef, {
        current_epoch: newEpoch,
        member_count: activeMembers.length + 1,
        updated_at: now
      });

      const requesterDeviceDoc = await tx.get(db.collection('devices').doc(request.requester_device_id));
      const requesterPublicKey = String(requesterDeviceDoc.data()?.public_key ?? '');

      tx.set(db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, request.requester_device_id)), {
        id: channelMemberDocId(channelId, request.requester_device_id),
        channel_id: channelId,
        device_id: request.requester_device_id,
        device_name: request.requester_device_name,
        public_key: requesterPublicKey || request.requester_public_key,
        role: 'member',
        status: 'ACTIVE',
        joined_epoch: newEpoch,
        joined_at: now,
        updated_at: now
      });

      for (const envelope of envelopes) {
        tx.set(
          db
            .collection(CHANNEL_KEY_ENVELOPES_COLLECTION)
            .doc(`${channelId}__${envelope.device_id}__${newEpoch}`),
          {
            id: `${channelId}__${envelope.device_id}__${newEpoch}`,
            channel_id: channelId,
            device_id: envelope.device_id,
            epoch: newEpoch,
            encrypted_key: envelope.encrypted_key,
            iv: envelope.iv,
            sender_ephemeral_pubkey: envelope.sender_ephemeral_pubkey,
            created_at: now
          }
        );
      }

      tx.update(requestRef, {
        status: 'APPROVED' as RequestStatus,
        decided_by: ownerId,
        responded_at: now
      });

      return { requester_device_id: request.requester_device_id, current_epoch: newEpoch };
    });
  }

  /** T6 (Owner): PENDING → REJECTED. */
  public async rejectRequest(ownerId: string, channelId: string, requestId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    await this.channels.requireOwner(channelId, ownerId);
    const request = await this.findRequestById(requestId);
    if (!request || request.channel_id !== channelId) {
      throw new HttpError(404, 'NOT_FOUND', `Pairing request ${requestId} does not exist`);
    }
    if (request.status !== 'PENDING') {
      throw new HttpError(409, 'REQUEST_NOT_PENDING', 'This pairing request is no longer pending');
    }

    await db
      .collection(PAIRING_REQUESTS_COLLECTION)
      .doc(requestId)
      .update({ status: 'REJECTED' as RequestStatus, decided_by: ownerId, responded_at: nowIso() });
  }

  /** T6 (requester only): PENDING → CANCELLED. */
  public async cancelRequest(callerId: string, channelId: string, requestId: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const request = await this.findRequestById(requestId);
    if (!request || request.channel_id !== channelId) {
      throw new HttpError(404, 'NOT_FOUND', `Pairing request ${requestId} does not exist`);
    }
    if (request.requester_device_id !== callerId) {
      throw new HttpError(403, 'FORBIDDEN', 'Only the requester can cancel this pairing request');
    }
    if (request.status !== 'PENDING') {
      throw new HttpError(409, 'REQUEST_NOT_PENDING', 'This pairing request is no longer pending');
    }

    await db
      .collection(PAIRING_REQUESTS_COLLECTION)
      .doc(requestId)
      .update({ status: 'CANCELLED' as RequestStatus, responded_at: nowIso() });
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    for (const name of [PAIRING_SESSIONS_COLLECTION, PAIRING_REQUESTS_COLLECTION]) {
      const snapshot = await db.collection(name).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
  }
}

export const pairingService = new PairingService();
