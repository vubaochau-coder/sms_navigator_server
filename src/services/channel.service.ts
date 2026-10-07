import { randomUUID } from 'crypto';
import {
  ChannelEntity,
  ChannelKeyEnvelopeEntity,
  ChannelMemberEntity,
  ChannelRole,
  ChannelStatus,
  KEK_ALG,
  MemberStatus,
  PackageInput
} from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { DeviceEntity } from '../types/index.js';
import { DEVICES_COLLECTION } from './device.service.js';

export const CHANNELS_COLLECTION = 'channels';
export const CHANNEL_MEMBERS_COLLECTION = 'channel_members';
export const CHANNEL_KEY_ENVELOPES_COLLECTION = 'channel_key_envelopes';

/** Document id per SRD 3.3: `{channelId}__{deviceId}` (double underscore). */
export function channelMemberDocId(channelId: string, deviceId: string): string {
  return `${channelId}__${deviceId}`;
}

/** Document id per SRD 3.6: `{channelId}__{deviceId}__{epoch}`. */
export function envelopeDocId(channelId: string, deviceId: string, epoch: number): string {
  return `${channelId}__${deviceId}__${epoch}`;
}

function channelFromDocument(id: string, data: Record<string, unknown> | undefined): ChannelEntity | null {
  if (!data || typeof data.name !== 'string') return null;
  return {
    channel_id: typeof data.channel_id === 'string' ? data.channel_id : id,
    owner_device_id: String(data.owner_device_id ?? ''),
    name: data.name,
    current_epoch: Number(data.current_epoch ?? 1),
    membership_version: Number(data.membership_version ?? 1),
    sequence_counter: Number(data.sequence_counter ?? 0),
    member_count: Number(data.member_count ?? 1),
    status: data.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    created_at: String(data.created_at ?? nowIso()),
    updated_at: String(data.updated_at ?? nowIso())
  };
}

function memberFromDocument(data: Record<string, unknown> | undefined): ChannelMemberEntity | null {
  if (!data || typeof data.device_id !== 'string' || typeof data.channel_id !== 'string') return null;
  return {
    channel_id: data.channel_id,
    device_id: data.device_id,
    device_name: String(data.device_name ?? ''),
    public_key: String(data.public_key ?? ''),
    status: data.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    joined_epoch: Number(data.joined_epoch ?? 1),
    provisioned_epoch: Number(data.provisioned_epoch ?? data.joined_epoch ?? 1),
    joined_at: String(data.joined_at ?? nowIso()),
    revoked_at: data.revoked_at as string | undefined
  };
}

function envelopeFromDocument(data: Record<string, unknown> | undefined): ChannelKeyEnvelopeEntity | null {
  if (!data || typeof data.wrapped_key !== 'string') return null;
  return {
    channel_id: String(data.channel_id ?? ''),
    device_id: String(data.device_id ?? ''),
    key_epoch: Number(data.key_epoch ?? 0),
    wrapped_key: data.wrapped_key,
    nonce: String(data.nonce ?? ''),
    kek_alg: String(data.kek_alg ?? KEK_ALG),
    created_at: String(data.created_at ?? nowIso()),
    fetched_at: data.fetched_at as string | undefined
  };
}

export function envelopeToDocInput(envelope: {
  device_id: string;
  key_epoch: number;
  wrapped_key: string;
  nonce: string;
  kek_alg: string;
}): Record<string, unknown> {
  return {
    device_id: envelope.device_id,
    key_epoch: envelope.key_epoch,
    wrapped_key: envelope.wrapped_key,
    nonce: envelope.nonce,
    kek_alg: envelope.kek_alg
  };
}

export interface ChannelListItem {
  channel_id: string;
  name: string;
  role: ChannelRole;
  status: ChannelStatus;
  current_epoch: number;
  membership_version: number;
  member_count: number;
  my_joined_epoch: number;
  owner_device_name: string;
}

