import { randomUUID } from 'crypto';
import {
  ChannelEntity,
  ChannelKeyEnvelopeEntity,
  ChannelMemberEntity,
  ChannelRole,
  ChannelStatus,
  ChannelWhitelistBlob,
  KEK_ALG,
  MemberStatus,
  PackageInput
} from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { DeviceEntity } from '../types/index.js';
import { assertNotProduction } from '../utils/test-only.js';
import { channelMembershipService } from './channel-membership.service.js';
import {
  DEVICES_COLLECTION,
  CHANNELS_COLLECTION,
  CHANNEL_MEMBERS_COLLECTION,
  CHANNEL_KEY_ENVELOPES_COLLECTION,
  PAIRING_REQUESTS_COLLECTION,
  PAIRING_SESSIONS_COLLECTION,
  PAIRING_PENDING_COLLECTION,
  channelMemberDocId,
  envelopeDocId,
  pairingPendingDocId
} from './collections.js';

// Re-exported for existing importers (tests, other services).
export { CHANNELS_COLLECTION, CHANNEL_MEMBERS_COLLECTION, CHANNEL_KEY_ENVELOPES_COLLECTION, channelMemberDocId, envelopeDocId };

export interface KeyEnvelopeItem {
  key_epoch: number;
  wrapped_key: string;
  nonce: string;
  kek_alg: string;
}

export interface DeviceKeyEnvelopes {
  channel_id: string;
  current_epoch: number;
  owner_public_key: string;
  envelopes: KeyEnvelopeItem[];
}

