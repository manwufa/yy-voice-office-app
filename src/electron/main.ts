import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, powerSaveBlocker } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkForIncrementalUpdate, installIncrementalUpdate } from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let powerSaveBlockerId: number | null = null;

const trayIconDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAM/SURBVFhH7VY9aBRBFE5paZkie2sjWFgEbMRKO0srEQS1ESTGnYAWQRCSRsUmRTAoJIigHkTIoYIx+HeFGlIYJIhBFK5Ikdvdu5yn8S53Jln55u7tzbzZvdsLpvODj2N3Z9773pv33lxPz3/sELZw+23hH23R7edr/inss7k9lnDPpYSftoRfTQk/iKRTyFhO/oItSnu5jR0DBi3hrxrO2tByvJIlvCEI5/YSA1FYwp/nxruhJbxlW6zu47Y7Apssx89xgyoPDheCk+M/gkPXisY3TYTjlVAn3EcsZOQdnIPz3+oBsFLcDPZfKRjfDRGD/gHuy0Cj2Dqn/eL9n9I5YWRm3VjDiaA6FicKh2+M4txSTRPw7mvdWBNJxx/jPkM0o09U7Q/eVzUBTxc3jDVRRAvbA24v9y2BdqOFONObz9ZloXEj4Njsb03AxKuKsYY4OrMeHBldU94VbnDfEinhz9Kiq9O/pGFUOTcYJQDPfA2IAIAnH1sZQmty39Tz4YRDhW/Ut2OrO6mAOFtGR9iX8ofVTcCLpZphjNiNABwBoGazT+RPaALwgj7ivIDphaphbCcCLj9sHCd+6R26TROgFiAJaGeUCxifi1+LyE0B/ogmoM/xTnEBk9n4yp7KVjQBjxfi23CwObQ0AY47rAnArKaPKBZAPYJj19e0mY+2U/HoQ2st9h+/VQqf6QjO3CmH7xCwLmDA7aWPIOY7SM9eeUuSRMCBivOTLeN0R1DvIxD1GUTRawIA9Q64/bIRIUWCjgDUfoZAAC1GA4vSDbHIBFiubAeLuT/hPkxb7lsChUGLkHJEgl88I3IYAlAblGac/emJRnshC7SGzhvC3n6pSWFkO+X497hvCRxDu79bMIpoge/5zeD150ZWssu1MO2AmqUotv3/iNuKb1CJjCCdUYA4tdIj6RQy3KeGZhZib0Q4wAx4/qkWrBS3pON8eUs+331Tkd/jxre8CfkIjgIqNOooqJ06Abco3wsardcOWMxFoKAQPRGzAGc/la1q7/WrN4xen3xJgOGE/3LcWDdEEF1FztEcUGluOBGdQibRmScBWgf9265AwWbG0l39De8WjSL1hnCuLXpDu+p0t/AXj5kB5wlMQVsAAAAASUVORK5CYII=';

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
  app.quit();
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

  mainWindow.on('minimize', () => {
    if (!isQuitting) {
      mainWindow?.hide();
    }
  });

  mainWindow.on('close', () => {
    isQuitting = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function createTray(): void {
  const iconSize = process.platform === 'darwin' ? 18 : 16;
  const icon = nativeImage.createFromDataURL(trayIconDataUrl).resize({ width: iconSize, height: iconSize });
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
  signalServerUrl: process.env.SIGNAL_SERVER_URL ?? 'ws://xz42/wufa/YY/ws',
  updateFeedUrl: process.env.UPDATE_FEED_URL ?? 'http://xz42/wufa/YY/updates/latest.json',
  platform: process.platform
}));

ipcMain.handle('check-update', (_event, updateFeedUrl: string) => checkForIncrementalUpdate(updateFeedUrl));

ipcMain.handle('install-update', async (_event, updateFeedUrl: string) => {
  const result = await installIncrementalUpdate(updateFeedUrl);
  if (result.started) {
    isQuitting = true;
    setTimeout(() => app.quit(), 100);
  }
  return result;
});

ipcMain.handle('get-open-at-login', () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle('set-open-at-login', (_event, enabled: boolean) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true
  });
  return app.getLoginItemSettings().openAtLogin;
});
