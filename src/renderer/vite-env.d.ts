/// <reference types="vite/client" />

type TrayCommand = 'show' | 'toggle-mute' | 'toggle-speaker' | 'hangup';

interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  version: string;
  notes?: string;
  platformKey: string;
  changedFiles: number;
  downloadBytes: number;
  unsupportedReason?: string;
}

interface UpdateInstallResult {
  started: boolean;
  check: UpdateCheckResult;
  scriptPath?: string;
  targetDir?: string;
}

interface DesktopBridge {
  getRuntimeConfig: () => Promise<{
    signalServerUrl: string;
    updateFeedUrl: string;
    platform: NodeJS.Platform;
  }>;
  checkForUpdate: (updateFeedUrl: string) => Promise<UpdateCheckResult>;
  installUpdate: (updateFeedUrl: string) => Promise<UpdateInstallResult>;
  getOpenAtLogin: () => Promise<boolean>;
  setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
  onTrayCommand: (callback: (command: TrayCommand) => void) => () => void;
}

interface Window {
  desktop?: DesktopBridge;
}
