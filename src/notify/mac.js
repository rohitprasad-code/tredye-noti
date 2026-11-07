'use strict';

const { execFile } = require('node:child_process');

function escapeAppleScript(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function sendMacNotification({ title, subtitle = '', message, sound = 'Glass', openUrl = 'http://localhost:4600' }) {
  return new Promise(resolve => {
    const enabled = String(process.env.MAC_NOTIFY ?? 'true').toLowerCase() !== 'false';
    if (!enabled) {
      return resolve({ ok: false, skipped: true });
    }

    const safeTitle = escapeAppleScript(title || 'Tredye Flow Alert');
    const safeSub = escapeAppleScript(subtitle);
    const safeMsg = escapeAppleScript(message || '');
    const safeSound = escapeAppleScript(sound || 'Glass');

    let script = `display notification "${safeMsg}" with title "${safeTitle}"`;
    if (safeSub) {
      script += ` subtitle "${safeSub}"`;
    }
    if (safeSound) {
      script += ` sound name "${safeSound}"`;
    }

    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, err => {
      if (err) {
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true, channel: 'macos', openUrl });
      }
    });
  });
}

module.exports = { sendMacNotification };