/**
 * Package Pattern structural validation shared by T0/T2/T4 (API spec §8).
 * Purely structural — the server never derives/opens keys (KL1/KL2):
 * 1. caller == owner → 403 NOT_OWNER (checked by the callers)
 * 2. optimistic lock on (base_epoch, base_membership_version) → 409 MEMBERSHIP_CHANGED
 * 3. envelope set == expected device set && every key_epoch == newEpoch
 *    → 422 PACKAGE_INCOMPLETE
 */
export function validatePackage(
  channel: { current_epoch: number; membership_version: number },
  pkg: PackageInput,
  expectedDeviceIds: string[],
  newEpoch: number
): void {
  if (pkg.base_epoch !== channel.current_epoch || pkg.base_membership_version !== channel.membership_version) {
    throw new HttpError(
      409,
      'MEMBERSHIP_CHANGED',
      `Package snapshot (epoch ${pkg.base_epoch}, version ${pkg.base_membership_version}) is stale; current is (epoch ${channel.current_epoch}, version ${channel.membership_version})`
    );
  }

  const expected = new Set(expectedDeviceIds);
  const provided = new Set<string>();
  for (const envelope of pkg.envelopes) {
    if (provided.has(envelope.device_id)) {
      throw new HttpError(422, 'PACKAGE_INCOMPLETE', `Duplicate envelope for device ${envelope.device_id}`);
    }
    provided.add(envelope.device_id);
    if (envelope.key_epoch !== newEpoch) {
      throw new HttpError(
        422,
        'PACKAGE_INCOMPLETE',
        `Envelope for ${envelope.device_id} has key_epoch ${envelope.key_epoch}, expected ${newEpoch}`
      );
    }
  }
  const missing = [...expected].filter((id) => !provided.has(id));
  const extra = [...provided].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new HttpError(
      422,
      'PACKAGE_INCOMPLETE',
      `Envelope set mismatch. Missing: [${missing.join(', ')}]. Unexpected: [${extra.join(', ')}]`
    );
  }
}

export class ChannelService {
  /**
   * T0 (API spec §4.1): create channel from the Owner package.
   * Validates: caller == envelopes[0].device_id, key_epoch == 1, envelope set
   * == {Owner} (KL1–KL4). Commits channel + Owner member doc + self-envelope.
   * `requestedChannelId` (optional, client UUID) lets the Owner wrap envelopes
   * with the real channel AAD before knowing the id; if taken → 409 conflict.
   */
  public async createChannel(
    owner: DeviceEntity,
    name: string,
    pkg: PackageInput,
    requestedChannelId?: string
  ): Promise<ChannelEntity> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    // Structural validation before touching Firestore
    if (pkg.base_epoch !== 1 || pkg.base_membership_version !== 1) {
      throw new HttpError(422, 'PACKAGE_INCOMPLETE', 'Create-channel package must snapshot epoch 1 / version 1');
    }
    validatePackage(
      { current_epoch: 1, membership_version: 1 },
      pkg,
      [owner.device_id],
      1
    );

    const channelId = requestedChannelId ?? randomUUID();
    const existing = await db.collection(CHANNELS_COLLECTION).doc(channelId).get();
    if (existing.exists) {
      throw new HttpError(409, 'CHANNEL_ID_TAKEN', 'A channel with this id already exists');
    }

