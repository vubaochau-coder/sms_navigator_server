import { randomUUID } from 'crypto';
import {
  ChannelEntity,
  ChannelKeyEnvelopeEntity,
  ChannelMemberEntity,
  ChannelRole,
  MemberStatus
} from '../types/v2.js';
import { getFirestoreDb } from '../config/firebase.js';
import { nowIso } from '../utils/time.js';
import { HttpError } from '../utils/http-error.js';
import { DeviceEntity } from '../types/index.js';
import { DEVICES_COLLECTION } from './device.service.js';

export const CHANNELS_COLLECTION = 'channels';
export const CHANNEL_MEMBERS_COLLECTION = 'channel_members';
export const CHANNEL_KEY_ENVELOPES_COLLECTION = 'channel_key_envelopes';

export interface EnvelopeInput {
  device_id: string;
  encrypted_key: string;
  iv: string;
  sender_ephemeral_pubkey: string;
}

/** Document id per SRD 3.3: `{channelId}__{deviceId}` (double underscore). */
export function channelMemberDocId(channelId: string, deviceId: string): string {
  return `${channelId}__${deviceId}`;
}

/** Document id per SRD 3.6: `{channelId}__{deviceId}__{epoch}`. */
export function envelopeDocId(channelId: string, deviceId: string, epoch: number): string {
  return `${channelId}__${deviceId}__${epoch}`;
}

function channelFromDocument(id: string, data: Record<string, unknown> | undefined): ChannelEntity | null {
  if (!data || typeof data.channel_name !== 'string') return null;
  return {
    channel_id: typeof data.channel_id === 'string' ? data.channel_id : id,
    channel_name: data.channel_name,
    owner_device_id: String(data.owner_device_id ?? ''),
    current_epoch: Number(data.current_epoch ?? 1),
    sequence_counter: Number(data.sequence_counter ?? 0),
    is_active: data.is_active !== false,
    created_at: String(data.created_at ?? nowIso()),
    updated_at: String(data.updated_at ?? nowIso())
  };
}

function memberFromDocument(id: string, data: Record<string, unknown> | undefined): ChannelMemberEntity | null {
  if (!data || typeof data.device_id !== 'string' || typeof data.channel_id !== 'string') return null;
  return {
    id,
    channel_id: data.channel_id,
    device_id: data.device_id,
    device_name: String(data.device_name ?? ''),
    public_key: String(data.public_key ?? ''),
    role: (data.role as ChannelRole) === 'owner' ? 'owner' : 'member',
    status: (data.status as MemberStatus) === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    joined_epoch: Number(data.joined_epoch ?? 1),
    joined_at: String(data.joined_at ?? nowIso()),
    revoked_at: data.revoked_at as string | undefined,
    updated_at: String(data.updated_at ?? nowIso())
  };
}

function envelopeFromDocument(id: string, data: Record<string, unknown> | undefined): ChannelKeyEnvelopeEntity | null {
  if (!data || typeof data.encrypted_key !== 'string') return null;
  return {
    id,
    channel_id: String(data.channel_id ?? ''),
    device_id: String(data.device_id ?? ''),
    epoch: Number(data.epoch ?? 0),
    encrypted_key: data.encrypted_key,
    iv: String(data.iv ?? ''),
    sender_ephemeral_pubkey: String(data.sender_ephemeral_pubkey ?? ''),
    created_at: String(data.created_at ?? nowIso()),
    fetched_at: data.fetched_at as string | undefined
  };
}

export interface ChannelListItem extends ChannelEntity {
  role: ChannelRole;
  status: MemberStatus;
  joined_epoch: number;
  member_count: number;
}

