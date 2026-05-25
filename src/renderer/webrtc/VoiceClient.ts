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
type IncomingRequestListener = (request: { peerId: UserId; sessionId: SessionId; note?: string }) => void;
type FeedbackKind = 'rejected' | 'mic-enabled' | 'one-way';
type FeedbackListener = (feedback: { peerId: UserId; sessionId: SessionId; kind: FeedbackKind }) => void;

interface ManagedSession {
  sessionId: SessionId;
  peerId: UserId;
  pc: RTCPeerConnection;
  isOfferer: boolean;
  direction: 'outgoing' | 'incoming';
  state: VoiceSessionSnapshot['state'];
  manualEnded: boolean;
  localAudioEnabled: boolean;
  peerFeedback?: FeedbackKind;
  localSenders: RTCRtpSender[];
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
  private speakerVolume = 1;
  private voiceAvailable = true;
  private readonly sessionsByPeer = new Map<UserId, ManagedSession>();
  private readonly sessionsById = new Map<SessionId, ManagedSession>();
  private readonly manuallyEndedSessions = new Set<SessionId>();
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly incomingRequestListeners = new Set<IncomingRequestListener>();
  private readonly feedbackListeners = new Set<FeedbackListener>();

  constructor(signal: SignalClient, iceConfig: RTCConfiguration) {
    this.signal = signal;
    this.iceConfig = iceConfig;
  }

  async prepareMicrophone(): Promise<void> {
    await this.ensureLocalStream();
  }

