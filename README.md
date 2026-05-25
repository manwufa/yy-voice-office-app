# YY Voice Office

Electron + React + Node WebSocket/WebRTC voice client for lightweight remote-office voice communication.

## Features

- Display-name based login; no persistent account database.
- Online presence broadcast: everyone online can see new logins and logouts.
- A starts a voice request to B; B immediately receives A's audio and sees an incoming popup.
- B can reject, enable microphone for two-way voice, or keep one-way listening.
- Manual hangup, microphone mute, speaker mute, and speaker volume controls.
- Do-not-disturb and invisible presence modes.
- WebRTC P2P audio with STUN/TURN support.
- Desktop tray support on Windows and macOS.
- Incremental desktop updates that only download changed app files.

## Download

Current xz42 download page:

`http://xz42/wufa/YY/download`

The page provides Windows x64, macOS Apple Silicon, and macOS Intel zip packages.

## Run Locally

```bash
npm install
npm run dev
```

Use two app windows or browser tabs, enter different names, and click **上线** to test presence and voice flow.

## Environment

Copy `.env.example` and set values as needed:

```bash
PORT=8787
HOST=127.0.0.1
JWT_SECRET=
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=
TURN_USERNAME=
TURN_CREDENTIAL=
SIGNAL_SERVER_URL=ws://127.0.0.1:8787/ws
```

## xz42 Deployment

- App page: `http://xz42/wufa/YY/app/`
- WebSocket: `ws://xz42/wufa/YY/ws`
- Health: `http://xz42/wufa/YY/health`
- Updates manifest: `http://xz42/wufa/YY/updates/latest.json`
- Download page: `http://xz42/wufa/YY/download`
- Remote files live under `/home/wufa/YY`.

Build desktop update packages on xz42:

```bash
cd /home/wufa/YY
./scripts/package-desktop-updates.sh
```
