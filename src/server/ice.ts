import type { IceConfig, IceServerConfig } from '../shared/protocol.js';

function splitCsv(value: string | undefined): string[] {
  return value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function makeIceConfig(env: NodeJS.ProcessEnv = process.env): IceConfig {
  const iceServers: IceServerConfig[] = [];
  const stunUrls = splitCsv(env.STUN_URLS ?? 'stun:stun.l.google.com:19302');
  const turnUrls = splitCsv(env.TURN_URLS);

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls });
  }

  if (turnUrls.length > 0 && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL
    });
  }

  return {
    iceServers,
    iceTransportPolicy: env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all'
  };
}
