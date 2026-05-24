import type {
  EndReason,
  ServerMessage,
  SessionId,
  UserId,
  VoiceSessionSnapshot
} from '../../shared/protocol.js';
import { SignalClient } from '../ws/SignalClient.js';

type SnapshotListener = (sessions: VoiceSessionSnapshot[]) => void;
type ErrorListener = (message: string) => void;

interface ManagedSession {
  sessionId: SessionId;
  peerId: UserId;
  pc: RTCPeerConnection;
  isOfferer: boolean;
  state: VoiceSessionSnapshot['state'];
  manualEnded: boolean;
  queuedCandidates: RTCIceCandidateInit[];
  remoteAudio: HTMLAudioElement;
  restartTimer: number | null;
  reason?: EndReason;
}

export class VoiceClient {
  private readonly signal: SignalClient;
  private readonly iceConfig: RTCConfiguration;
  private localStream: MediaStream | null = null;
  private muted = false;
  private speakerMuted = false;
  private voiceAvailable = true;
  private readonly sessionsByPeer = new Map<UserId, ManagedSession>();
  private readonly sessionsById = new Map<SessionId, ManagedSession>();
  private readonly manuallyEndedSessions = new Set<SessionId>();
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(signal: SignalClient, iceConfig: RTCConfiguration) {
    this.signal = signal;
    this.iceConfig = iceConfig;
  }

  async prepareMicrophone(): Promise<void> {
    await this.ensureLocalStream();
  }

  async startConversation(peerId: UserId): Promise<void> {
    const existing = this.sessionsByPeer.get(peerId);
    if (existing && existing.state !== 'ended' && existing.state !== 'failed') return;

    const sessionId = crypto.randomUUID();
    const session = await this.createSession(peerId, sessionId, true);
    session.state = 'requesting';
    this.emitSnapshots();

    this.signal.send({
      type: 'voice.session.request',
      sessionId,
      toUserId: peerId,
      mode: 'sendrecv'
    });
    await this.makeOffer(session);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setSpeakerMuted(muted: boolean): void {
    this.speakerMuted = muted;
    for (const session of this.sessionsByPeer.values()) {
      session.remoteAudio.muted = muted;
    }
  }

  toggleSpeakerMuted(): boolean {
    this.setSpeakerMuted(!this.speakerMuted);
    return this.speakerMuted;
  }

  setVoiceAvailable(available: boolean): void {
    this.voiceAvailable = available;
    this.signal.send({
      type: 'presence.update',
      status: available ? 'online' : 'dnd',
      voiceAvailable: available
    });
  }

  hangup(peerId: UserId, reason: EndReason = 'hangup'): void {
    const session = this.sessionsByPeer.get(peerId);
    if (!session) return;
    this.closeSession(session, reason, true, true);
  }

  hangupAll(reason: EndReason = 'hangup'): void {
    for (const session of [...this.sessionsByPeer.values()]) {
      this.closeSession(session, reason, true, true);
    }
  }

  async handleSignal(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'voice.session.request':
        await this.acceptIncomingRequest(message.fromUserId, message.sessionId);
        break;
      case 'voice.session.accepted':
        this.updateSessionState(message.sessionId, 'connecting');
        break;
      case 'voice.sdp':
        await this.handleSdp(message.fromUserId, message.sessionId, message.description);
        break;
      case 'voice.ice':
        await this.handleIce(message.sessionId, message.candidate);
        break;
      case 'voice.session.end':
        this.handleRemoteEnd(message.fromUserId, message.sessionId, message.reason);
        break;
      case 'error':
        this.emitError(message.message);
        if (message.sessionId) this.updateSessionState(message.sessionId, 'failed');
        break;
    }
  }

  onSnapshots(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    listener(this.getSnapshots());
    return () => this.snapshotListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private async acceptIncomingRequest(peerId: UserId, sessionId: SessionId): Promise<void> {
    if (!this.voiceAvailable) {
      this.signal.send({ type: 'voice.session.end', sessionId, toUserId: peerId, reason: 'busy' });
      return;
    }

    if (this.manuallyEndedSessions.has(sessionId)) return;

    const existing = this.sessionsById.get(sessionId);
    if (existing) {
      this.signal.send({ type: 'voice.session.accepted', sessionId, toUserId: peerId });
      return;
    }

    await this.createSession(peerId, sessionId, false);
    this.signal.send({ type: 'voice.session.accepted', sessionId, toUserId: peerId });
  }

  private async createSession(peerId: UserId, sessionId: SessionId, isOfferer: boolean): Promise<ManagedSession> {
    await this.ensureLocalStream();
    const localStream = this.localStream;
    if (!localStream) throw new Error('Microphone stream is not available.');
    const pc = new RTCPeerConnection(this.iceConfig);
    const remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    remoteAudio.muted = this.speakerMuted;
    remoteAudio.dataset.peerId = peerId;
    remoteAudio.style.display = 'none';
    document.body.append(remoteAudio);

    for (const track of localStream.getAudioTracks()) {
      pc.addTrack(track, localStream);
    }

    const session: ManagedSession = {
      sessionId,
      peerId,
      pc,
      isOfferer,
      state: 'connecting',
      manualEnded: false,
      queuedCandidates: [],
      remoteAudio,
      restartTimer: null
    };

    pc.addEventListener('icecandidate', (event) => {
      this.signal.send({
        type: 'voice.ice',
        sessionId,
        toUserId: peerId,
        candidate: event.candidate ? event.candidate.toJSON() : null
      });
    });

    pc.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (stream) {
        remoteAudio.srcObject = stream;
        void remoteAudio.play().catch(() => {
          this.emitError('远端音频播放被系统阻止，请点击窗口后重试。');
        });
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.setSessionState(session, 'connected');
      if (pc.connectionState === 'failed') this.scheduleIceRestart(session);
      if (pc.connectionState === 'closed') this.setSessionState(session, 'ended');
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this.scheduleIceRestart(session);
      }
    });