    const now = nowIso();
    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
    const memberRef = db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, owner.device_id));

    const channel: ChannelEntity = {
      channel_id: channelId,
      owner_device_id: owner.device_id,
      name,
      current_epoch: 1,
      membership_version: 1,
      sequence_counter: 0,
      member_count: 1,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now
    };

    await db.runTransaction(async (tx) => {
      tx.set(channelRef, { ...channel });
      tx.set(memberRef, {
        channel_id: channelId,
        device_id: owner.device_id,
        device_name: owner.device_name ?? '',
        public_key: owner.public_key ?? '',
        status: 'ACTIVE' as MemberStatus,
        joined_epoch: 1,
        provisioned_epoch: 1,
        joined_at: now
      });
      for (const envelope of pkg.envelopes) {
        tx.set(
          db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(channelId, envelope.device_id, 1)),
          {
            channel_id: channelId,
            ...envelopeToDocInput(envelope),
            created_at: now
          }
        );
      }
    });

    return channel;
  }

  public async findChannelById(channelId: string): Promise<ChannelEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const doc = await db.collection(CHANNELS_COLLECTION).doc(channelId).get();
    if (!doc.exists) return null;
    return channelFromDocument(doc.id, doc.data());
  }

  public async getMember(channelId: string, deviceId: string): Promise<ChannelMemberEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const doc = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .doc(channelMemberDocId(channelId, deviceId))
      .get();
    if (!doc.exists) return null;
    return memberFromDocument(doc.data());
  }

  public async listMembers(channelId: string): Promise<ChannelMemberEntity[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const snapshot = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .where('channel_id', '==', channelId)
      .get();

    return snapshot.docs
      .map((doc) => memberFromDocument(doc.data()))
      .filter((member): member is ChannelMemberEntity => member !== null)
      .sort((a, b) => a.joined_epoch - b.joined_epoch || a.joined_at.localeCompare(b.joined_at));
  }

  public async listActiveMembers(channelId: string): Promise<ChannelMemberEntity[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const snapshot = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .where('channel_id', '==', channelId)
      .where('status', '==', 'ACTIVE')
      .get();

    return snapshot.docs
      .map((doc) => memberFromDocument(doc.data()))
      .filter((member): member is ChannelMemberEntity => member !== null)
      .sort((a, b) => a.joined_epoch - b.joined_epoch || a.joined_at.localeCompare(b.joined_at));
  }

  /** Q2: all channels the device is an ACTIVE member of (owner included). */
  public async listChannelsForDevice(device: DeviceEntity): Promise<ChannelListItem[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const membershipSnapshot = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .where('device_id', '==', device.device_id)
      .where('status', '==', 'ACTIVE')
      .get();

    const memberships = membershipSnapshot.docs
      .map((doc) => memberFromDocument(doc.data()))
      .filter((member): member is ChannelMemberEntity => member !== null);
    if (memberships.length === 0) return [];

    // Batched reads: channels of interest, then their owners (no N+1 loops)
    const channelIds = [...new Set(memberships.map((membership) => membership.channel_id))];
    const channelDocs = await Promise.all(
      channelIds.map((id) => db.collection(CHANNELS_COLLECTION).doc(id).get())
    );
    const channels = channelDocs
      .map((doc) => channelFromDocument(doc.id, doc.data()))
      .filter((channel): channel is ChannelEntity => channel !== null && channel.status === 'ACTIVE');
    if (channels.length === 0) return [];

    const ownerIds = [...new Set(channels.map((channel) => channel.owner_device_id))];
    const ownerDocs = await Promise.all(
      ownerIds.map((id) => db.collection(DEVICES_COLLECTION).doc(id).get())
    );
    const ownerNameById = new Map<string, string>();
    for (const doc of ownerDocs) {
      ownerNameById.set(doc.id, String(doc.data()?.device_name ?? ''));
    }
    const channelById = new Map(channels.map((channel) => [channel.channel_id, channel]));

    const items: ChannelListItem[] = [];
    for (const membership of memberships) {
      const channel = channelById.get(membership.channel_id);
      if (!channel) continue;
      items.push({
        channel_id: channel.channel_id,
        name: channel.name,
        role: channel.owner_device_id === device.device_id ? 'OWNER' : 'MEMBER',
        status: channel.status,
        current_epoch: channel.current_epoch,
        membership_version: channel.membership_version,
        member_count: channel.member_count,
        my_joined_epoch: membership.joined_epoch,
        owner_device_name: ownerNameById.get(channel.owner_device_id) ?? ''
      });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Authorization guard for channel-scoped reads (KL12): membership ACTIVE is
   * the source of truth. Unknown channel / never-a-member → 404, revoked → 403.
   */
  public async requireActiveMember(channelId: string, deviceId: string): Promise<ChannelMemberEntity> {
    const channel = await this.findChannelById(channelId);
    if (!channel) {
      throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
    }
    const member = await this.getMember(channelId, deviceId);
    if (!member) {
      throw new HttpError(404, 'NOT_FOUND', 'You are not a member of this channel');
    }
    if (member.status !== 'ACTIVE') {
      throw new HttpError(403, 'REVOKED', 'Your membership in this channel has been revoked');
    }
    return member;
  }

  public async requireOwner(channelId: string, deviceId: string): Promise<ChannelEntity> {
    const channel = await this.findChannelById(channelId);
    if (!channel) {
      throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
    }
    if (channel.owner_device_id !== deviceId) {
      throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can perform this operation');
    }
    return channel;
  }

  /**
   * Rename fan-out (API spec §3.3) in a single transaction:
   * devices.device_name + channel_members (ACTIVE) + pairing_requests (PENDING).
   * Display-only — no key rotation, no epoch/membership_version change.
   */
  public async renameDeviceEverywhere(deviceId: string, deviceName: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const now = nowIso();

    await db.runTransaction(async (tx) => {
      // All reads must precede writes (Firestore transaction invariant)
      const deviceRef = db.collection(DEVICES_COLLECTION).doc(deviceId);
      const deviceDoc = await tx.get(deviceRef);

      const memberships = await tx.get(
        db
          .collection(CHANNEL_MEMBERS_COLLECTION)
          .where('device_id', '==', deviceId)
          .where('status', '==', 'ACTIVE')
      );

      const pendingRequests = await tx.get(
        db
          .collection('pairing_requests')
          .where('requester_device_id', '==', deviceId)
          .where('status', '==', 'PENDING')
      );

      // Fan-out to pending requests of channels owned by this device
      const ownedChannels = await tx.get(
        db
          .collection(CHANNELS_COLLECTION)
          .where('owner_device_id', '==', deviceId)
      );

      const ownerPendingSnapshots = await Promise.all(
        ownedChannels.docs.map((doc) =>
          tx.get(
            db
              .collection('pairing_requests')
              .where('channel_id', '==', doc.id)
              .where('status', '==', 'PENDING')
          )
        )
      );

      // Writes executed after all reads have completed
      if (deviceDoc.exists) {
        tx.update(deviceRef, { device_name: deviceName, last_seen_at: now });
      }

      for (const doc of memberships.docs) {
        tx.update(doc.ref, { device_name: deviceName });
      }

      for (const doc of pendingRequests.docs) {
        tx.update(doc.ref, { requester_device_name: deviceName });
      }

      for (const snap of ownerPendingSnapshots) {
        for (const doc of snap.docs) {
          tx.update(doc.ref, { owner_device_name: deviceName });
        }
      }
    });
  }

  /**
   * GET /channels/key-envelope (API spec §6.1): envelope of the caller for the
   * given epoch; `epoch` omitted → highest provisioned epoch ("latest" mode,
   * SRD 7.3 recovery). 403 REVOKED per KL12; 404 if never provisioned (KL8).
   */
  public async getKeyEnvelope(
    channelId: string,
    deviceId: string,
    epoch: number | undefined
  ): Promise<ChannelKeyEnvelopeEntity> {
    const member = await this.requireActiveMember(channelId, deviceId);
    const targetEpoch = epoch ?? member.provisioned_epoch ?? 0;
    if (targetEpoch < 1) {
      throw new HttpError(404, 'NOT_FOUND', 'No key envelope has been provisioned for you on this channel');
    }

    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const ref = db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(channelId, deviceId, targetEpoch));
    const doc = await ref.get();
    if (!doc.exists) {
      throw new HttpError(404, 'NOT_FOUND', `No key envelope for epoch ${targetEpoch} (KL8)`);
    }

    const envelope = envelopeFromDocument(doc.data());
    if (!envelope) {
      throw new HttpError(500, 'SERVER_ERROR', 'Corrupted key envelope document');
    }

    if (!envelope.fetched_at) {
      // Idempotent fetch: only the first fetch stamps fetched_at (SRD 3.6)
      const stamped = nowIso();
      await ref.update({ fetched_at: stamped });
      envelope.fetched_at = stamped;
    }
    return envelope;
  }

  /**
   * T4 (API spec §4.6): revoke members + rotate epoch, one atomic package.
   * Envelope set must exactly cover {Owner} ∪ {ACTIVE remaining} at epoch N+1
   * (KL8). Revocation is terminal; auto-rotate in the same transaction (SRD 8.3).
   */
  public async revokeMembers(
    ownerId: string,
    channelId: string,
    revokeDeviceIds: string[],
    pkg: PackageInput
  ): Promise<{ current_epoch: number; membership_version: number; revoked: string[]; channel_name: string }> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();

    return db.runTransaction(async (tx) => {
      const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
      const channelDoc = await tx.get(channelRef);
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const channel = channelFromDocument(channelDoc.id, channelDoc.data());
      if (!channel) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted channel document');
      if (channel.owner_device_id !== ownerId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can revoke members');
      }
      if (channel.status !== 'ACTIVE') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }

      const targets = new Set(revokeDeviceIds);
      if (targets.has(channel.owner_device_id)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'The channel owner cannot be revoked');
      }

      const membersSnapshot = await tx.get(
        db
          .collection(CHANNEL_MEMBERS_COLLECTION)
          .where('channel_id', '==', channelId)
          .where('status', '==', 'ACTIVE')
      );
      const activeMembers = membersSnapshot.docs
        .map((doc) => memberFromDocument(doc.data()))
        .filter((member): member is ChannelMemberEntity => member !== null);

      const revoked: string[] = [];
      const remaining: ChannelMemberEntity[] = [];
      for (const member of activeMembers) {
        if (targets.has(member.device_id)) {
          revoked.push(member.device_id);
        } else {
          remaining.push(member);
        }
      }
      if (revoked.length !== targets.size) {
        const missing = [...targets].filter((id) => !revoked.includes(id));
        throw new HttpError(404, 'NOT_FOUND', `Target devices are not ACTIVE members: ${missing.join(', ')}`);
      }

      const newEpoch = channel.current_epoch + 1;
      const expectedSet = [channel.owner_device_id, ...remaining.map((m) => m.device_id)];
      validatePackage(channel, pkg, expectedSet, newEpoch);

      for (const member of activeMembers) {
        if (!targets.has(member.device_id)) continue;
        tx.update(db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, member.device_id)), {
          status: 'REVOKED' as MemberStatus,
          revoked_at: now
        });
      }
      for (const member of remaining) {
        tx.update(db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, member.device_id)), {
          provisioned_epoch: newEpoch
        });
      }

      tx.update(channelRef, {
        current_epoch: newEpoch,
        membership_version: channel.membership_version + 1,
        member_count: remaining.length,
        updated_at: now
      });

      for (const envelope of pkg.envelopes) {
        tx.set(
          db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(channelId, envelope.device_id, newEpoch)),
          {
            channel_id: channelId,
            ...envelopeToDocInput(envelope),
            created_at: now
          }
        );
      }

      return {
        current_epoch: newEpoch,
        membership_version: channel.membership_version + 1,
        revoked,
        channel_name: channel.name
      };
    });
  }

  public async clearAll(): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    for (const name of [CHANNELS_COLLECTION, CHANNEL_MEMBERS_COLLECTION, CHANNEL_KEY_ENVELOPES_COLLECTION]) {
      const snapshot = await db.collection(name).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
  }
}

export const channelService = new ChannelService();