export class ChannelService {
  /** T0: create channel + Owner member doc (ACTIVE, joined_epoch = 1). */
  public async createChannel(owner: DeviceEntity, channelName: string): Promise<ChannelEntity> {
    const db = getFirestoreDb();
    if (!db) throw new Error('Firestore is not available');

    const channelId = randomUUID();
    const now = nowIso();
    const channelRef = db.collection(CHANNELS_COLLECTION).doc(channelId);
    const memberRef = db.collection(CHANNEL_MEMBERS_COLLECTION).doc(channelMemberDocId(channelId, owner.device_id));

    const channel: ChannelEntity = {
      channel_id: channelId,
      channel_name: channelName,
      owner_device_id: owner.device_id,
      current_epoch: 1,
      sequence_counter: 0,
      is_active: true,
      created_at: now,
      updated_at: now
    };

    await db.runTransaction(async (tx) => {
      tx.set(channelRef, {
        ...channel,
        member_count: 1
      });
      tx.set(memberRef, {
        id: memberRef.id,
        channel_id: channelId,
        device_id: owner.device_id,
        device_name: owner.device_name ?? '',
        public_key: owner.public_key ?? '',
        role: 'owner' as ChannelRole,
        status: 'ACTIVE' as MemberStatus,
        joined_epoch: 1,
        joined_at: now,
        updated_at: now
      });
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
    return memberFromDocument(doc.id, doc.data());
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
      .map((doc) => memberFromDocument(doc.id, doc.data()))
      .filter((member): member is ChannelMemberEntity => member !== null)
      .sort((a, b) => a.joined_epoch - b.joined_epoch || a.joined_at.localeCompare(b.joined_at));
  }

  /** Q2: all channels the device is an ACTIVE member of (owner included). */
  public async listChannelsForDevice(deviceId: string): Promise<ChannelListItem[]> {
    const db = getFirestoreDb();
    if (!db) return [];

    const membershipSnapshot = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .where('device_id', '==', deviceId)
      .where('status', '==', 'ACTIVE')
      .get();

    const memberships = membershipSnapshot.docs
      .map((doc) => memberFromDocument(doc.id, doc.data()))
      .filter((member): member is ChannelMemberEntity => member !== null);

    const items: ChannelListItem[] = [];
    for (const membership of memberships) {
      const channel = await this.findChannelById(membership.channel_id);
      if (!channel || !channel.is_active) continue;
      items.push({
        ...channel,
        role: membership.role,
        status: membership.status,
        joined_epoch: membership.joined_epoch,
        member_count: await this.countActiveMembers(channel.channel_id)
      });
    }
    return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  public async countActiveMembers(channelId: string): Promise<number> {
    const db = getFirestoreDb();
    if (!db) return 0;
    const snapshot = await db
      .collection(CHANNEL_MEMBERS_COLLECTION)
      .where('channel_id', '==', channelId)
      .where('status', '==', 'ACTIVE')
      .get();
    return snapshot.size;
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
   */
  public async renameDeviceEverywhere(deviceId: string, deviceName: string): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;

    const now = nowIso();

    await db.runTransaction(async (tx) => {
      const deviceRef = db.collection(DEVICES_COLLECTION).doc(deviceId);
      const deviceDoc = await tx.get(deviceRef);
      if (deviceDoc.exists) {
        tx.update(deviceRef, { device_name: deviceName, last_active_at: now });
      }

      const memberships = await tx.get(
        db
          .collection(CHANNEL_MEMBERS_COLLECTION)
          .where('device_id', '==', deviceId)
          .where('status', '==', 'ACTIVE')
      );
      for (const doc of memberships.docs) {
        tx.update(doc.ref, { device_name: deviceName, updated_at: now });
      }

      const pendingRequests = await tx.get(
        db
          .collection('pairing_requests')
          .where('requester_device_id', '==', deviceId)
          .where('status', '==', 'PENDING')
      );
      for (const doc of pendingRequests.docs) {
        tx.update(doc.ref, { requester_device_name: deviceName });
      }
    });
  }

  /** Persist key envelopes for one epoch; doc ids `{channelId}__{deviceId}__{epoch}`. */
  public async saveEnvelopes(channelId: string, epoch: number, envelopes: EnvelopeInput[]): Promise<void> {
    const db = getFirestoreDb();
    if (!db) return;
    const now = nowIso();
    await db.runTransaction(async (tx) => {
      for (const envelope of envelopes) {
        tx.set(db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(channelId, envelope.device_id, epoch)), {
          id: envelopeDocId(channelId, envelope.device_id, epoch),
          channel_id: channelId,
          device_id: envelope.device_id,
          epoch,
          encrypted_key: envelope.encrypted_key,
          iv: envelope.iv,
          sender_ephemeral_pubkey: envelope.sender_ephemeral_pubkey,
          created_at: now
        });
      }
    });
  }

  public async getEnvelope(
    channelId: string,
    deviceId: string,
    epoch: number
  ): Promise<ChannelKeyEnvelopeEntity | null> {
    const db = getFirestoreDb();
    if (!db) return null;

    const ref = db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(channelId, deviceId, epoch));
    const doc = await ref.get();
    if (!doc.exists) return null;

    const envelope = envelopeFromDocument(doc.id, doc.data());
    if (envelope && !envelope.fetched_at) {
      // Idempotent fetch: only the first fetch stamps fetched_at
      await ref.update({ fetched_at: nowIso() });
      envelope.fetched_at = nowIso();
    }
    return envelope;
  }

  /**
   * T4: revoke members + rotate epoch, commit atomically.
   * Envelope set must exactly cover the remaining ACTIVE members (KL8).
   */
  public async revokeMembers(
    ownerId: string,
    channelId: string,
    targetDeviceIds: string[],
    newEpoch: number,
    envelopes: EnvelopeInput[]
  ): Promise<{ channel: ChannelEntity; revoked: string[] }> {
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
      if (!channel.is_active) {
        throw new HttpError(409, 'CHANNEL_NOT_ACTIVE', 'This channel is archived');
      }
      if (newEpoch !== channel.current_epoch + 1) {
        throw new HttpError(409, 'MEMBERSHIP_CHANGED', `new_epoch must be ${channel.current_epoch + 1}`);
      }
      if (targetDeviceIds.includes(channel.owner_device_id)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'The channel owner cannot be revoked');
      }

      const targets = new Set(targetDeviceIds);
      const membersSnapshot = await tx.get(
        db
          .collection(CHANNEL_MEMBERS_COLLECTION)
          .where('channel_id', '==', channelId)
          .where('status', '==', 'ACTIVE')
      );
      const activeMembers = membersSnapshot.docs
        .map((doc) => memberFromDocument(doc.id, doc.data()))
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

      const expected = new Set(remaining.map((member) => member.device_id));
      const provided = new Set(envelopes.map((envelope) => envelope.device_id));
      if (
        provided.size !== envelopes.length ||
        provided.size !== expected.size ||
        [...expected].some((id) => !provided.has(id))
      ) {
        throw new HttpError(
          422,
          'PACKAGE_INCOMPLETE',
          'envelopes must cover exactly the remaining ACTIVE members of the new epoch'
        );
      }

      for (const member of activeMembers) {
        if (!targets.has(member.device_id)) continue;
        tx.update(db.collection(CHANNEL_MEMBERS_COLLECTION).doc(member.id), {
          status: 'REVOKED' as MemberStatus,
          revoked_at: now,
          updated_at: now
        });
      }

      tx.update(channelRef, {
        current_epoch: newEpoch,
        member_count: activeMembers.length - revoked.length,
        updated_at: now
      });

      for (const envelope of envelopes) {
        tx.set(db.collection(CHANNEL_KEY_ENVELOPES_COLLECTION).doc(envelopeDocId(channelId, envelope.device_id, newEpoch)), {
          id: envelopeDocId(channelId, envelope.device_id, newEpoch),
          channel_id: channelId,
          device_id: envelope.device_id,
          epoch: newEpoch,
          encrypted_key: envelope.encrypted_key,
          iv: envelope.iv,
          sender_ephemeral_pubkey: envelope.sender_ephemeral_pubkey,
          created_at: now
        });
      }

      const updated = { ...channel, current_epoch: newEpoch };
      return { channel: updated, revoked };
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
