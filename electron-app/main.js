const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
nativeTheme.themeSource = 'dark';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update available',
    message: 'A new version of Jonin CT is available. Downloading in the background...',
    buttons: ['OK'],
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update ready',
    message: 'Jonin CT has been updated. Restart now to apply the latest version?',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err.message);
});
const { machineIdSync } = require('node-machine-id');
const Store = require('electron-store');
const fetch = require('node-fetch');
const path = require('path');

const RAILWAY_URL = 'https://copymarket-production.up.railway.app';
const store = new Store({ encryptionKey: 'jonin-ct-local-store' });

let hwid;
try {
  hwid = machineIdSync(true);
} catch {
  hwid = require('crypto').randomBytes(16).toString('hex');
}

let mainWindow = null;
let licenseWindow = null;
let tray = null;

function createLicenseWindow() {
  licenseWindow = new BrowserWindow({
    width: 460,
    height: 540,
    resizable: false,
    frame: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0a0a0f',
  });
  licenseWindow.loadFile(path.join(__dirname, 'license.html'));
}

let _licenseInterval = null;

function startLicensePolling() {
  if (_licenseInterval) clearInterval(_licenseInterval);
  _licenseInterval = setInterval(async () => {
    const key = store.get('licenseKey');
    if (!key || !mainWindow) return;
    try {
      const result = await validateLicense(key);
      if (!result.valid && mainWindow) {
        clearInterval(_licenseInterval);
        _licenseInterval = null;
        store.delete('licenseKey');
        store.delete('authToken');
        mainWindow.close();
        mainWindow = null;
        await dialog.showMessageBox({
          type: 'warning',
          title: 'License Deactivated',
          message: 'Your Jonin CT license has been deactivated.',
          detail: result.message || 'Your Premium CT subscription has ended. Renew on Discord to continue.',
          buttons: ['OK'],
        });
        createLicenseWindow();
      }
    } catch {} // network error — try next cycle
  }, 5 * 60 * 1000); // every 5 minutes
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-main.js'),
    },
    icon: path.join(__dirname, 'icon.png'),
    title: 'Jonin CT',
    backgroundColor: '#0F172A',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0F172A',
      symbolColor: '#94A3B8',
      height: 32,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`${RAILWAY_URL}/app.html`);
  if (!tray) createTray();
  startLicensePolling();
  // Check for updates 5s after launch (give window time to load)
  setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 5000);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function validateLicense(key) {
  const res = await fetch(`${RAILWAY_URL}/api/license/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, hwid }),
    timeout: 12000,
  });
  return res.json();
}

app.whenReady().then(async () => {
  const storedKey = store.get('licenseKey');

  if (storedKey) {
    try {
      const result = await validateLicense(storedKey);
      if (result.valid) {
        if (result.token) store.set('authToken', result.token);
        if (result.walletAddress) store.set('walletAddress', result.walletAddress);
        createMainWindow();
        return;
      }
      // Key is no longer valid — clear it and show license screen
      store.delete('licenseKey');
      createLicenseWindow();
    } catch {
      // Can't reach server
      dialog.showErrorBox(
        'No Internet Connection',
        'Jonin CT requires an internet connection to verify your license.\n\nPlease check your connection and restart the app.'
      );
      app.quit();
    }
    return;
  }

  createLicenseWindow();
});

// Renderer asks to validate a key the user typed
ipcMain.handle('validate-license', async (_event, key) => {
  try {
    const result = await validateLicense(key.trim());
    if (result.valid) {
      store.set('licenseKey', key.trim());
      if (result.token) store.set('authToken', result.token);
      if (result.walletAddress) store.set('walletAddress', result.walletAddress);
      licenseWindow?.close();
      licenseWindow = null;
      createMainWindow();
    }
    return result;
  } catch {
    return { valid: false, message: 'Cannot connect to the server. Check your internet connection and try again.' };
  }
});

// Preload of main window fetches stored session data synchronously
ipcMain.on('get-auth-token', (event) => {
  event.returnValue = store.get('authToken') || null;
});

ipcMain.on('get-wallet-address', (event) => {
  event.returnValue = store.get('walletAddress') || null;
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('quit-app', () => app.quit());

ipcMain.handle('force-logout', () => {
  store.delete('licenseKey');
  store.delete('authToken');
  if (mainWindow) { mainWindow.close(); mainWindow = null; }
  dialog.showMessageBox({
    type: 'warning',
    title: 'License Deactivated',
    message: 'Your Jonin CT license has been deactivated.',
    detail: 'Your Premium CT subscription has ended. Please renew your subscription on Discord to continue using Jonin CT.',
    buttons: ['OK'],
  });
  createLicenseWindow();
});

async function deactivateLicense() {
  const key = store.get('licenseKey');
  if (!key) return;

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Deactivate', 'Cancel'],
    defaultId: 1,
    title: 'Deactivate License',
    message: 'Deactivate on this device?',
    detail: 'Your key will be unlinked from this machine. You can then activate it on another device.\n\nTo get a brand new key, use /shufflekey in the Discord server.',
  });

  if (choice !== 0) return;

  try {
    const res = await fetch(`${RAILWAY_URL}/api/license/self-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (data.success) {
      store.delete('licenseKey');
      store.delete('authToken');
      mainWindow?.close();
      mainWindow = null;
      createLicenseWindow();
    } else {
      dialog.showErrorBox('Error', data.error || 'Failed to deactivate.');
    }
  } catch {
    dialog.showErrorBox('Error', 'Cannot connect to server. Check your internet connection.');
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Jonin CT');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Jonin CT', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Deactivate on this device...', click: deactivateLicense },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
