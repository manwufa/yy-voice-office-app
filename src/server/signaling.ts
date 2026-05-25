import type {
  ClientMessage,
  EndReason,
  IceConfig,
  PeerPresence,
  ServerMessage,
  SessionId,
  UserId,
  UserProfile
} from '../shared/protocol.js';
import { clientMessageSchema } from '../shared/validation.js';
import { makeIceConfig } from './ice.js';

type SendMessage = (message: ServerMessage) => void;

interface ConnectedClient {
  user: UserProfile;
  send: SendMessage;
  presence: PeerPresence;
  lastPongAt: number;
}

interface SessionRecord {
  sessionId: SessionId;
  initiatorId: UserId;
  responderId: UserId;
  state: 'active' | 'ended';
  endedBy?: UserId;
  reason?: EndReason;
  createdAt: number;
  updatedAt: number;
}

export interface SignalingHubOptions {
  iceConfig?: IceConfig;
  now?: () => number;
  heartbeatTimeoutMs?: number;
}

export class SignalingHub {
  private readonly iceConfig: IceConfig;
  private readonly now: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly clients = new Map<UserId, ConnectedClient>();
  private readonly sessions = new Map<SessionId, SessionRecord>();

  constructor(options: SignalingHubOptions = {}) {
    this.iceConfig = options.iceConfig ?? makeIceConfig();
    this.now = options.now ?? Date.now;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 70_000;
  }

  connect(user: UserProfile, send: SendMessage): void {
    const existing = this.clients.get(user.id);
    if (existing) {
      existing.send({
        type: 'voice.session.end',
        sessionId: 'replaced',
        fromUserId: user.id,
        reason: 'replaced'
      });
    }

    for (const [existingUserId, existingClient] of [...this.clients.entries()]) {
      if (existingUserId === user.id) continue;
      if (!samePersonIdentity(existingClient.user, user)) continue;

      existingClient.send({
        type: 'voice.session.end',
        sessionId: 'replaced',
        fromUserId: user.id,
        reason: 'replaced'
      });
      this.disconnect(existingUserId);
    }

    const presence: PeerPresence = {
      ...user,
      status: 'online',
      voiceAvailable: true,
      lastSeen: this.now()
    };

    this.clients.set(user.id, {
      user,
      send,
      presence,
      lastPongAt: this.now()
    });

    send({
      type: 'server.hello',
      user,
      peers: this.getPeersFor(user.id),
      iceConfig: this.iceConfig
    });

    this.broadcastPresence(presence, user.id);
  }

  disconnect(userId: UserId, expectedSend?: SendMessage): void {
    const client = this.clients.get(userId);
    if (!client) return;
    if (expectedSend && client.send !== expectedSend) return;

    this.clients.delete(userId);
    this.endActiveSessionsFor(userId, 'unavailable');
    const offlinePresence: PeerPresence = {
      ...client.presence,
      status: 'offline',
      voiceAvailable: false,
      lastSeen: this.now()
    };

    this.broadcastPresence(offlinePresence, userId);
  }

  touch(userId: UserId, expectedSend?: SendMessage, now = this.now()): void {
    const client = this.clients.get(userId);
    if (!client) return;
    if (expectedSend && client.send !== expectedSend) return;

    client.lastPongAt = now;
    client.presence = {
      ...client.presence,
      lastSeen: now
    };
  }

  handleMessage(userId: UserId, rawMessage: unknown): void {
    const client = this.clients.get(userId);
    if (!client) return;

    const result = clientMessageSchema.safeParse(rawMessage);
    if (!result.success) {
      this.sendError(client, 'bad_message', 'Invalid signaling message.');
      return;
    }

    const message = result.data as ClientMessage;
    switch (message.type) {
      case 'presence.update':
        this.updatePresence(client, message.status, message.voiceAvailable);
        break;
      case 'voice.session.request':
        this.requestSession(client, message);
        break;
      case 'voice.session.accepted':
      case 'voice.sdp':
      case 'voice.ice':
      case 'voice.feedback':
        this.forwardSessionMessage(client, message);
        break;
      case 'voice.session.end':
        this.endSession(client, message.sessionId, message.toUserId, message.reason);
        break;
      case 'heartbeat.pong':
        this.touch(userId);
        break;
    }
  }

