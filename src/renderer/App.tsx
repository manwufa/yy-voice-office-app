import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellOff,
  Circle,
  Headphones,
  LogOut,
  Mic,
  MicOff,
  PhoneOff,
  Power,
  Radio,
  Settings,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff
} from 'lucide-react';
import type { PeerPresence, ServerMessage, UserId, VoiceSessionSnapshot } from '../shared/protocol.js';
import { VoiceClient } from './webrtc/VoiceClient.js';
import { SignalClient } from './ws/SignalClient.js';

type SignalStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
type PresenceMode = 'available' | 'dnd' | 'invisible';

interface UpdateManifest {
  version: string;
  notes?: string;
  downloads?: Partial<Record<NodeJS.Platform | 'windows' | 'macos', string>>;
}

export function App() {
  const [signalUrl, setSignalUrl] = useState(import.meta.env.VITE_SIGNAL_SERVER_URL ?? defaultSignalUrl());
  const [updateFeedUrl, setUpdateFeedUrl] = useState(import.meta.env.VITE_UPDATE_FEED_URL ?? defaultUpdateFeedUrl());
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('displayName') ?? '');
  const [intentNote, setIntentNote] = useState('');
  const [userId] = useState(() => makeSessionUserId());
  const [signalStatus, setSignalStatus] = useState<SignalStatus>('idle');
  const [peers, setPeers] = useState<PeerPresence[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<UserId | null>(null);
  const [sessions, setSessions] = useState<VoiceSessionSnapshot[]>([]);
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [speakerVolume, setSpeakerVolume] = useState(1);
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  const [presenceMode, setPresenceMode] = useState<PresenceMode>('available');
  const [micReady, setMicReady] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [notice, setNotice] = useState('');
  const [incomingRequest, setIncomingRequest] = useState<{ peerId: UserId; sessionId: string; note?: string } | null>(null);
  const [incomingCountdown, setIncomingCountdown] = useState(0);
  const signalRef = useRef<SignalClient | null>(null);
  const voiceRef = useRef<VoiceClient | null>(null);
  const peersRef = useRef<PeerPresence[]>([]);
  const pendingSinceRef = useRef(new Map<string, number>());
  const pendingNotifiedRef = useRef(new Set<string>());

  const selectedPeer = useMemo(
    () => peers.find((peer) => peer.id === selectedPeerId) ?? null,
    [peers, selectedPeerId]
  );
  const selectedSession = useMemo(
    () => sessions.find((session) => session.peerId === selectedPeerId) ?? null,
    [sessions, selectedPeerId]
  );
  const incomingPeer = useMemo(
    () => peers.find((peer) => peer.id === incomingRequest?.peerId) ?? null,
    [incomingRequest?.peerId, peers]
  );

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    void window.desktop?.getRuntimeConfig().then((config) => {
      setSignalUrl(config.signalServerUrl);
      setUpdateFeedUrl(config.updateFeedUrl);
    });
    void window.desktop?.getOpenAtLogin().then(setOpenAtLogin);
  }, []);

  const disconnect = useCallback(() => {
    voiceRef.current?.hangupAll('app-close');
    signalRef.current?.close();
    signalRef.current = null;
    voiceRef.current = null;
    setSignalStatus('closed');
    setPeers([]);
    setSessions([]);
    setSelectedPeerId(null);
    setMicReady(false);
  }, []);

  const handleSignalMessage = useCallback(
    async (signal: SignalClient, message: ServerMessage) => {
      if (message.type === 'server.hello') {
        setPeers(message.peers);
        const voice = new VoiceClient(signal, message.iceConfig);
        voiceRef.current = voice;
        voice.onSnapshots(setSessions);
        voice.onError(setNotice);
        voice.onIncomingRequest((request) => {
          setIncomingRequest(request);
          setSelectedPeerId(request.peerId);
        });
        voice.onFeedback((feedback) => {
          const peerName = peersRef.current.find((peer) => peer.id === feedback.peerId)?.displayName ?? feedback.peerId;
          setNotice(feedbackMessage(peerName, feedback.kind));
        });
        voice.setMuted(muted);
        voice.setSpeakerMuted(speakerMuted);
        voice.setSpeakerVolume(speakerVolume);
        voice.setPresenceMode(presenceMode);
        return;
      }

      if (message.type === 'presence.update') {
        setPeers((current) => upsertPeer(current, message.peer));
      }

      await voiceRef.current?.handleSignal(message);
    },
    [muted, speakerMuted, voiceAvailable]
  );

  const connect = useCallback(() => {
    const name = displayName.trim();
    if (!name) {
      setNotice('请输入你的名字。');
      return;
    }

    localStorage.setItem('displayName', name);
    disconnect();
    setNotice('');
    const signal = new SignalClient({ url: signalUrl, userId, displayName: name });
    signalRef.current = signal;

    signal.onStatus(setSignalStatus);
    signal.onMessage((message) => {
      void handleSignalMessage(signal, message);
    });
    signal.connect();
  }, [disconnect, displayName, handleSignalMessage, signalUrl, userId]);

  const openPeer = useCallback(
    (peerId: UserId) => {
      setSelectedPeerId(peerId);
      setNotice('');
      if (!voiceRef.current || !voiceAvailable) return;
      void voiceRef.current
        .startConversation(peerId, intentNote)
        .then(() => setMicReady(true))
        .catch(() => {
          setNotice('无法建立语音连接，请检查麦克风权限或网络状态。');
        });
    },
    [intentNote, voiceAvailable]
  );

  const toggleMute = useCallback(() => {
    const next = voiceRef.current?.toggleMuted() ?? !muted;
    setMuted(next);
  }, [muted]);

  const handleMicControl = useCallback(() => {
    if (selectedPeerId && selectedSession && !selectedSession.localAudioEnabled && selectedSession.state !== 'ended') {
      void voiceRef.current
        ?.enableMicrophone(selectedPeerId)
        .then(() => setMicReady(true))
        .catch(() => {
          setNotice('无法开启录音，请检查麦克风权限。');
        });
      return;
    }
    toggleMute();
  }, [selectedPeerId, selectedSession, toggleMute]);

  const toggleSpeaker = useCallback(() => {
    const next = voiceRef.current?.toggleSpeakerMuted() ?? !speakerMuted;
    setSpeakerMuted(next);
  }, [speakerMuted]);

  const changeSpeakerVolume = useCallback((volume: number) => {
    setSpeakerVolume(volume);
    voiceRef.current?.setSpeakerVolume(volume);
  }, []);

  const cyclePresenceMode = useCallback(() => {
    const next: PresenceMode =
      presenceMode === 'available' ? 'dnd' : presenceMode === 'dnd' ? 'invisible' : 'available';
    setPresenceMode(next);
    setVoiceAvailable(next === 'available');
    voiceRef.current?.setPresenceMode(next);
  }, [presenceMode]);

  const hangupSelected = useCallback(() => {
    if (selectedPeerId) voiceRef.current?.hangup(selectedPeerId);
  }, [selectedPeerId]);

  const rejectIncoming = useCallback(() => {
    if (!incomingRequest) return;
    voiceRef.current?.rejectIncoming(incomingRequest.peerId);
    setIncomingRequest(null);
  }, [incomingRequest]);

  const enableIncomingMic = useCallback(() => {
    if (!incomingRequest) return;
    void voiceRef.current
      ?.enableMicrophone(incomingRequest.peerId)
      .then(() => setMicReady(true))
      .catch(() => {
        setNotice('无法开启录音，请检查麦克风权限。');
      });
    setIncomingRequest(null);
  }, [incomingRequest]);

  const keepIncomingOneWay = useCallback(() => {
    if (!incomingRequest) return;
    voiceRef.current?.keepOneWay(incomingRequest.peerId);
    setIncomingRequest(null);
  }, [incomingRequest]);

  const checkUpdate = useCallback(async () => {
    try {
      const response = await fetch(updateFeedUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = (await response.json()) as UpdateManifest;
      setNotice(`最新版本：${manifest.version}${manifest.notes ? `，${manifest.notes}` : ''}`);
    } catch {
      setNotice('无法检查更新，请确认更新服务可访问。');
    }
  }, [updateFeedUrl]);

  useEffect(() => {
    return window.desktop?.onTrayCommand((command) => {
      if (command === 'toggle-mute') toggleMute();
      if (command === 'toggle-speaker') toggleSpeaker();
      if (command === 'hangup') hangupSelected();
    });
  }, [hangupSelected, toggleMute, toggleSpeaker]);

  useEffect(() => {
    if (!incomingRequest) return;

    setIncomingCountdown(30);
    const intervalId = window.setInterval(() => {
      setIncomingCountdown((value) => Math.max(0, value - 1));
    }, 1_000);
    const timeoutId = window.setTimeout(() => {
      voiceRef.current?.keepOneWay(incomingRequest.peerId);
      setIncomingRequest(null);
      setNotice('已自动保持单向收听，未开启你的麦克风。');
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [incomingRequest]);

  useEffect(() => {
    if (!incomingRequest) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === '1') rejectIncoming();
      if (event.key === '2') enableIncomingMic();
      if (event.key === '3') keepIncomingOneWay();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enableIncomingMic, incomingRequest, keepIncomingOneWay, rejectIncoming]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      for (const session of sessions) {
        const pending =
          session.direction === 'outgoing' &&
          !session.peerFeedback &&
          session.state !== 'ended' &&
          session.state !== 'failed';

        if (!pending) {
          pendingSinceRef.current.delete(session.sessionId);
          pendingNotifiedRef.current.delete(session.sessionId);
          continue;
        }

        if (!pendingSinceRef.current.has(session.sessionId)) {
          pendingSinceRef.current.set(session.sessionId, now);
        }

        const since = pendingSinceRef.current.get(session.sessionId) ?? now;
        if (now - since >= 30_000 && !pendingNotifiedRef.current.has(session.sessionId)) {
          const peerName = peersRef.current.find((peer) => peer.id === session.peerId)?.displayName ?? session.peerId;
          setNotice(`${peerName} 暂未回应，当前仍保持单向呼叫。`);
          pendingNotifiedRef.current.add(session.sessionId);
        }
      }
    }, 1_000);

    return () => window.clearInterval(intervalId);
  }, [sessions]);

  const connected = signalStatus === 'connected';

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Radio size={18} />
          </div>
          <div>
            <h1>Voice Office</h1>
            <p>{statusText(signalStatus)}</p>
          </div>
        </div>

        <div className="login-panel">
          <label>
            <span>名字</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={connected}
              maxLength={40}
              placeholder="输入你的名字"
            />
          </label>
          <label>
            <span>信令</span>
            <input value={signalUrl} onChange={(event) => setSignalUrl(event.target.value)} disabled={connected} />
          </label>
          <label>
            <span>备注</span>
            <input
              value={intentNote}
              onChange={(event) => setIntentNote(event.target.value)}
              maxLength={120}
              placeholder="找对方的简短原因"
            />
          </label>
          <button className={connected ? 'danger' : 'primary'} onClick={connected ? disconnect : connect}>
            {connected ? <LogOut size={16} /> : <Power size={16} />}
            {connected ? '断开' : '上线'}
          </button>
        </div>

        <div className="contact-list">
          {peers.map((peer) => {
            const session = sessions.find((item) => item.peerId === peer.id);
            return (
              <button
                key={peer.id}
                className={peer.id === selectedPeerId ? 'contact active' : 'contact'}
                onClick={() => openPeer(peer.id)}
              >
                <span className={`presence-dot ${peer.status}`} />
                <span>
                  <strong>{peer.displayName}</strong>
                  <small>{peer.voiceAvailable ? sessionLabel(session) : presenceLabel(peer)}</small>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h2>{selectedPeer ? selectedPeer.displayName : '在线语音'}</h2>
            <p>{selectedPeer ? peerSubtitle(selectedPeer, selectedSession) : '有人上线后会自动出现在左侧列表'}</p>
          </div>
          <div className="status-cluster">
            <span className={connected ? 'pill ok' : 'pill'}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
              {connected ? '在线' : '离线'}
            </span>
            <span className={micReady ? 'pill ok' : 'pill warn'}>
              <Circle size={12} />
              {micReady ? '麦克风就绪' : '麦克风未就绪'}
            </span>
          </div>
        </header>

        <section className="voice-surface">
          <div className="call-focus">
            <div className="avatar-ring">
              <Headphones size={56} />
            </div>
            <h3>{selectedPeer ? selectedPeer.displayName : '未选择联系人'}</h3>
            <p>{selectedPeer ? sessionLabel(selectedSession) : '待机'}</p>
            {notice && <div className="notice">{notice}</div>}
          </div>

          <div className="controls">
            <button className={muted ? 'control active' : 'control'} onClick={handleMicControl} disabled={!connected}>
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
              <span>{micControlLabel(selectedSession, muted)}</span>
            </button>
            <button className={speakerMuted ? 'control active' : 'control'} onClick={toggleSpeaker} disabled={!connected}>
              {speakerMuted ? <VolumeX size={22} /> : <Volume2 size={22} />}
              <span>{speakerMuted ? '扬声器关' : '扬声器'}</span>
            </button>
            <button className={presenceMode !== 'available' ? 'control active' : 'control'} onClick={cyclePresenceMode} disabled={!connected}>
              <BellOff size={22} />
              <span>{presenceModeLabel(presenceMode)}</span>
            </button>
            <button className="control danger" onClick={hangupSelected} disabled={!selectedSession || selectedSession.state === 'ended'}>
              <PhoneOff size={22} />
              <span>挂断</span>
            </button>
          </div>
          <label className="volume-control">
            <span>收听音量</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={speakerVolume}
              onChange={(event) => changeSpeakerVolume(Number(event.target.value))}
            />
            <strong>{Math.round(speakerVolume * 100)}%</strong>
          </label>
        </section>

        {incomingRequest && (
          <div className="incoming-overlay" role="dialog" aria-modal="true">
            <div className="incoming-dialog">
              <h3>{incomingPeer?.displayName ?? incomingRequest.peerId}</h3>
              <p>{incomingRequest.note ? incomingRequest.note : '对方正在找你说话'}</p>
              <small>当前只听，不发送你的麦克风。{incomingCountdown} 秒后自动保持单向。</small>
              <div className="incoming-actions">
                <button className="control danger" onClick={rejectIncoming}>
                  1 拒绝
                </button>
                <button className="control active" onClick={enableIncomingMic}>
                  2 开启录音
                </button>
                <button className="control" onClick={keepIncomingOneWay}>
                  3 保持单向
                </button>
              </div>
            </div>
          </div>
        )}

        <footer className="footerbar">
          <label className="startup-toggle">
            <Settings size={16} />
            <input
              type="checkbox"
              checked={openAtLogin}
              onChange={(event) => {
                const checked = event.target.checked;
                setOpenAtLogin(checked);
                void window.desktop?.setOpenAtLogin(checked).then(setOpenAtLogin);
              }}
            />
            开机启动
          </label>
          <button className="link-button" onClick={checkUpdate}>
            检查更新
          </button>
          <span>{sessions.length} 个语音会话</span>
        </footer>
      </section>
    </main>
  );
}

function defaultSignalUrl(): string {
  if (window.location.protocol === 'file:') return 'ws://xz42/wufa/YY/ws';
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = window.location.pathname.startsWith('/wufa/YY/') ? '/wufa/YY' : '';
  return `${wsProtocol}//${window.location.host}${basePath}/ws`;
}

function defaultUpdateFeedUrl(): string {
  if (window.location.protocol === 'file:') return 'http://xz42/wufa/YY/updates/latest.json';
  const basePath = window.location.pathname.startsWith('/wufa/YY/') ? '/wufa/YY' : '';
  return `${window.location.origin}${basePath}/updates/latest.json`;
}

function makeSessionUserId(): string {
  const random = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `guest-${random.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}`;
}

function upsertPeer(peers: PeerPresence[], peer: PeerPresence): PeerPresence[] {
  const next = peers.filter((item) => item.id !== peer.id);
  next.push(peer);
  return next.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function statusText(status: SignalStatus): string {
  if (status === 'connected') return '信令已连接';
  if (status === 'connecting') return '正在上线';
  if (status === 'reconnecting') return '正在重连';
  if (status === 'closed') return '已离线';
  return '待上线';
}

function presenceLabel(peer: PeerPresence): string {
  if (peer.status === 'dnd') return '勿扰';
  if (peer.status === 'offline') return '离线';
  return peer.voiceAvailable ? '可语音' : '不可接入';
}

function sessionLabel(session?: VoiceSessionSnapshot | null): string {
  if (!session) return '未连接';
  if (session.state === 'connected' && session.direction === 'outgoing') {
    if (session.peerFeedback === 'mic-enabled') return '双向语音';
    if (session.peerFeedback === 'one-way') return '对方单向收听';
    if (session.peerFeedback === 'rejected') return '已拒绝';
    return '等待对方回应';
  }
  if (session.state === 'connected' && session.direction === 'incoming' && !session.localAudioEnabled) return '单向收听';
  if (session.state === 'connected' && session.direction === 'incoming' && session.localAudioEnabled) return '双向语音';
  if (session.state === 'requesting') return '正在请求';
  if (session.state === 'connecting') return '正在连接';
  if (session.state === 'connected') return '已连通';
  if (session.state === 'reconnecting') return '正在恢复';
  if (session.state === 'failed') return '连接失败';
  if (session.state === 'ended' && session.reason === 'rejected') return '已拒绝';
  if (session.state === 'ended') return '已挂断';
  return '未连接';
}

function peerSubtitle(peer: PeerPresence, session: VoiceSessionSnapshot | null): string {
  if (session?.reason === 'rejected') return '对方已拒绝';
  if (session?.manualEnded) return '本次会话已手动挂断';
  if (session) return sessionLabel(session);
  return presenceLabel(peer);
}

function micControlLabel(session: VoiceSessionSnapshot | null, muted: boolean): string {
  if (session && !session.localAudioEnabled && session.state !== 'ended') return '开启录音';
  return muted ? '已静音' : '麦克风';
}

function feedbackMessage(peerName: string, kind: 'rejected' | 'mic-enabled' | 'one-way'): string {
  if (kind === 'rejected') return `${peerName} 拒绝了本次语音`;
  if (kind === 'mic-enabled') return `${peerName} 已开启录音，进入双向语音`;
  return `${peerName} 选择保持单向收听`;
}

function presenceModeLabel(mode: PresenceMode): string {
  if (mode === 'dnd') return '勿扰';
  if (mode === 'invisible') return '隐身';
  return '可接入';
}
