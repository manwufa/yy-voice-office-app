# Always-on Voice Office

Electron + React + Node WebSocket MVP for no-answer, always-on voice chat.

## Run locally

```bash
npm install
npm run dev
```

Use two app windows or browser tabs, enter different names, and click **上线** to test automatic WebRTC voice setup.

## Core semantics

- There is no persistent user list in the MVP.
- Each login provides a display name and receives an in-memory session id.
- Everyone currently online sees new logins and logouts through presence broadcasts.
- Currently online users are pre-authorized for no-answer voice.
- Opening a contact starts a bidirectional WebRTC audio session.
- The remote side auto-accepts while online and voice-available.
- Manual hangup ends the current session and prevents automatic resume for that session.
- Network failures attempt ICE restart and WebSocket reconnect for non-manual disconnects.
