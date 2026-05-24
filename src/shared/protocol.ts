export type UserId = string;
export type SessionId = string;

export type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline';

export interface UserProfile {
  id: UserId;
  displayName: string;
  teamId: string;
}

export interface PeerPresence extends UserProfile {
  status: PresenceStatus;
  voiceAvailable: boolean;
  lastSeen: number;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServerConfig[];
  iceTransportPolicy?: RTCIceTransportPolicy;
}

export type VoiceMode = 'sendrecv' | 'sendonly' | 'recvonly';

export type EndReason =
  | 'hangup'
  | 'busy'
  | 'unavailable'
  | 'unauthorized'
  | 'network'
  | 'replaced'
  | 'app-close';

export type ClientMessage =
  | {
      type: 'presence.update';
      status: PresenceStatus;
      voiceAvailable: boolean;
    }
  | {
      type: 'voice.session.request';
      sessionId: SessionId;
      toUserId: UserId;
      mode: VoiceMode;
    }
  | {
      type: 'voice.session.accepted';
      sessionId: SessionId;
      toUserId: UserId;
    }
  | {
      type: 'voice.sdp';
      sessionId: SessionId;
      toUserId: UserId;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: 'voice.ice';
      sessionId: SessionId;
      toUserId: UserId;
      candidate: RTCIceCandidateInit | null;
    }
  | {
      type: 'voice.session.end';
      sessionId: SessionId;
      toUserId: UserId;
      reason: EndReason;
    }
  | {
      type: 'heartbeat.pong';
      at: number;
    };

export type ServerMessage =
  | {
      type: 'server.hello';
      user: UserProfile;
      peers: PeerPresence[];
      iceConfig: IceConfig;
    }
  | {
      type: 'presence.update';
      peer: PeerPresence;
    }
  | {
      type: 'voice.session.request';
      sessionId: SessionId;
      fromUserId: UserId;
      mode: VoiceMode;
    }
  | {
      type: 'voice.session.accepted';
      sessionId: SessionId;
      fromUserId: UserId;
    }
  | {
      type: 'voice.sdp';
      sessionId: SessionId;
      fromUserId: UserId;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: 'voice.ice';
      sessionId: SessionId;
      fromUserId: UserId;
      candidate: RTCIceCandidateInit | null;
    }
  | {
      type: 'voice.session.end';
      sessionId: SessionId;
      fromUserId: UserId;
      reason: EndReason;
    }
  | {
      type: 'heartbeat.ping';
      at: number;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      sessionId?: SessionId;
    };

export interface VoiceSessionSnapshot {
  sessionId: SessionId;
  peerId: UserId;
  state: 'requesting' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'failed';
  reason?: EndReason;
  manualEnded: boolean;
}
