import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, powerSaveBlocker } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let powerSaveBlockerId: number | null = null;

const trayIconDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAP0lEQVR4nGNgGAXDADDC+P//PwMDA8OZM2f+M2fO/GfOnPkfCkYGBgYGBkYGJgYGBgaG/0CxgYGBkaECADYnDyOlG8wRAAAAAElFTkSuQmCC';

app.setAppUserModelId('com.alwayson.voiceoffice');

app.whenReady().then(() => {
  powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    mainWindow?.show();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    title: 'Always-on Voice Office',
    backgroundColor: '#f6f5f0',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(trayIconDataUrl);
  tray = new Tray(icon);
  tray.setToolTip('Always-on Voice Office');
  tray.setContextMenu(makeTrayMenu());
  tray.on('click', () => {
    showMainWindow();
  });
}

function makeTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: '打开',
      click: () => showMainWindow()
    },
    {
      label: '麦克风静音',
      click: () => mainWindow?.webContents.send('tray-command', 'toggle-mute')
    },
    {
      label: '扬声器静音',
      click: () => mainWindow?.webContents.send('tray-command', 'toggle-speaker')
    },
    {
      label: '挂断当前语音',
      click: () => mainWindow?.webContents.send('tray-command', 'hangup')
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function showMainWindow(): void {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

ipcMain.handle('runtime-config', () => ({
  signalServerUrl: process.env.SIGNAL_SERVER_URL ?? 'ws://127.0.0.1:8787/ws',
  platform: process.platform
}));

ipcMain.handle('get-open-at-login', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('set-open-at-login', (_event, enabled: boolean) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true
  });
  return app.getLoginItemSettings().openAtLogin;
});
