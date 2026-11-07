'use strict';

async function sendTelegramNotification({ title, message, symbol, dashboardUrl = 'http://localhost:4600' }) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) {
    return { ok: false, skipped: true };
  }

  const tretUrl = symbol
    ? `https://www.tredye.com/pulse/?view=orderflow#${encodeURIComponent(symbol)}`
    : 'https://www.tredye.com/pulse/?view=orderflow';

  const text = `${title}\n\n${message}\n\n🔗 Dashboard: ${dashboardUrl}\n📊 Tredye: ${tretUrl}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `Telegram HTTP ${res.status}: ${errText.slice(0, 120)}` };
    }
    return { ok: true, channel: 'telegram' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendTelegramNotification };

