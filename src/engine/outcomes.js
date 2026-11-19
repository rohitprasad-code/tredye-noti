'use strict';

/**
 * Alert outcome tracking — measures what price actually did after each alert, so the
 * scoring (agree count, OB status, strength, time of day…) can be judged on evidence.
 *
 * For every directional alert (side BULL → long, BEAR → short) we record, all as
 * DIRECTIONAL % (positive = moved in the alert's favour):
 *   ret_5m / ret_15m / ret_30m / ret_60m  price change N minutes after the alert
 *   ret_close                            change to the session close (15:30 IST)
 *   mfe_pct / mae_pct                    max favourable / max adverse excursion until close
 *   t1_hit_at / t2_hit_at / stop_hit_at  first time each reference level traded
 *   first_hit                            'T1' or 'STOP', whichever came first
 *
 * Price sources: the intraday shard candles (high/low catch extremes between polls)
 * plus the live LTP each poll. Only candles that STARTED at/after the alert are used,
 * so pre-alert prices never leak into MFE/MAE.
 *
 * Conservative conventions (so the report never flatters the signals):
 *   - If T1 and the stop trade inside the same candle, the STOP is counted first.
 *   - Reference levels already on the wrong side of entry at alert time are ignored.
 *   - Horizons that fall after 15:30 are left empty rather than filled with the close.
 *   - A horizon return is only taken from live LTP if the poll landed within
 *     `lateToleranceMs` of the target time; otherwise from the candle that closed at or
 *     before the target. If neither exists the field stays null (not guessed).
 */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const HORIZONS_MIN = [5, 15, 30, 60];

