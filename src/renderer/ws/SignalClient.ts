import type { ClientMessage, PeerPresence, ServerMessage, UserProfile } from '../../shared/protocol.js';

type SignalStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface SignalClientOptions {
  url: string;
  userId: string;
  displayName?: string;
}

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SignalStatus) => void;

export class SignalClient {
  private readonly options: SignalClientOptions;
  private socket: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempt = 0;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private status: SignalStatus = 'idle';

  user: UserProfile | null = null;
  peers: PeerPresence[] = [];

  constructor(options: SignalClientOptions) {
    this.options = options;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const url = this.makeUrl();
    this.socket = new WebSocket(url);

    this.socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setStatus('connected');
    });

    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      if (message.type === 'server.hello') {
        this.user = message.user;
        this.peers = message.peers;
      }
      if (message.type === 'presence.update') {
        this.peers = upsertPeer(this.peers, message.peer);
      }
      if (message.type === 'heartbeat.ping') {
        this.send({ type: 'heartbeat.pong', at: Date.now() });
      }
      for (const listener of this.messageListeners) listener(message);
    });

    this.socket.addEventListener('close', () => {
      if (!this.shouldReconnect) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    });

    this.socket.addEventListener('error', () => {
      this.socket?.close();
    });
  }

  close(): void {
    this.shouldReconnect = false;
    this.socket?.close();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    this.setStatus('reconnecting');
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.reconnectAttempt, 5));
    window.setTimeout(() => {
      if (this.shouldReconnect) this.connect();
    }, delay);
  }

  private makeUrl(): string {
    const url = new URL(this.options.url);
    url.searchParams.set('userId', this.options.userId);
    if (this.options.displayName) url.searchParams.set('displayName', this.options.displayName);
    return url.toString();
  }

  private setStatus(status: SignalStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function upsertPeer(peers: PeerPresence[], peer: PeerPresence): PeerPresence[] {
  const next = peers.filter((item) => item.id !== peer.id);
  next.push(peer);
  return next.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
