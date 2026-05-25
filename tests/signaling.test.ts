import { describe, expect, it } from 'vitest';
import type { ServerMessage, UserProfile } from '../src/shared/protocol.js';
import { SignalingHub } from '../src/server/signaling.js';

const users: UserProfile[] = [
  { id: 'alice', displayName: 'Alice', teamId: 'team-a' },
  { id: 'bob', displayName: 'Bob', teamId: 'team-a' },
  { id: 'mallory', displayName: 'Mallory', teamId: 'team-b' }
];

function connectPair() {
  const hub = new SignalingHub({
    iceConfig: { iceServers: [{ urls: 'stun:example.test' }], iceTransportPolicy: 'all' }
  });
  const alice: ServerMessage[] = [];
  const bob: ServerMessage[] = [];
  hub.connect(users[0], (message) => alice.push(message));
  hub.connect(users[1], (message) => bob.push(message));
  return { hub, alice, bob };
}

describe('SignalingHub', () => {
  it('auto-routes a pre-authorized no-answer session', () => {
    const { hub, alice, bob } = connectPair();

    hub.handleMessage('alice', {
      type: 'voice.session.request',
      sessionId: 's1',
      toUserId: 'bob',
      mode: 'sendrecv'
    });

    expect(bob).toContainEqual({
      type: 'voice.session.request',
      sessionId: 's1',
      fromUserId: 'alice',
      mode: 'sendrecv'
    });

    hub.handleMessage('bob', {
      type: 'voice.session.accepted',
      sessionId: 's1',
      toUserId: 'alice'
    });

    expect(alice).toContainEqual({
      type: 'voice.session.accepted',
      sessionId: 's1',
      fromUserId: 'bob'
    });
  });

  it('allows any currently online person to be auto-connected', () => {
    const hub = new SignalingHub();
    const alice: ServerMessage[] = [];
    const mallory: ServerMessage[] = [];
    hub.connect(users[0], (message) => alice.push(message));
    hub.connect(users[2], (message) => mallory.push(message));

    hub.handleMessage('alice', {
      type: 'voice.session.request',
      sessionId: 's2',
      toUserId: 'mallory',
      mode: 'sendrecv'
    });

    expect(mallory).toContainEqual({
      type: 'voice.session.request',
      sessionId: 's2',
      fromUserId: 'alice',
      mode: 'sendrecv'
    });
    expect(alice.some((message) => message.type === 'error')).toBe(false);
  });

  it('announces dynamic login and logout to already online people', () => {
    const hub = new SignalingHub();
    const alice: ServerMessage[] = [];
    const bob: ServerMessage[] = [];

    hub.connect(users[0], (message) => alice.push(message));
    hub.connect(users[1], (message) => bob.push(message));
    hub.disconnect('bob');

    expect(alice).toContainEqual(
      expect.objectContaining({
        type: 'presence.update',
        peer: expect.objectContaining({ id: 'bob', status: 'online', voiceAvailable: true })
      })
    );
    expect(alice).toContainEqual(
      expect.objectContaining({
        type: 'presence.update',
        peer: expect.objectContaining({ id: 'bob', status: 'offline', voiceAvailable: false })
      })
    );
  });

  it('marks heartbeat-stale clients offline', () => {
    let now = 1_000;
    const hub = new SignalingHub({
      now: () => now,
      heartbeatTimeoutMs: 1_000
    });
    const alice: ServerMessage[] = [];
    const bob: ServerMessage[] = [];

    hub.connect(users[0], (message) => alice.push(message));
    hub.connect(users[1], (message) => bob.push(message));
    now += 500;
    hub.handleMessage('alice', { type: 'heartbeat.pong', at: now });
    now += 501;
    hub.makeHeartbeat(now);

    expect(hub.getClientCount()).toBe(1);
    expect(alice).toContainEqual(
      expect.objectContaining({
        type: 'presence.update',
        peer: expect.objectContaining({ id: 'bob', status: 'offline', voiceAvailable: false })
      })
    );
  });

  it('replaces older connections with the same display name', () => {
    const hub = new SignalingHub();
    const alice: ServerMessage[] = [];
    const olderMm: ServerMessage[] = [];
    const newerMm: ServerMessage[] = [];

    hub.connect(users[0], (message) => alice.push(message));
    hub.connect({ id: 'mm-old', displayName: 'MM', teamId: 'online' }, (message) => olderMm.push(message));
    hub.connect({ id: 'mm-new', displayName: 'MM', teamId: 'online' }, (message) => newerMm.push(message));

    expect(hub.getClientCount()).toBe(2);
    expect(hub.getPresence('mm-old')).toBeUndefined();
    expect(hub.getPresence('mm-new')).toMatchObject({ displayName: 'MM', status: 'online' });
    expect(olderMm).toContainEqual(
      expect.objectContaining({
        type: 'voice.session.end',
        reason: 'replaced'
      })
    );
    expect(alice).toContainEqual(
      expect.objectContaining({
        type: 'presence.update',
        peer: expect.objectContaining({ id: 'mm-old', status: 'offline' })
      })
    );
  });

  it('preserves manual hangup semantics by ending the session', () => {
    const { hub, alice, bob } = connectPair();

    hub.handleMessage('alice', {
      type: 'voice.session.request',
      sessionId: 's3',
      toUserId: 'bob',
      mode: 'sendrecv'
    });
    hub.handleMessage('bob', {
      type: 'voice.session.end',
      sessionId: 's3',
      toUserId: 'alice',
      reason: 'hangup'
    });
    hub.handleMessage('alice', {
      type: 'voice.sdp',
      sessionId: 's3',
      toUserId: 'bob',
      description: { type: 'offer', sdp: 'late-offer' }
    });

    expect(hub.getSession('s3')?.state).toBe('ended');
    expect(alice).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'inactive_session',
        sessionId: 's3'
      })
    );
    expect(bob.filter((message) => message.type === 'voice.sdp')).toHaveLength(0);
  });

  it('forwards receiver feedback to the initiator', () => {
    const { hub, alice } = connectPair();

    hub.handleMessage('alice', {
      type: 'voice.session.request',
      sessionId: 's4',
      toUserId: 'bob',
      mode: 'sendonly'
    });
    hub.handleMessage('bob', {
      type: 'voice.feedback',
      sessionId: 's4',
      toUserId: 'alice',
      kind: 'one-way'
    });

    expect(alice).toContainEqual({
      type: 'voice.feedback',
      sessionId: 's4',
      fromUserId: 'bob',
      kind: 'one-way'
    });
  });

  it('rejects a second active session between the same two people', () => {
    const { hub, alice, bob } = connectPair();

    hub.handleMessage('alice', {
      type: 'voice.session.request',
      sessionId: 's5',
      toUserId: 'bob',
      mode: 'sendonly'
    });
    hub.handleMessage('bob', {
      type: 'voice.session.request',
      sessionId: 's6',
      toUserId: 'alice',
      mode: 'sendonly'
    });

    expect(bob).toContainEqual(
      expect.objectContaining({
        type: 'error',
        code: 'active_session',
        sessionId: 's6'
      })
    );
    expect(alice.filter((message) => message.type === 'voice.session.request' && message.sessionId === 's6')).toHaveLength(0);
  });

  it('ends active sessions when a participant disconnects', () => {
    const { hub, alice } = connectPair();

    hub.handleMessage('alice', {
      type: 'voice.session.request',
      sessionId: 's7',
      toUserId: 'bob',
      mode: 'sendonly'
    });
    hub.disconnect('bob');

    expect(hub.getSession('s7')?.state).toBe('ended');
    expect(alice).toContainEqual(
      expect.objectContaining({
        type: 'voice.session.end',
        sessionId: 's7',
        fromUserId: 'bob',
        reason: 'unavailable'
      })
    );
  });

  it('broadcasts presence separately from voice availability', () => {
    const { hub, bob } = connectPair();

    hub.handleMessage('alice', {
      type: 'presence.update',
      status: 'dnd',
      voiceAvailable: true
    });

    expect(hub.getPresence('alice')).toMatchObject({ status: 'dnd', voiceAvailable: false });
    expect(bob).toContainEqual(
      expect.objectContaining({
        type: 'presence.update',
        peer: expect.objectContaining({ id: 'alice', status: 'dnd', voiceAvailable: false })
      })
    );
  });
});