function istDateKey(ms) {
  return new Date(Number(ms) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinuteOfDay(ms) {
  const d = new Date(Number(ms) + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function sessionCloseMs(dateKey) {
  return Date.parse(`${dateKey}T15:30:00+05:30`);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round3(v) {
  return isNum(v) ? Math.round(v * 1000) / 1000 : null;
}

/** Directional % move from entry to price. */
function dirRet(dir, entry, price) {
  if (!isNum(entry) || entry <= 0 || !isNum(price)) return null;
  return round3(((price - entry) / entry) * 100 * dir);
}

/**
 * Builds the initial outcome row for a freshly inserted alert, or null when the alert
 * is not a directional, priced setup (e.g. FLAT reminders).
 */
function createOutcomeSeed(alertId, alert, sourceMode = null) {
  const side = alert?.side;
  if (side !== 'BULL' && side !== 'BEAR') return null;
  const entry = Number(alert.ltp);
  if (!isNum(entry) || entry <= 0) return null;
  const dir = side === 'BULL' ? 1 : -1;
  const createdAt = Number(alert.createdAt || Date.now());

  // Keep only levels on the correct side of entry (a "target" already behind price
  // would register as an instant, meaningless hit)
  const validTarget = v => (isNum(v) && v > 0 && (v - entry) * dir > 0 ? v : null);
  const validStop = v => (isNum(v) && v > 0 && (entry - v) * dir > 0 ? v : null);

  return {
    alert_id: alertId,
    symbol: alert.symbol,
    type: alert.type,
    side,
    dir,
    entry_price: entry,
    stop_price: validStop(Number(alert.invalidation)),
    t1_price: validTarget(Number(alert.target1)),
    t2_price: validTarget(Number(alert.target2)),
    created_at: createdAt,
    session_date: istDateKey(createdAt),
    source_mode: sourceMode,
    status: 'TRACKING',
    ret_5m: null,
    ret_15m: null,
    ret_30m: null,
    ret_60m: null,
    ret_close: null,
    mfe_pct: 0,
    mae_pct: 0,
    stop_hit_at: null,
    t1_hit_at: null,
    t2_hit_at: null,
    first_hit: null,
    last_price: entry,
    last_seen_at: createdAt,
    updated_at: createdAt,
  };
}

/**
 * Advances one outcome row with the latest market information. Pure: returns a new row.
 *
 * @param {object} row          current outcome row (see createOutcomeSeed)
 * @param {object} ctx
 * @param {Array}  ctx.candles  intraday candles `[t(sec), o, h, l, c, ...]` for the symbol
 * @param {number} ctx.candleMin candle length in minutes (default 3)
 * @param {number} ctx.ltp      current last price (optional)
 * @param {number} ctx.nowMs
 * @param {number} ctx.lateToleranceMs how late a poll may be and still supply a horizon price
 */
function advanceOutcome(row, ctx = {}) {
  if (!row || row.status !== 'TRACKING') return row;
  const out = { ...row };
  const nowMs = Number(ctx.nowMs || Date.now());
  const candleMs = Math.max(1, Number(ctx.candleMin || 3)) * 60000;
  const lateToleranceMs = Number(ctx.lateToleranceMs ?? 150000);
  const dir = Number(out.dir) || (out.side === 'BULL' ? 1 : -1);
  const entry = Number(out.entry_price);
  const t0 = Number(out.created_at);
  const closeMs = sessionCloseMs(out.session_date);
  const ltp = Number(ctx.ltp);
  const liveOk = isNum(ltp) && ltp > 0 && nowMs <= closeMs && istDateKey(nowMs) === out.session_date;

  const dayCandles = (Array.isArray(ctx.candles) ? ctx.candles : [])
    .filter(c => Array.isArray(c) && isNum(Number(c[0])) && istDateKey(Number(c[0]) * 1000) === out.session_date)
    .sort((a, b) => a[0] - b[0]);
  const postCandles = dayCandles.filter(c => Number(c[0]) * 1000 >= t0);

  // Price samples after the alert, in time order: { at, hi, lo }
  const samples = postCandles.map(c => ({ at: Number(c[0]) * 1000, hi: Number(c[2]), lo: Number(c[3]) }));
  if (liveOk) samples.push({ at: nowMs, hi: ltp, lo: ltp });

  for (const s of samples) {
    if (!isNum(s.hi) || !isNum(s.lo)) continue;
    const fav = dir > 0 ? dirRet(1, entry, s.hi) : dirRet(-1, entry, s.lo);
    const adv = dir > 0 ? -dirRet(1, entry, s.lo) : -dirRet(-1, entry, s.hi);
    if (isNum(fav) && fav > out.mfe_pct) out.mfe_pct = fav;
    if (isNum(adv) && adv > out.mae_pct) out.mae_pct = adv;

    const reached = level => (dir > 0 ? s.hi >= level : s.lo <= level);
    const stopped = level => (dir > 0 ? s.lo <= level : s.hi >= level);
    const earlier = (cur, at) => (cur === null || cur === undefined || at < cur ? at : cur);
    if (isNum(out.stop_price) && stopped(out.stop_price)) out.stop_hit_at = earlier(out.stop_hit_at, s.at);
    if (isNum(out.t1_price) && reached(out.t1_price)) out.t1_hit_at = earlier(out.t1_hit_at, s.at);
    if (isNum(out.t2_price) && reached(out.t2_price)) out.t2_hit_at = earlier(out.t2_hit_at, s.at);
  }

  // Which came first (same candle → STOP, conservatively)
  const sh = out.stop_hit_at;
  const th = out.t1_hit_at;
  if (isNum(sh) && (!isNum(th) || sh <= th)) out.first_hit = 'STOP';
  else if (isNum(th)) out.first_hit = 'T1';
  else out.first_hit = null;

  // Fixed-horizon returns
  for (const h of HORIZONS_MIN) {
    const key = `ret_${h}m`;
    if (out[key] !== null && out[key] !== undefined) continue;
    const target = t0 + h * 60000;
    if (target > closeMs || nowMs < target) continue;
    let price = null;
    if (liveOk && nowMs - target <= lateToleranceMs) {
      price = ltp;
    } else {
      // Last candle that had fully closed by the target time (and started after the alert)
      const closed = postCandles.filter(c => Number(c[0]) * 1000 + candleMs <= target);
      if (closed.length) price = Number(closed[closed.length - 1][4]);
    }
    if (isNum(price)) out[key] = dirRet(dir, entry, price);
  }

  if (liveOk) {
    out.last_price = ltp;
    out.last_seen_at = nowMs;
  }

  // Finalize after the session close
  if (nowMs >= closeMs) {
    let closePrice = null;
    const last = dayCandles[dayCandles.length - 1];
    if (last && Number(last[0]) * 1000 + candleMs >= closeMs - 2 * candleMs) {
      closePrice = Number(last[4]);
    } else if (isNum(out.last_seen_at) && out.last_seen_at >= closeMs - 15 * 60000) {
      closePrice = Number(out.last_price);
    }
    out.ret_close = isNum(closePrice) ? dirRet(dir, entry, closePrice) : null;
    out.status = out.ret_close !== null ? 'DONE' : 'INCOMPLETE';
  }

  out.mfe_pct = round3(out.mfe_pct);
  out.mae_pct = round3(out.mae_pct);
  out.updated_at = nowMs;
  return out;
}

// ---------- Edge report ----------

function avg(vals) {
  const v = vals.filter(isNum);
  return v.length ? round3(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

function median(vals) {
  const v = vals.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return round3(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

function summarize(rows) {
  const closed = rows.filter(r => isNum(r.ret_close));
  const withLevels = rows.filter(r => isNum(r.stop_price) && isNum(r.t1_price) && r.status !== 'TRACKING');
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  return {
    n: rows.length,
    nClosed: closed.length,
    winRatePct: pct(closed.filter(r => r.ret_close > 0).length, closed.length),
    avgRet15: avg(rows.map(r => r.ret_15m)),
    avgRet60: avg(rows.map(r => r.ret_60m)),
    avgRetClose: avg(closed.map(r => r.ret_close)),
    medianRetClose: median(closed.map(r => r.ret_close)),
    avgMfe: avg(rows.map(r => r.mfe_pct)),
    avgMae: avg(rows.map(r => r.mae_pct)),
    nWithLevels: withLevels.length,
    t1FirstPct: pct(withLevels.filter(r => r.first_hit === 'T1').length, withLevels.length),
    stopFirstPct: pct(withLevels.filter(r => r.first_hit === 'STOP').length, withLevels.length),
    t2HitPct: pct(withLevels.filter(r => isNum(r.t2_hit_at)).length, withLevels.length),
  };
}

function timeBucket(ms) {
  const m = istMinuteOfDay(ms);
  if (m < 10 * 60) return '1 · Open 09:15–10:00';
  if (m < 11 * 60 + 30) return '2 · Morning 10:00–11:30';
  if (m < 13 * 60 + 30) return '3 · Midday 11:30–13:30';
  return '4 · Late 13:30–15:30';
}

function strengthBucket(v) {
  if (!isNum(v)) return 'n/a';
  if (v < 50) return '1 · <50';
  if (v < 65) return '2 · 50–65';
  if (v < 80) return '3 · 65–80';
  return '4 · 80+';
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) ?? 'n/a';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.entries()]
    .map(([key, rs]) => ({ key: String(key), ...summarize(rs) }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/**
 * @param {Array} rows joined alert + outcome rows (snake_case DB columns)
 */
function buildEdgeReport(rows = [], { minSample = 20 } = {}) {
  const usable = rows.filter(r => r && r.status);
  return {
    minSample,
    overall: summarize(usable),
    byAgree: groupBy(usable, r => (isNum(r.agree) ? `${r.agree}/${r.total_checks ?? '?'}` : 'n/a')),
    byObStatus: groupBy(usable, r => r.ob_status || 'none'),
    byType: groupBy(usable, r => r.type),
    bySide: groupBy(usable, r => r.side),
    byStrength: groupBy(usable, r => strengthBucket(r.strength_score)),
    byTimeOfDay: groupBy(usable, r => timeBucket(r.created_at)),
    bySector: groupBy(usable, r => r.sector || 'n/a').sort((a, b) => b.n - a.n),
    counts: {
      tracking: usable.filter(r => r.status === 'TRACKING').length,
      done: usable.filter(r => r.status === 'DONE').length,
      incomplete: usable.filter(r => r.status === 'INCOMPLETE').length,
    },
  };
}

module.exports = {
  HORIZONS_MIN,
  istDateKey,
  sessionCloseMs,
  createOutcomeSeed,
  advanceOutcome,
  summarize,
  buildEdgeReport,
};
