/// <reference types="vite/client" />

type TrayCommand = 'show' | 'toggle-mute' | 'toggle-speaker' | 'hangup';

interface DesktopBridge {
  getRuntimeConfig: () => Promise<{
    signalServerUrl: string;
    platform: NodeJS.Platform;
  }>;
  getOpenAtLogin: () => Promise<boolean>;
  setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
  onTrayCommand: (callback: (command: TrayCommand) => void) => () => void;
}

interface Window {
  desktop?: DesktopBridge;
}