function channelFromDocument(id: string, data: Record<string, unknown> | undefined): ChannelEntity | null {
  if (!data || typeof data.name !== 'string') return null;
  const rawWhitelist = data.whitelist as Record<string, unknown> | undefined;
  let whitelist: ChannelWhitelistBlob | undefined = undefined;
  if (
    rawWhitelist &&
    typeof rawWhitelist.ciphertext === 'string' &&
    typeof rawWhitelist.nonce === 'string'
  ) {
    whitelist = {
      key_epoch: Number(rawWhitelist.key_epoch ?? 1),
      ciphertext: rawWhitelist.ciphertext,
      nonce: rawWhitelist.nonce,
      whitelist_version: Number(rawWhitelist.whitelist_version ?? 1),
      updated_at: String(rawWhitelist.updated_at ?? nowIso())
    };
  }
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
    updated_at: String(data.updated_at ?? nowIso()),
    whitelist,
    rotation_pending: data.rotation_pending === true,
    archived_at: data.archived_at as string | undefined
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
  /** Opaque E2EE blob (server never reads it) so the list can show whitelist chips. */
  whitelist: ChannelWhitelistBlob | null;
  /**
   * A member left and the Owner still has to rotate. Lets the Owner's relay
   * sync skip `GET /channels/detail` per channel on every run (FLOW_AUDIT P2).
   */
  rotation_pending: boolean;
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
      `Package snapshot (epoch ${pkg.base_epoch}, version ${pkg.base_membership_version}) is stale; current is (epoch ${channel.current_epoch}, version ${channel.membership_version})`,
      { current_epoch: channel.current_epoch, membership_version: channel.membership_version }
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
        owner_device_name: ownerNameById.get(channel.owner_device_id) ?? '',
        whitelist: channel.whitelist ?? null,
        rotation_pending: channel.rotation_pending === true
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
          .collection(PAIRING_REQUESTS_COLLECTION)
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
              .collection(PAIRING_REQUESTS_COLLECTION)
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
   * PUT /channels/name (API spec §4.8): Owner renames the channel. Display-only
   * metadata — no epoch / membership_version change, no key rotation. Pending
   * requests and channel lists read the name live, so nothing else to fan out.
   */
  public async renameChannel(channelId: string, callerDeviceId: string, name: string): Promise<ChannelEntity> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
    const now = nowIso();

    return db.runTransaction(async (tx) => {
      const doc = await tx.get(channelRef);
      if (!doc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const channel = channelFromDocument(doc.id, doc.data());
      if (!channel) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted channel document');
      if (channel.owner_device_id !== callerDeviceId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can rename the channel');
      }
      if (channel.status !== 'ACTIVE') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }

      tx.update(channelRef, { name, updated_at: now });
      return { ...channel, name, updated_at: now };
    });
  }

  /**
   * GET /key-envelopes (API spec §6.1b): every envelope of the caller, grouped
   * by channel, in one call — replaces `detail + key-envelope` per channel and
   * per epoch on the client (FLOW_AUDIT K1/K2, N+1).
   *
   * - Only channels the caller is ACTIVE in (KL12); revoked channels are
   *   simply absent.
   * - Only epochs >= the caller's `joined_epoch` (a re-joined member does not
   *   get the envelopes of a previous membership back) — and only envelopes
   *   that exist for this device, so nothing beyond KL8.
   * - Each channel carries `owner_public_key` (needed to unwrap: ECDH with the
   *   owner) and `current_epoch`.
   */
  public async listKeyEnvelopesForDevice(deviceId: string, channelId?: string): Promise<DeviceKeyEnvelopes[]> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    let memberships: ChannelMemberEntity[];
    if (channelId) {
      memberships = [await this.requireActiveMember(channelId, deviceId)];
    } else {
      const snapshot = await db
        .collection(CHANNEL_MEMBERS_COLLECTION)
        .where('device_id', '==', deviceId)
        .where('status', '==', 'ACTIVE')
        .get();
      memberships = snapshot.docs
        .map((doc) => memberFromDocument(doc.data()))
        .filter((member): member is ChannelMemberEntity => member !== null);
    }
    if (memberships.length === 0) return [];
    const joinedEpochByChannel = new Map(memberships.map((m) => [m.channel_id, m.joined_epoch]));

    let envelopeQuery = db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).where('device_id', '==', deviceId);
    if (channelId) envelopeQuery = envelopeQuery.where('channel_id', '==', channelId);
    const envelopeSnapshot = await envelopeQuery.get();

    const channelDocs = await Promise.all(
      [...joinedEpochByChannel.keys()].map((id) => db.collection(CHANNELS_COLLECTION).doc(id).get())
    );
    const channels = channelDocs
      .map((doc) => channelFromDocument(doc.id, doc.data()))
      .filter((channel): channel is ChannelEntity => channel !== null && channel.status === 'ACTIVE');
    const ownerDocs = await Promise.all(
      [...new Set(channels.map((c) => c.owner_device_id))].map((id) => db.collection(DEVICES_COLLECTION).doc(id).get())
    );
    const ownerKeyById = new Map(ownerDocs.map((doc) => [doc.id, String(doc.data()?.public_key ?? '')]));

    const envelopesByChannel = new Map<string, KeyEnvelopeItem[]>();
    for (const doc of envelopeSnapshot.docs) {
      const data = doc.data() ?? {};
      const envChannel = String(data.channel_id ?? '');
      const epoch = Number(data.key_epoch ?? 0);
      const joined = joinedEpochByChannel.get(envChannel);
      if (joined === undefined || epoch < joined) continue;
      const list = envelopesByChannel.get(envChannel) ?? [];
      list.push({
        key_epoch: epoch,
        wrapped_key: String(data.wrapped_key ?? ''),
        nonce: String(data.nonce ?? ''),
        kek_alg: String(data.kek_alg ?? '')
      });
      envelopesByChannel.set(envChannel, list);
    }

    return channels.map((channel) => ({
      channel_id: channel.channel_id,
      current_epoch: channel.current_epoch,
      owner_public_key: ownerKeyById.get(channel.owner_device_id) ?? '',
      envelopes: (envelopesByChannel.get(channel.channel_id) ?? []).sort((a, b) => a.key_epoch - b.key_epoch)
    }));
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
  ): Promise<{ current_epoch: number; membership_version: number; revoked: string[]; channel_name: string; replayed: boolean }> {
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

      // Idempotent retry of the latest committed revoke (response lost to a
      // timeout): the targets are already REVOKED, so the normal path would
      // answer 404 — return the committed result instead and write nothing.
      const replay = channelMembershipService.findReplay(channelDoc.data(), pkg, {
        kind: 'REVOKE',
        revokedDeviceIds: revokeDeviceIds
      });
      if (replay) {
        return {
          current_epoch: replay.new_epoch,
          membership_version: replay.new_membership_version,
          revoked: replay.revoked_device_ids ?? [],
          channel_name: channel.name,
          replayed: true
        };
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
      const committed = channelMembershipService.commitRotation(tx, db, {
        kind: 'REVOKE',
        channelId,
        base: { current_epoch: channel.current_epoch, membership_version: channel.membership_version },
        pkg,
        provisionDeviceIds: remaining.map((m) => m.device_id),
        memberCount: remaining.length,
        now,
        revokedDeviceIds: revoked
      });

      return {
        current_epoch: committed.current_epoch,
        membership_version: committed.membership_version,
        revoked,
        channel_name: channel.name,
        replayed: false
      };
    });
  }

  /**
   * POST /channels/leave (API spec §4.9): an ACTIVE member leaves on their own.
   * The membership becomes REVOKED at once (KL12: no more reads), but — unlike
   * T4 — the server cannot rotate (it never holds keys), so the epoch stays and
   * the channel is flagged `rotation_pending` for the Owner to re-key through
   * POST /channels/rotate. The Owner keeps relaying on the current epoch
   * meanwhile. Owner → 400 OWNER_CANNOT_LEAVE (archive instead).
   */
  public async leaveChannel(
    channelId: string,
    deviceId: string
  ): Promise<{ channel_name: string; owner_device_id: string; membership_version: number }> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();
    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
    const memberRef = db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, deviceId));

    return db.runTransaction(async (tx) => {
      const [channelDoc, memberDoc] = [await tx.get(channelRef), await tx.get(memberRef)];
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const channel = channelFromDocument(channelDoc.id, channelDoc.data());
      if (!channel) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted channel document');
      if (channel.owner_device_id === deviceId) {
        throw new HttpError(400, 'OWNER_CANNOT_LEAVE', 'The owner cannot leave; archive the channel instead');
      }
      if (channel.status !== 'ACTIVE') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }
      const member = memberFromDocument(memberDoc.data());
      if (!member) {
        throw new HttpError(404, 'NOT_FOUND', 'You are not a member of this channel');
      }
      if (member.status !== 'ACTIVE') {
        throw new HttpError(403, 'REVOKED', 'Your membership in this channel has already ended');
      }

      const membershipVersion = channel.membership_version + 1;
      tx.update(memberRef, { status: 'REVOKED' as MemberStatus, revoked_at: now, left_at: now });
      tx.update(channelRef, {
        member_count: Math.max(1, channel.member_count - 1),
        membership_version: membershipVersion,
        rotation_pending: true,
        updated_at: now
      });
      return { channel_name: channel.name, owner_device_id: channel.owner_device_id, membership_version: membershipVersion };
    });
  }

  /**
   * POST /channels/rotate (API spec §4.10): Owner re-keys {Owner} ∪ ACTIVE at
   * epoch N+1 without changing membership — used after a member left
   * (`rotation_pending`). Same Package Pattern checks and idempotent retry as T4.
   */
  public async rotateChannel(
    ownerId: string,
    channelId: string,
    pkg: PackageInput
  ): Promise<{ current_epoch: number; membership_version: number; replayed: boolean }> {
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
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can rotate the channel key');
      }
      if (channel.status !== 'ACTIVE') {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }

      const replay = channelMembershipService.findReplay(channelDoc.data(), pkg, { kind: 'ROTATE' });
      if (replay) {
        return { current_epoch: replay.new_epoch, membership_version: replay.new_membership_version, replayed: true };
      }

      const membersSnapshot = await tx.get(
        db.collection(CHANNEL_MEMBERS_COLLECTION).where('channel_id', '==', channelId).where('status', '==', 'ACTIVE')
      );
      const active = membersSnapshot.docs
        .map((doc) => memberFromDocument(doc.data()))
        .filter((member): member is ChannelMemberEntity => member !== null)
        .filter((member) => member.device_id !== channel.owner_device_id);

      const newEpoch = channel.current_epoch + 1;
      validatePackage(channel, pkg, [channel.owner_device_id, ...active.map((m) => m.device_id)], newEpoch);

      const committed = channelMembershipService.commitRotation(tx, db, {
        kind: 'ROTATE',
        channelId,
        base: { current_epoch: channel.current_epoch, membership_version: channel.membership_version },
        pkg,
        provisionDeviceIds: [channel.owner_device_id, ...active.map((m) => m.device_id)],
        memberCount: active.length + 1,
        now
      });
      return { ...committed, replayed: false };
    });
  }

  /**
   * POST /channels/archive (API spec §4.11): Owner dissolves the channel —
   * terminal ACTIVE → ARCHIVED. In the same transaction: UNUSED invites expire
   * and PENDING join requests are CANCELLED (dedup markers released). The
   * channel then disappears from every list, accepts no message / invite /
   * claim (409 CHANNEL_NOT_ACTIVE) and its messages are no longer served.
   * Idempotent: archiving an archived channel returns `replayed: true`.
   */
  public async archiveChannel(
    ownerId: string,
    channelId: string
  ): Promise<{ channel_name: string; member_device_ids: string[]; replayed: boolean }> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const now = nowIso();
    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);

    return db.runTransaction(async (tx) => {
      const channelDoc = await tx.get(channelRef);
      if (!channelDoc.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const channel = channelFromDocument(channelDoc.id, channelDoc.data());
      if (!channel) throw new HttpError(500, 'SERVER_ERROR', 'Corrupted channel document');
      if (channel.owner_device_id !== ownerId) {
        throw new HttpError(403, 'NOT_OWNER', 'Only the channel owner can archive the channel');
      }
      if (channel.status === 'ARCHIVED') {
        return { channel_name: channel.name, member_device_ids: [], replayed: true };
      }

      const [members, sessions, requests] = [
        await tx.get(
          db.collection(CHANNEL_MEMBERS_COLLECTION).where('channel_id', '==', channelId).where('status', '==', 'ACTIVE')
        ),
        await tx.get(
          db.collection(PAIRING_SESSIONS_COLLECTION).where('channel_id', '==', channelId).where('status', '==', 'UNUSED')
        ),
        await tx.get(
          db.collection(PAIRING_REQUESTS_COLLECTION).where('channel_id', '==', channelId).where('status', '==', 'PENDING')
        )
      ];

      tx.update(channelRef, { status: 'ARCHIVED', archived_at: now, updated_at: now });
      for (const doc of sessions.docs) {
        tx.update(doc.ref, { status: 'EXPIRED' });
      }
      for (const doc of requests.docs) {
        tx.update(doc.ref, { status: 'CANCELLED', decided_by: ownerId, decided_at: now, terminal_at: now });
        const requester = String(doc.data()?.requester_device_id ?? '');
        tx.delete(db.collection(PAIRING_PENDING_COLLECTION).doc(pairingPendingDocId(channelId, requester)));
      }

      const memberDeviceIds = members.docs
        .map((doc) => String(doc.data()?.device_id ?? ''))
        .filter((id) => id && id !== channel.owner_device_id);
      return { channel_name: channel.name, member_device_ids: memberDeviceIds, replayed: false };
    });
  }

  /**
   * PUT /api/v2/channels/whitelist (§4.3 / ROADMAP_CHANNEL_WHITELIST.md v2.2):
   * Owner updates E2EE whitelist blob with optimistic concurrency check (whitelist_version).
   */
  public async updateWhitelist(
    channelId: string,
    callerDeviceId: string,
    data: {
      key_epoch: number;
      ciphertext: string;
      nonce: string;
      whitelist_version: number;
    }
  ): Promise<ChannelWhitelistBlob> {
    await this.requireOwner(channelId, callerDeviceId);

    const db = getFirestoreDb();
    if (!db) {
      throw new HttpError(500, 'DATABASE_ERROR', 'Database unavailable');
    }

    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
    const now = nowIso();

    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(channelRef);
      if (!snap.exists) {
        throw new HttpError(404, 'NOT_FOUND', `Channel ${channelId} does not exist`);
      }
      const channelData = snap.data() || {};
      const currentWhitelist = channelData.whitelist as Record<string, unknown> | undefined;
      const currentVersion = Number(currentWhitelist?.whitelist_version ?? 0);

      if (data.whitelist_version <= currentVersion) {
        throw new HttpError(
          409,
          'STALE_WHITELIST',
          `Whitelist version ${data.whitelist_version} is stale; current is ${currentVersion}`
        );
      }

      const whitelistBlob: ChannelWhitelistBlob = {
        key_epoch: data.key_epoch,
        ciphertext: data.ciphertext,
        nonce: data.nonce,
        whitelist_version: data.whitelist_version,
        updated_at: now
      };

      tx.update(channelRef, {
        whitelist: whitelistBlob,
        updated_at: now
      });

      return whitelistBlob;
    });
  }

  public async clearAll(): Promise<void> {
    assertNotProduction('channelService.clearAll');
    const db = getFirestoreDb();
    if (!db) return;
    for (const name of [CHANNELS_COLLECTION, CHANNEL_MEMBERS_COLLECTION, CHANNEL_KEY_ENVELOPES_COLLECTION]) {
      const snapshot = await db.collection(name).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
    }
  }
}

export const channelService = new ChannelService();
