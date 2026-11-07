'use strict';

const { sendMacNotification } = require('./mac');
const { sendTelegramNotification } = require('./telegram');

async function dispatchAlertNotification(alert, config = {}, dashboardUrl = 'http://localhost:4600') {
  const isInZone = alert.type === 'IN_ZONE' || alert.type === 'REMINDER_DUE';
  const isApproach = alert.type === 'APPROACHING_OB';
  let sound = null;
  if (isInZone && (config.soundOnInZone ?? true)) {
    sound = 'Hero';
  } else if (isApproach && (config.soundOnApproach ?? true)) {
    sound = 'Glass';
  } else {
    sound = 'Pop';
  }

  const subtitle = alert.obBot && alert.obTop
    ? `${alert.action || alert.side} OB ₹${alert.obBot}–₹${alert.obTop}${alert.obDistPct === 0 ? ' (IN ZONE)' : alert.obDistPct != null ? ` (${Number(alert.obDistPct).toFixed(2)}% away)` : ''}`
    : `${alert.side} Flow · LTP ₹${alert.ltp ?? '—'}`;

  const [macRes, tgRes] = await Promise.all([
    sendMacNotification({
      title: alert.title,
      subtitle,
      message: alert.message,
      sound,
      openUrl: `${dashboardUrl}/?symbol=${encodeURIComponent(alert.symbol || '')}`,
    }),
    sendTelegramNotification({
      title: alert.title,
      message: alert.message,
      symbol: alert.symbol,
      dashboardUrl,
    }),
  ]);

  return { mac: macRes, telegram: tgRes };
}

module.exports = { dispatchAlertNotification };

