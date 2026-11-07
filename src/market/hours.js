'use strict';

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

function getISTParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of formatter.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const hour = Number(parts.hour === '24' ? 0 : parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const minutesOfDay = hour * 60 + minute;
  return {
    dateStr,
    weekday: parts.weekday,
    hour,
    minute,
    second,
    minutesOfDay,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} IST`,
    shortTimeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`,
  };
}

function getMarketStatus(date = new Date()) {
  const ist = getISTParts(date);
  const isWeekend = ist.weekday === 'Sat' || ist.weekday === 'Sun';
  const isHoliday = NSE_HOLIDAYS.has(ist.dateStr);
  const openMin = 9 * 60 + 15;  // 09:15 IST
  const closeMin = 15 * 60 + 30; // 15:30 IST
  const preOpenMin = 9 * 60;     // 09:00 IST

  let phase = 'CLOSED';
  let open = false;
  if (!isWeekend && !isHoliday) {
    if (ist.minutesOfDay >= openMin && ist.minutesOfDay <= closeMin) {
      phase = 'LIVE';
      open = true;
    } else if (ist.minutesOfDay >= preOpenMin && ist.minutesOfDay < openMin) {
      phase = 'PRE_OPEN';
    } else if (ist.minutesOfDay < preOpenMin) {
      phase = 'BEFORE_OPEN';
    } else {
      phase = 'AFTER_CLOSE';
    }
  } else if (isHoliday) {
    phase = 'HOLIDAY';
  } else {
    phase = 'WEEKEND';
  }

  return {
    open,
    phase,
    ist,
    isTradingDay: !isWeekend && !isHoliday,
    sessionWindow: '09:15–15:30 IST',
  };
}

function formatISTTime(unixSecOrMs) {
  if (!unixSecOrMs) return '—';
  const ms = unixSecOrMs < 1e11 ? unixSecOrMs * 1000 : unixSecOrMs;
  return new Date(ms).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

module.exports = {
  NSE_HOLIDAYS,
  getISTParts,
  getMarketStatus,
  formatISTTime,
};

