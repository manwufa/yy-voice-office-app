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
import { LocalMediaUnavailableError, VoiceClient } from './webrtc/VoiceClient.js';
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
  const [updateBusy, setUpdateBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [incomingRequest, setIncomingRequest] = useState<{ peerId: UserId; sessionId: string; note?: string } | null>(null);
  const [incomingCountdown, setIncomingCountdown] = useState(0);
  const signalRef = useRef<SignalClient | null>(null);
  const voiceRef = useRef<VoiceClient | null>(null);
  const peersRef = useRef<PeerPresence[]>([]);
  const signalWasConnectedRef = useRef(false);
  const pendingSinceRef = useRef(new Map<string, number>());
  const pendingNotifiedRef = useRef(new Set<string>());

  const visiblePeers = useMemo(() => normalizePeerList(peers), [peers]);
  const selectedPeer = useMemo(
    () => visiblePeers.find((peer) => peer.id === selectedPeerId) ?? null,
    [selectedPeerId, visiblePeers]
  );
  const selectedSession = useMemo(
    () => sessions.find((session) => session.peerId === selectedPeerId) ?? null,
    [sessions, selectedPeerId]
  );
  const incomingPeer = useMemo(
    () => visiblePeers.find((peer) => peer.id === incomingRequest?.peerId) ?? null,
    [incomingRequest?.peerId, visiblePeers]
  );

  useEffect(() => {
    peersRef.current = visiblePeers;
  }, [visiblePeers]);

  useEffect(() => {
    void window.desktop?.getRuntimeConfig().then((config) => {
      setSignalUrl(config.signalServerUrl);
      setUpdateFeedUrl(config.updateFeedUrl);
    });
    void window.desktop?.getOpenAtLogin().then(setOpenAtLogin);
  }, []);

  const disconnect = useCallback(() => {
    voiceRef.current?.hangupAll('app-close');
    signalRef.current?.close(1000, 'manual-disconnect');
    signalRef.current = null;
    voiceRef.current = null;
    signalWasConnectedRef.current = false;
    setSignalStatus('closed');
    setPeers([]);
    setSessions([]);
    setSelectedPeerId(null);
    setMicReady(false);
  }, []);

  const handleSignalMessage = useCallback(
    async (signal: SignalClient, message: ServerMessage) => {
      if (message.type === 'server.hello') {
        setPeers(normalizePeerList(message.peers));
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
        if (message.peer.status === 'offline') {
          setSessions((current) => current.filter((session) => session.peerId !== message.peer.id));
          setSelectedPeerId((current) => (current === message.peer.id ? null : current));
        }
      }

      await voiceRef.current?.handleSignal(message);
    },
    [muted, presenceMode, speakerMuted]
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

    signal.onStatus((status) => {
      setSignalStatus(status);
      if (status === 'connected') {
        signalWasConnectedRef.current = true;
        return;
      }
      if (status === 'reconnecting' && signalWasConnectedRef.current) {
        setNotice('本机到信令服务器的网络连接中断，正在重连；这不是麦克风权限问题，也不代表对方离线。');
      }
    });
    signal.onClose((info) => {
      if (info.code === 4401) {
        setNotice('本机连接信令服务器被拒绝：登录身份或令牌未授权。不是麦克风权限问题，也不是对方问题。');
      } else if (info.code !== 1000 && info.code !== 1005 && info.code !== 1006) {
        setNotice(`本机信令连接已断开（${info.code}${info.reason ? `：${info.reason}` : ''}）；请检查本机网络、VPN 或信令地址。`);
      } else if (info.code === 1006) {
        setNotice('本机到信令服务器的网络连接异常断开；请检查本机网络、VPN 或信令地址。');
      }
    });
    signal.onMessage((message) => {
      void handleSignalMessage(signal, message);
    });
    signal.connect();
  }, [disconnect, displayName, handleSignalMessage, signalUrl, userId]);

  const openPeer = useCallback(
    (peerId: UserId) => {
      setSelectedPeerId(peerId);
      setNotice('');
      const existingSession = sessions.find(
        (session) => session.peerId === peerId && session.state !== 'ended' && session.state !== 'failed'
      );
      if (existingSession) {
        setNotice(`你和 ${selectedPeer?.displayName ?? '对方'} 已有语音连接，不能重复发起。`);
        return;
      }
      if (!voiceRef.current || signalStatus !== 'connected') {
        setNotice('本机尚未连接到信令服务器，无法发起语音；这是你这边的网络/连接问题，不是对方问题。');
        return;
      }
      if (!voiceAvailable) {
        setNotice('你当前处于勿扰或隐身模式，已禁止自己发起/接入语音；这是本机状态设置，不是对方问题。');
        return;
      }
      void voiceRef.current
        .startConversation(peerId, intentNote)
        .then(() => setMicReady(true))
        .catch((error) => {
          setNotice(describeLocalAudioStartError(error));
        });
    },
    [intentNote, selectedPeer?.displayName, sessions, signalStatus, voiceAvailable]
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
        .catch((error) => {
          setNotice(describeLocalMicrophoneError(error, '开启你的麦克风'));
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
      .catch((error) => {
        voiceRef.current?.keepOneWay(incomingRequest.peerId);
        setNotice(`${describeLocalMicrophoneError(error, '开启你的麦克风')} 已保持单向收听。`);
      });
    setIncomingRequest(null);
  }, [incomingRequest]);

  const keepIncomingOneWay = useCallback(() => {
    if (!incomingRequest) return;
    voiceRef.current?.keepOneWay(incomingRequest.peerId);
    setIncomingRequest(null);
  }, [incomingRequest]);

  const checkUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    try {
      if (window.desktop?.checkForUpdate && window.desktop?.installUpdate) {
        setNotice('正在检查桌面客户端更新...');
        const update = await window.desktop.checkForUpdate(updateFeedUrl);
        if (update.unsupportedReason) {
          setNotice(update.unsupportedReason);
          return;
        }
        if (!update.available) {
          setNotice(`当前已是最新版本：${update.currentVersion}`);
          return;
        }

        const sizeText = formatBytes(update.downloadBytes);
        const installNow = window.confirm(
          `发现版本 ${update.version}，需要增量下载 ${sizeText}，共 ${update.changedFiles} 个文件。\n\n现在下载并重启更新吗？`
        );
        if (!installNow) {
          setNotice(`发现版本 ${update.version}，已取消更新。`);
          return;
        }

        setNotice(`正在下载增量更新（${sizeText}），下载后会自动重启客户端...`);
        const result = await window.desktop.installUpdate(updateFeedUrl);
        if (!result.started) {
          setNotice(result.check.available ? '更新未启动，请稍后重试。' : `当前已是最新版本：${result.check.currentVersion}`);
          return;
        }
        setNotice('增量更新已下载，正在关闭客户端并覆盖当前目录...');
        return;
      }

      const response = await fetch(updateFeedUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const manifest = (await response.json()) as UpdateManifest;
      setNotice(`最新版本：${manifest.version}${manifest.notes ? `，${manifest.notes}` : ''}`);
    } catch (error) {
      setNotice(describeUpdateCheckError(error, updateFeedUrl, Boolean(window.desktop?.checkForUpdate && window.desktop?.installUpdate)));
    } finally {
      setUpdateBusy(false);
    }
  }, [updateBusy, updateFeedUrl]);

  useEffect(() => {
    const closeConnections = () => {
      voiceRef.current?.hangupAll('app-close');
      signalRef.current?.close(1000, 'app-close');
    };

    window.addEventListener('pagehide', closeConnections);
    window.addEventListener('beforeunload', closeConnections);
    return () => {
      window.removeEventListener('pagehide', closeConnections);
      window.removeEventListener('beforeunload', closeConnections);
      closeConnections();
    };
  }, []);

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
          {visiblePeers.map((peer) => {
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
          <button className="link-button" onClick={checkUpdate} disabled={updateBusy}>
            {updateBusy ? '更新中' : '检查更新'}
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

function describeUpdateCheckError(error: unknown, updateFeedUrl: string, usingDesktopUpdater: boolean): string {
  const detail = error instanceof Error && error.message ? `；底层错误：${error.message}` : '';
  const side = usingDesktopUpdater ? '本机桌面客户端主进程' : '本机页面';
  const hint = usingDesktopUpdater
    ? '请检查本机网络、代理或 DNS；这通常不是 xz42 更新服务本身不可用。'
    : '如果这是旧桌面包，可能缺少软件内更新桥接，或被 file:// 跨域策略拦截；请从下载页获取新版客户端。';
  return `${side}没有成功读取更新清单：${updateFeedUrl}${detail}。${hint}`;
}

function makeSessionUserId(): string {
  const random = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `guest-${random.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}`;
}

function upsertPeer(peers: PeerPresence[], peer: PeerPresence): PeerPresence[] {
  const peerName = normalizeDisplayName(peer.displayName);
  if (peer.status === 'offline') {
    return peers.filter((item) => item.id !== peer.id && normalizeDisplayName(item.displayName) !== peerName);
  }

  const next = peers.filter((item) => item.id !== peer.id && normalizeDisplayName(item.displayName) !== peerName);
  next.push(peer);
  return normalizePeerList(next);
}

function normalizePeerList(peers: PeerPresence[]): PeerPresence[] {
  const byName = new Map<string, PeerPresence>();
  for (const peer of peers) {
    if (peer.status === 'offline') continue;
    const key = normalizeDisplayName(peer.displayName);
    const existing = byName.get(key);
    if (!existing || peer.lastSeen >= existing.lastSeen) byName.set(key, peer);
  }

  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function normalizeDisplayName(displayName: string): string {
  return displayName.trim().toLocaleLowerCase();
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeLocalAudioStartError(error: unknown): string {
  if (isMicrophoneError(error)) return describeLocalMicrophoneError(error, '发起语音');
  return '本机创建 WebRTC 语音连接失败；如果信令仍在线，通常是本机浏览器/WebRTC 环境或双方 P2P 网络限制，不是对方麦克风权限问题。';
}

function describeLocalMicrophoneError(error: unknown, action: string): string {
  if (error instanceof LocalMediaUnavailableError) {
    if (error.kind === 'insecure-context') {
      return `本机当前通过 HTTP 非安全页面打开，浏览器禁止网页使用麦克风，无法${action}；请改用 HTTPS 地址或 Electron 客户端。不是对方麦克风问题，也不是信令服务器问题。`;
    }
    return `本机浏览器没有提供麦克风采集 API，无法${action}；通常是 HTTP 页面、浏览器策略或系统权限导致。不是对方问题，也不是信令服务器问题。`;
  }

  const name = error instanceof DOMException ? error.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `本机麦克风权限被拒绝，无法${action}；请在系统或浏览器里允许本应用使用麦克风。不是对方的问题，也不是双方网络问题。`;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return `本机没有检测到可用麦克风，无法${action}；请连接或启用麦克风设备。不是对方的问题。`;
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return `本机麦克风被系统或其他应用占用，无法${action}；请关闭占用麦克风的程序后重试。不是对方的问题。`;
  }
  if (name === 'OverconstrainedError') {
    return `本机麦克风不满足当前采集参数，无法${action}；请切换输入设备或放宽系统音频设置。不是对方的问题。`;
  }

  return `本机麦克风初始化失败，无法${action}；这是你这边的麦克风或系统音频问题，不是对方问题。`;
}

function isMicrophoneError(error: unknown): boolean {
  if (error instanceof LocalMediaUnavailableError) return true;
  if (!(error instanceof DOMException)) return false;
  return [
    'NotAllowedError',
    'SecurityError',
    'NotFoundError',
    'DevicesNotFoundError',
    'NotReadableError',
    'TrackStartError',
    'OverconstrainedError'
  ].includes(error.name);
}
