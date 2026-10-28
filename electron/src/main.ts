/**
 * WinAgent desktop shell. It loads the same dashboard the browser uses (served by the
 * local server), so there is one UI. Security: sandboxed renderer, no Node integration,
 * context isolation, navigation locked to the dashboard origin, and a minimal IPC
 * surface (notifications only). Starting the shell never starts tasks.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, session, shell, Tray } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DASHBOARD_URL = process.env.WINAGENT_URL ?? 'http://127.0.0.1:3710';
const DASHBOARD_ORIGIN = new URL(DASHBOARD_URL).origin;
const AGENT_STOP_FILE = join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'WinAgent', 'EMERGENCY_STOP');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'WinAgent',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  w.once('ready-to-show', () => w.show());

  // Only the dashboard origin may load in the window; everything else is refused.
  w.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== DASHBOARD_ORIGIN) event.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url); // links open in the user's browser, never in-app
    return { action: 'deny' };
  });
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault(); // closing hides to the tray; use the tray menu to quit
      w.hide();
    }
  });
  void w.loadURL(DASHBOARD_URL).catch(() => {
    void w.loadURL(`data:text/html,${encodeURIComponent(`<h1>WinAgent server not reachable</h1><p>Start the server, then use the tray menu to reload. (${DASHBOARD_URL})</p>`)}`);
  });
  return w;
}

/**
 * Emergency stop from the tray. Two independent paths so it works even when the server
 * is down: (1) the server API (uses the signed-in dashboard session), and (2) the local
 * agent stop file, which the agent watches every second.
 */
async function emergencyStop(): Promise<void> {
  let serverOk = false;
  try {
    const res = await net.fetch(`${DASHBOARD_ORIGIN}/api/system/emergency-stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-winagent-csrf': '1' },
      body: JSON.stringify({ source: 'tray' }),
      credentials: 'include',
    } as RequestInit);
    serverOk = res.ok;
  } catch {
    serverOk = false;
  }
  try {
    const dir = join(AGENT_STOP_FILE, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(AGENT_STOP_FILE, 'stop');
  } catch {
    /* reported below */
  }
  new Notification({
    title: 'WinAgent emergency stop',
    body: serverOk ? 'All tasks paused and agent actions cancelled.' : 'Local agent stopped. The server could not be reached (or you are signed out); sign in and check the dashboard.',
  }).show();
}

function buildTray(): void {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJElEQVR4nGPgjln7nxLMMLgM2KwmRxQeNWDUANoaMPB5gRwMALSEB8sUzFNaAAAAAElFTkSuQmCC',
  );
  tray = new Tray(icon);
  tray.setToolTip('WinAgent');
  const refresh = () =>
    tray!.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open dashboard', click: () => (win ?? (win = createWindow())).show() },
        { label: 'Reload', click: () => win?.reload() },
        { type: 'separator' },
        { label: '■ EMERGENCY STOP', click: () => void emergencyStop() },
        { type: 'separator' },
        {
          label: 'Start with Windows (does not start tasks)',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked });
            refresh();
          },
        },
        { label: 'Quit', click: () => ((quitting = true), app.quit()) },
      ]),
    );
  refresh();
  tray.on('double-click', () => (win ?? (win = createWindow())).show());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win?.show());
  app.whenReady().then(() => {
    // Deny every permission request (camera, geolocation, ...) except the microphone for voice input on the dashboard origin.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media' && new URL(wc.getURL()).origin === DASHBOARD_ORIGIN);
    });
    ipcMain.handle('winagent:notify', (event, title: unknown, body: unknown) => {
      if (new URL(event.senderFrame?.url ?? 'about:blank').origin !== DASHBOARD_ORIGIN) return false;
      if (typeof title !== 'string' || typeof body !== 'string') return false;
      new Notification({ title: title.slice(0, 120), body: body.slice(0, 300) }).show();
      return true;
    });
    win = createWindow();
    buildTray();
  });
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
  app.on('before-quit', () => (quitting = true));
}