  async startConversation(peerId: UserId, note?: string): Promise<void> {
    const existing = this.sessionsByPeer.get(peerId);
    if (existing && existing.state !== 'ended' && existing.state !== 'failed') return;

    const sessionId = crypto.randomUUID();
    const session = await this.createSession(peerId, sessionId, true, true, 'outgoing');
    session.state = 'requesting';
    this.emitSnapshots();

    this.signal.send({
      type: 'voice.session.request',
      sessionId,
      toUserId: peerId,
      mode: 'sendonly',
      note: note?.trim() || undefined
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

  setSpeakerVolume(volume: number): void {
    this.speakerVolume = Math.min(1, Math.max(0, volume));
    for (const session of this.sessionsByPeer.values()) {
      session.remoteAudio.volume = this.speakerVolume;
    }
  }

  setVoiceAvailable(available: boolean): void {
    this.voiceAvailable = available;
    this.signal.send({
      type: 'presence.update',
      status: available ? 'online' : 'dnd',
      voiceAvailable: available
    });
  }

  setPresenceMode(mode: 'available' | 'dnd' | 'invisible'): void {
    this.voiceAvailable = mode === 'available';
    this.signal.send({
      type: 'presence.update',
      status: mode === 'available' ? 'online' : mode === 'dnd' ? 'dnd' : 'offline',
      voiceAvailable: mode === 'available'
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

  async enableMicrophone(peerId: UserId): Promise<void> {
    const session = this.sessionsByPeer.get(peerId);
    if (!session || session.state === 'ended' || session.state === 'failed') return;

    await this.attachLocalAudio(session);
    this.signal.send({
      type: 'voice.feedback',
      sessionId: session.sessionId,
      toUserId: session.peerId,
      kind: 'mic-enabled'
    });
    await this.makeOffer(session);
  }

  keepOneWay(peerId: UserId): void {
    const session = this.sessionsByPeer.get(peerId);
    if (!session) return;

    this.signal.send({
      type: 'voice.feedback',
      sessionId: session.sessionId,
      toUserId: session.peerId,
      kind: 'one-way'
    });
  }

  rejectIncoming(peerId: UserId): void {
    const session = this.sessionsByPeer.get(peerId);
    if (!session) return;

    this.signal.send({
      type: 'voice.feedback',
      sessionId: session.sessionId,
      toUserId: session.peerId,
      kind: 'rejected'
    });
    this.closeSession(session, 'rejected', true, true);
  }

  async handleSignal(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'voice.session.request':
        await this.acceptIncomingRequest(message.fromUserId, message.sessionId, message.note);
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
      case 'voice.feedback':
        this.handleFeedback(message.fromUserId, message.sessionId, message.kind);
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

  onIncomingRequest(listener: IncomingRequestListener): () => void {
    this.incomingRequestListeners.add(listener);
    return () => this.incomingRequestListeners.delete(listener);
  }

  onFeedback(listener: FeedbackListener): () => void {
    this.feedbackListeners.add(listener);
    return () => this.feedbackListeners.delete(listener);
  }

  private async acceptIncomingRequest(peerId: UserId, sessionId: SessionId, note?: string): Promise<void> {
    if (!this.voiceAvailable) {
      this.signal.send({ type: 'voice.session.end', sessionId, toUserId: peerId, reason: 'busy' });
      return;
    }

    if (this.manuallyEndedSessions.has(sessionId)) return;

    const existing = this.sessionsById.get(sessionId);
    if (existing) {
      this.signal.send({ type: 'voice.session.accepted', sessionId, toUserId: peerId });
      this.emitIncomingRequest(peerId, sessionId, note);
      return;
    }

    await this.createSession(peerId, sessionId, false, false, 'incoming');
    this.signal.send({ type: 'voice.session.accepted', sessionId, toUserId: peerId });
    this.emitIncomingRequest(peerId, sessionId, note);
  }

  private async createSession(
    peerId: UserId,
    sessionId: SessionId,
    isOfferer: boolean,
    attachLocalAudio: boolean,
    direction: 'outgoing' | 'incoming'
  ): Promise<ManagedSession> {
    const pc = new RTCPeerConnection(this.iceConfig);
    const remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    remoteAudio.muted = this.speakerMuted;
    remoteAudio.volume = this.speakerVolume;
    remoteAudio.dataset.peerId = peerId;
    remoteAudio.style.display = 'none';
    document.body.append(remoteAudio);

    const session: ManagedSession = {
      sessionId,
      peerId,
      pc,
      isOfferer,
      direction,
      state: 'connecting',
      manualEnded: false,
      localAudioEnabled: false,
      localSenders: [],
      queuedCandidates: [],
      remoteAudio,
      restartTimer: null
    };

    if (attachLocalAudio) await this.attachLocalAudio(session);

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

  private async attachLocalAudio(session: ManagedSession): Promise<void> {
    if (session.localAudioEnabled) return;

    await this.ensureLocalStream();
    const localStream = this.localStream;
    if (!localStream) throw new Error('Microphone stream is not available.');

    for (const track of localStream.getAudioTracks()) {
      track.enabled = !this.muted;
      session.localSenders.push(session.pc.addTrack(track, localStream));
    }
    session.localAudioEnabled = true;
    this.emitSnapshots();
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
    if (!session) session = await this.createSession(peerId, sessionId, false, false, 'incoming');
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
    this.closeSession(session, reason, reason === 'hangup' || reason === 'rejected', false);
  }

  private handleFeedback(peerId: UserId, sessionId: SessionId, kind: FeedbackKind): void {
    const session = this.sessionsById.get(sessionId) ?? this.sessionsByPeer.get(peerId);
    if (session) {
      session.peerFeedback = kind;
      this.emitSnapshots();
    }
    for (const listener of this.feedbackListeners) listener({ peerId, sessionId, kind });
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
      manualEnded: session.manualEnded,
      direction: session.direction,
      localAudioEnabled: session.localAudioEnabled,
      peerFeedback: session.peerFeedback
    }));
  }

  private emitSnapshots(): void {
    const snapshots = this.getSnapshots();
    for (const listener of this.snapshotListeners) listener(snapshots);
  }

  private emitError(message: string): void {
    for (const listener of this.errorListeners) listener(message);
  }

  private emitIncomingRequest(peerId: UserId, sessionId: SessionId, note?: string): void {
    for (const listener of this.incomingRequestListeners) listener({ peerId, sessionId, note });
  }
}
