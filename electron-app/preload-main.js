const { ipcRenderer } = require('electron');

try {
  const token = ipcRenderer.sendSync('get-auth-token');
  if (token) {
    localStorage.setItem('cm_token', token);

    // When login screen appears (e.g. after logout), reload so preload re-injects token
    window.addEventListener('DOMContentLoaded', () => {
      const loginScreen = document.getElementById('screen-login');
      if (!loginScreen) return;
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.target.classList.contains('active')) {
            window.location.reload();
            return;
          }
        }
      }).observe(loginScreen, { attributes: true, attributeFilter: ['class'] });
    });
  }
} catch {}