    this.sessionsByPeer.set(peerId, session);
    this.sessionsById.set(sessionId, session);
    this.emitSnapshots();
    return session;
  }

  private async ensureLocalStream(): Promise<void> {
    if (this.localStream?.active) return;

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    this.setMuted(this.muted);
  }

  private async makeOffer(session: ManagedSession): Promise<void> {
    if (session.manualEnded || session.pc.signalingState === 'closed') return;
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    this.signal.send({
      type: 'voice.sdp',
      sessionId: session.sessionId,
      toUserId: session.peerId,
      description: offer
    });
  }

  private async handleSdp(
    peerId: UserId,
    sessionId: SessionId,
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    if (this.manuallyEndedSessions.has(sessionId)) return;

    let session = this.sessionsById.get(sessionId);
    if (!session) session = await this.createSession(peerId, sessionId, false);
    if (session.manualEnded || session.pc.signalingState === 'closed') return;

    if (description.type === 'offer' && session.pc.signalingState !== 'stable') {
      await session.pc.setLocalDescription({ type: 'rollback' });
    }

    await session.pc.setRemoteDescription(description);
    await this.flushQueuedCandidates(session);

    if (description.type === 'offer') {
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      this.signal.send({
        type: 'voice.sdp',
        sessionId,
        toUserId: peerId,
        description: answer
      });
    }
  }

  private async handleIce(sessionId: SessionId, candidate: RTCIceCandidateInit | null): Promise<void> {
    const session = this.sessionsById.get(sessionId);
    if (!session || session.manualEnded || !candidate) return;

    if (!session.pc.remoteDescription) {
      session.queuedCandidates.push(candidate);
      return;
    }

    try {
      await session.pc.addIceCandidate(candidate);
    } catch {
      this.emitError('收到无效 ICE candidate，已忽略。');
    }
  }

  private async flushQueuedCandidates(session: ManagedSession): Promise<void> {
    const candidates = session.queuedCandidates.splice(0);
    for (const candidate of candidates) {
      try {
        await session.pc.addIceCandidate(candidate);
      } catch {
        this.emitError('收到过期 ICE candidate，已忽略。');
      }
    }
  }

  private scheduleIceRestart(session: ManagedSession): void {
    if (session.manualEnded || session.state === 'ended') return;
    if (session.restartTimer !== null) return;

    this.setSessionState(session, 'reconnecting');
    session.restartTimer = window.setTimeout(async () => {
      session.restartTimer = null;
      if (session.manualEnded || session.pc.connectionState === 'connected') return;

      try {
        session.pc.restartIce();
        if (session.isOfferer) await this.makeOffer(session);
      } catch {
        this.setSessionState(session, 'failed', 'network');
      }
    }, 1_000);
  }

  private handleRemoteEnd(peerId: UserId, sessionId: SessionId, reason: EndReason): void {
    const session = this.sessionsById.get(sessionId) ?? this.sessionsByPeer.get(peerId);
    if (!session) return;
    this.closeSession(session, reason, reason === 'hangup', false);
  }

  private closeSession(session: ManagedSession, reason: EndReason, manual: boolean, notify: boolean): void {
    session.manualEnded = manual;
    session.reason = reason;
    if (manual) this.manuallyEndedSessions.add(session.sessionId);
    if (session.restartTimer !== null) window.clearTimeout(session.restartTimer);
    session.pc.close();
    session.remoteAudio.srcObject = null;
    session.remoteAudio.remove();
    session.state = 'ended';
    this.emitSnapshots();

    if (notify) {
      this.signal.send({
        type: 'voice.session.end',
        sessionId: session.sessionId,
        toUserId: session.peerId,
        reason
      });
    }
  }

  private updateSessionState(sessionId: SessionId, state: VoiceSessionSnapshot['state']): void {
    const session = this.sessionsById.get(sessionId);
    if (session) this.setSessionState(session, state);
  }

  private setSessionState(session: ManagedSession, state: VoiceSessionSnapshot['state'], reason?: EndReason): void {
    session.state = state;
    session.reason = reason;
    this.emitSnapshots();
  }

  private getSnapshots(): VoiceSessionSnapshot[] {
    return [...this.sessionsByPeer.values()].map((session) => ({
      sessionId: session.sessionId,
      peerId: session.peerId,
      state: session.state,
      reason: session.reason,
      manualEnded: session.manualEnded
    }));
  }

  private emitSnapshots(): void {
    const snapshots = this.getSnapshots();
    for (const listener of this.snapshotListeners) listener(snapshots);
  }

  private emitError(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }
}