  makeHeartbeat(now = this.now()): void {
    for (const [userId, client] of [...this.clients.entries()]) {
      if (now - client.lastPongAt > this.heartbeatTimeoutMs) {
        this.disconnect(userId);
        continue;
      }

      client.send({ type: 'heartbeat.ping', at: now });
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getSession(sessionId: SessionId): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getPresence(userId: UserId): PeerPresence | undefined {
    return this.clients.get(userId)?.presence;
  }

  getOnlinePeers(): PeerPresence[] {
    return [...this.clients.values()].map((client) => client.presence);
  }

  private updatePresence(client: ConnectedClient, status: PeerPresence['status'], voiceAvailable: boolean): void {
    client.presence = {
      ...client.presence,
      status,
      voiceAvailable: status === 'dnd' ? false : voiceAvailable,
      lastSeen: this.now()
    };
    this.broadcastPresence(client.presence, client.user.id);
  }

  private requestSession(
    client: ConnectedClient,
    message: Extract<ClientMessage, { type: 'voice.session.request' }>
  ): void {
    if (!this.ensureAuthorized(client, message.toUserId, message.sessionId)) return;

    const target = this.clients.get(message.toUserId);
    if (!target || !target.presence.voiceAvailable || target.presence.status === 'dnd') {
      client.send({
        type: 'voice.session.end',
        sessionId: message.sessionId,
        fromUserId: message.toUserId,
        reason: target?.presence.status === 'dnd' ? 'busy' : 'unavailable'
      });
      return;
    }

    const existing = this.sessions.get(message.sessionId);
    if (existing?.state === 'ended') {
      this.sendError(client, 'ended_session', 'This session was already ended.', message.sessionId);
      return;
    }

    const activeSession = this.findActiveSessionBetween(client.user.id, message.toUserId);
    if (activeSession && activeSession.sessionId !== message.sessionId) {
      this.sendError(client, 'active_session', 'A voice session with this peer is already active.', message.sessionId);
      return;
    }

    this.sessions.set(message.sessionId, {
      sessionId: message.sessionId,
      initiatorId: client.user.id,
      responderId: message.toUserId,
      state: 'active',
      createdAt: this.now(),
      updatedAt: this.now()
    });

    target.send({
      type: 'voice.session.request',
      sessionId: message.sessionId,
      fromUserId: client.user.id,
      mode: message.mode,
      note: message.note
    });
  }

  private forwardSessionMessage(
    client: ConnectedClient,
    message: Extract<ClientMessage, { type: 'voice.session.accepted' | 'voice.sdp' | 'voice.ice' | 'voice.feedback' }>
  ): void {
    const session = this.sessions.get(message.sessionId);
    if (!session || session.state === 'ended') {
      this.sendError(client, 'inactive_session', 'Session is not active.', message.sessionId);
      return;
    }

    if (!this.isParticipant(session, client.user.id, message.toUserId)) {
      this.sendError(client, 'unauthorized', 'Not authorized for this voice session.', message.sessionId);
      return;
    }

    const target = this.clients.get(message.toUserId);
    if (!target) {
      this.sendError(client, 'peer_offline', 'Peer is offline.', message.sessionId);
      return;
    }

    session.updatedAt = this.now();
    if (message.type === 'voice.session.accepted') {
      target.send({
        type: 'voice.session.accepted',
        sessionId: message.sessionId,
        fromUserId: client.user.id
      });
      return;
    }

    if (message.type === 'voice.sdp') {
      target.send({
        type: 'voice.sdp',
        sessionId: message.sessionId,
        fromUserId: client.user.id,
        description: message.description
      });
      return;
    }

    if (message.type === 'voice.feedback') {
      target.send({
        type: 'voice.feedback',
        sessionId: message.sessionId,
        fromUserId: client.user.id,
        kind: message.kind
      });
      return;
    }

    target.send({
      type: 'voice.ice',
      sessionId: message.sessionId,
      fromUserId: client.user.id,
      candidate: message.candidate
    });
  }

  private endSession(client: ConnectedClient, sessionId: SessionId, toUserId: UserId, reason: EndReason): void {
    const session = this.sessions.get(sessionId);
    if (session && !this.isParticipant(session, client.user.id, toUserId)) {
      this.sendError(client, 'unauthorized', 'Not authorized for this voice session.', sessionId);
      return;
    }

    if (session) {
      session.state = 'ended';
      session.endedBy = client.user.id;
      session.reason = reason;
      session.updatedAt = this.now();
    }

    const target = this.clients.get(toUserId);
    target?.send({
      type: 'voice.session.end',
      sessionId,
      fromUserId: client.user.id,
      reason
    });
  }

  private ensureAuthorized(client: ConnectedClient, targetUserId: UserId, sessionId?: SessionId): boolean {
    if (this.canAutoConnect(client.user.id, targetUserId)) return true;

    client.send({
      type: 'error',
      code: 'unauthorized',
      message: 'This peer is not pre-authorized for no-answer voice.',
      sessionId
    });
    return false;
  }

  private isParticipant(session: SessionRecord, fromUserId: UserId, toUserId: UserId): boolean {
    return (
      (session.initiatorId === fromUserId && session.responderId === toUserId) ||
      (session.responderId === fromUserId && session.initiatorId === toUserId)
    );
  }

  private canAutoConnect(fromUserId: UserId, toUserId: UserId): boolean {
    return fromUserId !== toUserId;
  }

  private findActiveSessionBetween(aUserId: UserId, bUserId: UserId): SessionRecord | undefined {
    return [...this.sessions.values()].find(
      (session) =>
        session.state === 'active' &&
        ((session.initiatorId === aUserId && session.responderId === bUserId) ||
          (session.initiatorId === bUserId && session.responderId === aUserId))
    );
  }

  private endActiveSessionsFor(userId: UserId, reason: EndReason): void {
    for (const session of this.sessions.values()) {
      if (session.state !== 'active') continue;
      if (session.initiatorId !== userId && session.responderId !== userId) continue;

      session.state = 'ended';
      session.endedBy = userId;
      session.reason = reason;
      session.updatedAt = this.now();

      const otherUserId = session.initiatorId === userId ? session.responderId : session.initiatorId;
      this.clients.get(otherUserId)?.send({
        type: 'voice.session.end',
        sessionId: session.sessionId,
        fromUserId: userId,
        reason
      });
    }
  }

  private getPeersFor(userId: UserId): PeerPresence[] {
    return [...this.clients.entries()]
      .filter(([peerId]) => peerId !== userId)
      .map(([, client]) => client.presence)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private broadcastPresence(peer: PeerPresence, exceptUserId?: UserId): void {
    for (const [userId, client] of this.clients.entries()) {
      if (userId !== exceptUserId && this.canAutoConnect(userId, peer.id)) {
        client.send({ type: 'presence.update', peer });
      }
    }
  }

  private sendError(client: ConnectedClient, code: string, message: string, sessionId?: SessionId): void {
    client.send({ type: 'error', code, message, sessionId });
  }
}

function samePersonIdentity(a: UserProfile, b: UserProfile): boolean {
  return a.teamId === b.teamId && normalizeDisplayName(a.displayName) === normalizeDisplayName(b.displayName);
}

function normalizeDisplayName(displayName: string): string {
  return displayName.trim().toLocaleLowerCase();
}
