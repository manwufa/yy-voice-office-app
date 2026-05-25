import { contextBridge, ipcRenderer } from 'electron';

type TrayCommand = 'show' | 'toggle-mute' | 'toggle-speaker' | 'hangup';

contextBridge.exposeInMainWorld('desktop', {
  getRuntimeConfig: () => ipcRenderer.invoke('runtime-config'),
  checkForUpdate: (updateFeedUrl: string) => ipcRenderer.invoke('check-update', updateFeedUrl),
  installUpdate: (updateFeedUrl: string) => ipcRenderer.invoke('install-update', updateFeedUrl),
  getOpenAtLogin: () => ipcRenderer.invoke('get-open-at-login'),
  setOpenAtLogin: (enabled: boolean) => ipcRenderer.invoke('set-open-at-login', enabled),
  onTrayCommand: (callback: (command: TrayCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: TrayCommand) => callback(command);
    ipcRenderer.on('tray-command', listener);
    return () => ipcRenderer.removeListener('tray-command', listener);
  }
});
