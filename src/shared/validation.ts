import { z } from 'zod';

const presenceStatusSchema = z.enum(['online', 'away', 'dnd', 'offline']);
const voiceModeSchema = z.enum(['sendrecv', 'sendonly', 'recvonly']);
const endReasonSchema = z.enum([
  'hangup',
  'busy',
  'unavailable',
  'unauthorized',
  'network',
  'replaced',
  'app-close'
]);

const sdpSchema = z.object({
  type: z.enum(['answer', 'offer', 'pranswer', 'rollback']),
  sdp: z.string().optional()
});

const iceCandidateSchema = z
  .object({
    candidate: z.string().optional(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional()
  })
  .passthrough();

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('presence.update'),
    status: presenceStatusSchema,
    voiceAvailable: z.boolean()
  }),
  z.object({
    type: z.literal('voice.session.request'),
    sessionId: z.string().min(1),
    toUserId: z.string().min(1),
    mode: voiceModeSchema
  }),
  z.object({
    type: z.literal('voice.session.accepted'),
    sessionId: z.string().min(1),
    toUserId: z.string().min(1)
  }),
  z.object({
    type: z.literal('voice.sdp'),
    sessionId: z.string().min(1),
    toUserId: z.string().min(1),
    description: sdpSchema
  }),
  z.object({
    type: z.literal('voice.ice'),
    sessionId: z.string().min(1),
    toUserId: z.string().min(1),
    candidate: iceCandidateSchema.nullable()
  }),
  z.object({
    type: z.literal('voice.session.end'),
    sessionId: z.string().min(1),
    toUserId: z.string().min(1),
    reason: endReasonSchema
  }),
  z.object({
    type: z.literal('heartbeat.pong'),
    at: z.number()
  })
]);
