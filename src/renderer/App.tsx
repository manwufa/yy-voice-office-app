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

export function App() {
  const [signalUrl, setSignalUrl] = useState(import.meta.env.VITE_SIGNAL_SERVER_URL ?? 'ws://127.0.0.1:8787/ws');
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('displayName') ?? '');
  const [userId] = useState(() => makeSessionUserId());
  const [signalStatus, setSignalStatus] = useState<SignalStatus>('idle');
  const [peers, setPeers] = useState<PeerPresence[]>([]);
  const [selectedPeerId, setSelectedPeerId] = useState<UserId | null>(null);
  const [sessions, setSessions] = useState<VoiceSessionSnapshot[]>([]);
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  const [micReady, setMicReady] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [notice, setNotice] = useState('');
  const signalRef = useRef<SignalClient | null>(null);
  const voiceRef = useRef<VoiceClient | null>(null);

  const selectedPeer = useMemo(
    () => peers.find((peer) => peer.id === selectedPeerId) ?? null,
    [peers, selectedPeerId]
  );
  const selectedSession = useMemo(
    () => sessions.find((session) => session.peerId === selectedPeerId) ?? null,
    [sessions, selectedPeerId]
  );

  useEffect(() => {
    void window.desktop?.getRuntimeConfig().then((config) => {
      setSignalUrl(config.signalServerUrl);
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
        voice.setMuted(muted);
        voice.setSpeakerMuted(speakerMuted);
        voice.setVoiceAvailable(voiceAvailable);
        try {
          await voice.prepareMicrophone();
          setMicReady(true);
        } catch {
          setMicReady(false);
          setNotice('麦克风不可用，语音接入已暂停。');
          voice.setVoiceAvailable(false);
          setVoiceAvailable(false);
        }
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
      void voiceRef.current.startConversation(peerId).catch(() => {
        setNotice('无法建立语音连接，请检查麦克风权限或网络状态。');
      });
    },
    [voiceAvailable]
  );

  const toggleMute = useCallback(() => {
    const next = voiceRef.current?.toggleMuted() ?? !muted;
    setMuted(next);
  }, [muted]);

  const toggleSpeaker = useCallback(() => {
    const next = voiceRef.current?.toggleSpeakerMuted() ?? !speakerMuted;
    setSpeakerMuted(next);
  }, [speakerMuted]);

  const toggleVoiceAvailable = useCallback(() => {
    const next = !voiceAvailable;
    setVoiceAvailable(next);
    voiceRef.current?.setVoiceAvailable(next);
  }, [voiceAvailable]);

  const hangupSelected = useCallback(() => {
    if (selectedPeerId) voiceRef.current?.hangup(selectedPeerId);
  }, [selectedPeerId]);

  useEffect(() => {
    return window.desktop?.onTrayCommand((command) => {
      if (command === 'toggle-mute') toggleMute();
      if (command === 'toggle-speaker') toggleSpeaker();
      if (command === 'hangup') hangupSelected();
    });
  }, [hangupSelected, toggleMute, toggleSpeaker]);

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
                  <small>{peer.voiceAvailable ? sessionLabel(session?.state) : presenceLabel(peer)}</small>
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
            <p>{selectedPeer ? sessionLabel(selectedSession?.state) : '待机'}</p>
            {notice && <div className="notice">{notice}</div>}
          </div>

          <div className="controls">
            <button className={muted ? 'control active' : 'control'} onClick={toggleMute} disabled={!connected}>
              {muted ? <MicOff size={22} /> : <Mic size={22} />}
              <span>{muted ? '已静音' : '麦克风'}</span>
            </button>
            <button className={speakerMuted ? 'control active' : 'control'} onClick={toggleSpeaker} disabled={!connected}>
              {speakerMuted ? <VolumeX size={22} /> : <Volume2 size={22} />}
              <span>{speakerMuted ? '扬声器关' : '扬声器'}</span>
            </button>
            <button className={!voiceAvailable ? 'control active' : 'control'} onClick={toggleVoiceAvailable} disabled={!connected}>
              <BellOff size={22} />
              <span>{voiceAvailable ? '可接入' : '勿扰'}</span>
            </button>
            <button className="control danger" onClick={hangupSelected} disabled={!selectedSession || selectedSession.state === 'ended'}>
              <PhoneOff size={22} />
              <span>挂断</span>
            </button>
          </div>
        </section>

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
          <span>{sessions.length} 个语音会话</span>
        </footer>
      </section>
    </main>
  );
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

function sessionLabel(state?: VoiceSessionSnapshot['state']): string {
  if (state === 'requesting') return '正在请求';
  if (state === 'connecting') return '正在连接';
  if (state === 'connected') return '已连通';
  if (state === 'reconnecting') return '正在恢复';
  if (state === 'failed') return '连接失败';
  if (state === 'ended') return '已挂断';
  return '未连接';
}

function peerSubtitle(peer: PeerPresence, session: VoiceSessionSnapshot | null): string {
  if (session?.manualEnded) return '本次会话已手动挂断';
  if (session) return sessionLabel(session.state);
  return presenceLabel(peer);
}
