(function (root) {
  'use strict';

  const IST_TIMEZONE = 'Asia/Kolkata';
  const IST_OFFSET_MS = 330 * 60 * 1000;

  // NSE Market Holidays (2026 list; extend as needed)
  const NSE_HOLIDAYS = new Set([
    '2026-01-26', // Republic Day
    '2026-03-03', // Holi
    '2026-03-26', // Sri Ram Navami
    '2026-03-31', // Mahavir Jayanti
    '2026-04-03', // Good Friday
    '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
    '2026-05-01', // Maharashtra Day
    '2026-05-27', // Bakri Id
    '2026-06-26', // Muharram
    '2026-09-14', // Ganesh Chaturthi
    '2026-10-02', // Mahatma Gandhi Jayanti
    '2026-10-20', // Dussehra
    '2026-11-10', // Diwali-Balipratipada
    '2026-11-24', // Gurunanak Jayanti
    '2026-12-25', // Christmas
  ]);

  const istFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function getISTParts(date = new Date()) {
    const parts = {};
    for (const p of istFormatter.formatToParts(date)) {
      parts[p.type] = p.value;
    }
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour === '24' ? 0 : parts.hour);
    const minute = Number(parts.minute);
    const second = Number(parts.second);
    const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
    const minutesOfDay = hour * 60 + minute;
    const secondsOfDay = minutesOfDay * 60 + second;
    return {
      year,
      month,
      day,
      dateStr,
      weekday: parts.weekday,
      hour,
      minute,
      second,
      minutesOfDay,
      secondsOfDay,
      timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} IST`,
      shortTimeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`,
    };
  }

  function istWallToMs(year, month, day, hour = 0, minute = 0, second = 0) {
    return Date.UTC(year, month - 1, day, hour, minute, second) - IST_OFFSET_MS;
  }

  function isTradingISTDay(weekday, dateStr) {
    return weekday !== 'Sat' && weekday !== 'Sun' && !NSE_HOLIDAYS.has(dateStr);
  }

  function findNextTradingOpen(istParts) {
    const startWallUtc = Date.UTC(istParts.year, istParts.month - 1, istParts.day);
    for (let offset = 1; offset <= 14; offset++) {
      const candidateIstMidnight = new Date(startWallUtc + offset * 86400000 - IST_OFFSET_MS);
      const cand = getISTParts(candidateIstMidnight);
      if (isTradingISTDay(cand.weekday, cand.dateStr)) {
        return {
          ms: istWallToMs(cand.year, cand.month, cand.day, 9, 15, 0),
          weekday: cand.weekday,
          dateStr: cand.dateStr,
        };
      }
    }
    return {
      ms: istWallToMs(istParts.year, istParts.month, istParts.day + 1, 9, 15, 0),
      weekday: istParts.weekday,
      dateStr: istParts.dateStr,
    };
  }

  function formatCountdown(remainingMs) {
    const ms = Math.max(0, Number(remainingMs) || 0);
    const totalSec = Math.ceil(ms / 1000);
    if (totalSec <= 0) return '0s';
    if (totalSec < 60) return `${totalSec}s`;

    const totalMin = Math.ceil(totalSec / 60);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;

    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function getMarketStatus(date = new Date()) {
    const now = date instanceof Date ? date : new Date(date);
    const ist = getISTParts(now);
    const isWeekend = ist.weekday === 'Sat' || ist.weekday === 'Sun';
    const isHoliday = NSE_HOLIDAYS.has(ist.dateStr);
    const isTradingDay = !isWeekend && !isHoliday;
    const preOpenSec = 9 * 3600;           // 09:00:00 IST
    const openSec = 9 * 3600 + 15 * 60;    // 09:15:00 IST
    const closeSec = 15 * 3600 + 30 * 60;  // 15:30:00 IST

    let phase = 'CLOSED';
    let open = false;
    if (isTradingDay) {
      if (ist.secondsOfDay >= openSec && ist.secondsOfDay < closeSec) {
        phase = 'LIVE';
        open = true;
      } else if (ist.secondsOfDay >= preOpenSec && ist.secondsOfDay < openSec) {
        phase = 'PRE_OPEN';
      } else if (ist.secondsOfDay < preOpenSec) {
        phase = 'BEFORE_OPEN';
      } else {
        phase = 'AFTER_CLOSE';
      }
    } else if (isHoliday) {
      phase = 'HOLIDAY';
    } else {
      phase = 'WEEKEND';
    }

    let nextEventMs = 0;
    let targetTimeText = '';
    if (open) {
      nextEventMs = istWallToMs(ist.year, ist.month, ist.day, 15, 30, 0);
      targetTimeText = 'Today 15:30 IST';
    } else if (isTradingDay && ist.secondsOfDay < openSec) {
      nextEventMs = istWallToMs(ist.year, ist.month, ist.day, 9, 15, 0);
      targetTimeText = 'Today 09:15 IST';
    } else {
      const nxt = findNextTradingOpen(ist);
      nextEventMs = nxt.ms;
      targetTimeText = `${nxt.weekday} 09:15 IST`;
    }

    const remainingMs = Math.max(0, nextEventMs - now.getTime());
    const statusLabel = open ? 'Open' : 'Closed';
    const countdownAction = open ? 'closes' : 'opens';
    const countdownText = formatCountdown(remainingMs);
    const shortText = `${statusLabel} · ${countdownAction} ${countdownText}`;
    const detailText = `NSE ${statusLabel} · ${countdownAction} in ${countdownText} (${targetTimeText})`;

    return {
      open,
      phase,
      ist,
      isTradingDay,
      sessionWindow: '09:15–15:30 IST',
      statusLabel,
      countdownAction,
      countdownText,
      shortText,
      targetTimeText,
      detailText,
      nextEventMs,
      remainingMs,
    };
  }

  function formatISTTime(unixSecOrMs) {
    if (!unixSecOrMs) return '—';
    const ms = unixSecOrMs < 1e11 ? unixSecOrMs * 1000 : unixSecOrMs;
    return new Date(ms).toLocaleTimeString('en-IN', {
      timeZone: IST_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  const api = {
    NSE_HOLIDAYS,
    getISTParts,
    getMarketStatus,
    formatISTTime,
    formatCountdown,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.NSEMarketHours = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
