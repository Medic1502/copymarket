const { ipcRenderer } = require('electron');

try {
  const token  = ipcRenderer.sendSync('get-auth-token');
  const wallet = ipcRenderer.sendSync('get-wallet-address');

  if (token) {
    localStorage.setItem('cm_token', token);
    if (wallet) localStorage.setItem('cm_wallet', wallet);
  }
} catch {}
