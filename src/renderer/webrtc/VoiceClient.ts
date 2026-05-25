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
export type LocalMediaFailureKind = 'insecure-context' | 'media-devices-unavailable';

export class LocalMediaUnavailableError extends Error {
  readonly kind: LocalMediaFailureKind;

  constructor(kind: LocalMediaFailureKind) {
    super(kind);
    this.name = 'LocalMediaUnavailableError';
    this.kind = kind;
  }
}

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
  networkNoticeSent: boolean;
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

    await this.ensureLocalStream();
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
        this.emitError(this.describeServerError(message.code, message.sessionId, message.message));
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
      restartTimer: null,
      networkNoticeSent: false
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

    if (!window.isSecureContext && window.location.protocol !== 'file:') {
      throw new LocalMediaUnavailableError('insecure-context');
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new LocalMediaUnavailableError('media-devices-unavailable');
    }

    this.localStream = await mediaDevices.getUserMedia({
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

    if (!session.networkNoticeSent) {
      this.emitError('双方之间的语音网络连接中断，正在自动恢复；这不是麦克风权限问题。');
      session.networkNoticeSent = true;
    }
    this.setSessionState(session, 'reconnecting');
    session.restartTimer = window.setTimeout(async () => {
      session.restartTimer = null;
      if (session.manualEnded || session.pc.connectionState === 'connected') return;

      try {
        session.pc.restartIce();
        if (session.isOfferer) await this.makeOffer(session);
      } catch {
        this.setSessionState(session, 'failed', 'network');
        this.emitError('双方之间的 P2P 语音网络恢复失败；本机和对方都在线时，请检查 NAT/TURN 或网络限制。');
      }
    }, 1_000);
  }

  private handleRemoteEnd(peerId: UserId, sessionId: SessionId, reason: EndReason): void {
    const session = this.sessionsById.get(sessionId) ?? this.sessionsByPeer.get(peerId);
    if (!session) return;
    this.closeSession(session, reason, reason === 'hangup' || reason === 'rejected', false);
    this.emitError(this.describeRemoteEnd(reason));
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

  private describeServerError(code: string, sessionId: SessionId | undefined, fallback: string): string {
    const session = sessionId ? this.sessionsById.get(sessionId) : undefined;
    const peerLabel = session ? '对方' : '目标用户';

    if (code === 'peer_offline') return `${peerLabel}的客户端已离线或网络断开；不是你这边的麦克风权限问题。`;
    if (code === 'unauthorized') return '服务端拒绝了这次语音信令；这是权限或会话范围问题，不是麦克风或网络问题。';
    if (code === 'inactive_session' || code === 'ended_session') return '本次语音会话已经结束，后续信令被忽略；不是麦克风权限问题。';
    if (code === 'active_session') return '你和对方已经有一条语音连接，不能重复发起；请先挂断当前连接。';
    if (code === 'bad_message' || code === 'bad_json') return '本机客户端发送的信令格式异常；请刷新页面或重启客户端。';
    return `服务端信令错误：${fallback}`;
  }

  private describeRemoteEnd(reason: EndReason): string {
    if (reason === 'busy') return '对方当前处于勿扰或隐身状态，未接入你的语音；不是你这边的麦克风问题。';
    if (reason === 'unavailable') return '对方当前不在线或语音不可用；不是你这边的麦克风问题。';
    if (reason === 'unauthorized') return '服务端拒绝了本次语音连接；这是权限问题，不是麦克风或网络问题。';
    if (reason === 'rejected') return '对方已拒绝本次语音；不是你这边的麦克风或网络问题。';
    if (reason === 'hangup') return '对方已挂断本次语音。';
    if (reason === 'network') return '对方的语音连接因网络中断结束；问题在双方网络链路，不是麦克风权限。';
    if (reason === 'replaced') return '对方在另一个客户端重新上线，本次连接已被替换。';
    return '应用正在关闭，本次语音已结束。';
  }
}
