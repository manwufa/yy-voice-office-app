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
