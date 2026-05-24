import type { IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';
import type { UserProfile } from '../shared/protocol.js';

export function authenticateRequest(req: IncomingMessage): UserProfile | null {
  const base = `http://${req.headers.host ?? '127.0.0.1'}`;
  const url = new URL(req.url ?? '/', base);
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : undefined;
  const token = bearer ?? url.searchParams.get('token') ?? undefined;
  const jwtSecret = process.env.JWT_SECRET;

  if (token && jwtSecret) {
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (typeof payload === 'object') {
        const id = sanitizeId(String(payload.sub ?? payload.userId ?? ''));
        const displayName = sanitizeDisplayName(String(payload.name ?? payload.displayName ?? id));
        if (id && displayName) {
          return {
            id,
            displayName,
            teamId: 'online'
          };
        }
      }
    } catch {
      return null;
    }
  }

  const displayName = sanitizeDisplayName(
    url.searchParams.get('displayName') ?? url.searchParams.get('name') ?? ''
  );
  const devUserId = sanitizeId(
    url.searchParams.get('userId') ?? (token?.startsWith('dev:') ? token.slice(4) : '')
  );

  if (!displayName || !devUserId) return null;

  return {
    id: devUserId,
    displayName,
    teamId: 'online'
  };
}

function sanitizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 40);
}

function sanitizeId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}
