'use strict';

/**
 * Trade-side (aggressor) volume classifier for the Upstox WebSocket V3 full feed.
 *
 * Why: the original UPSTOX_LIVE mode derived `buy_pct` from resting book totals
 * (tbq / (tbq + tsq)) — the SAME inputs as book imbalance `imb`. Two of the five
 * confluence checks were therefore one signal counted twice, and both were built on
 * resting orders, which are the easiest thing on the tape to spoof.
 *
 * This tracker instead estimates who was aggressive on each traded lot:
 *   1. Quote rule (vs the quote that prevailed BEFORE the trade):
 *        ltp >= prior best ask → aggressive BUY (lifted the offer)
 *        ltp <= prior best bid → aggressive SELL (hit the bid)
 *        otherwise compare to the prior mid
 *   2. Tick rule fallback (no quote, or ltp exactly at mid):
 *        uptick → BUY, downtick → SELL, zero tick → previous direction
 * Volume per update = increase in cumulative day volume (`vtt`).
 *
 * Limits (be honest about them): the full feed is a snapshot stream, not every print.
 * When several trades land between snapshots, the whole volume delta is assigned to
 * the side implied by the last trade. Over hundreds of updates this is a usable
 * estimate of aggressor share, not an exchange-grade trade-by-trade delta.
 * Classification starts when the WebSocket starts — if you connect at 11:00 the
 * numbers cover 11:00 onward. `coveragePct` reports this.
 */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function istDateKey(ms) {
  return new Date(Number(ms) + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

class AggressorTracker {
  constructor({ minSamples = 20 } = {}) {
    this.minSamples = minSamples;
    this.bySymbol = new Map();
  }

  _fresh(dateKey, vtt) {
    return {
      dateKey,
      lastVtt: vtt,
      lastLtp: null,
      lastBid: null,
      lastAsk: null,
      lastDir: 0,
      buyVol: 0,
      sellVol: 0,
      unclassifiedVol: 0,
      samples: 0,
      // per-price split: paise price → [buyVol, sellVol, unclassifiedVol]
      levels: new Map(),
      firstTs: null,
    };
  }

  /**
   * @param {string} symbol
   * @param {{ ltp:number, vtt:number, bid?:number, ask?:number, ts?:number }} tick
   *   vtt = cumulative day volume, bid/ask = CURRENT best quote in this snapshot,
   *   ts = exchange last-trade time (ms) used for the session date.
   * @returns {object|null} current stats for the symbol
   */
  update(symbol, tick = {}) {
    const ltp = num(tick.ltp);
    const vtt = num(tick.vtt);
    if (!symbol || !ltp || ltp <= 0 || vtt === null) return this.get(symbol);

    const dateKey = istDateKey(tick.ts || Date.now());
    let st = this.bySymbol.get(symbol);

    // New session, first sighting, or a volume reset → start fresh, nothing to classify yet
    if (!st || st.dateKey !== dateKey || vtt < st.lastVtt) {
      st = this._fresh(dateKey, vtt);
      st.lastLtp = ltp;
      st.lastBid = num(tick.bid);
      st.lastAsk = num(tick.ask);
      this.bySymbol.set(symbol, st);
      return this.get(symbol);
    }

    const dVol = vtt - st.lastVtt;
    if (dVol > 0) {
      let dir = 0;
      const bid = st.lastBid;
      const ask = st.lastAsk;
      if (ask && ask > 0 && ltp >= ask) dir = 1;
      else if (bid && bid > 0 && ltp <= bid) dir = -1;
      else if (bid && ask && bid > 0 && ask > bid) {
        const mid = (bid + ask) / 2;
        dir = ltp > mid ? 1 : ltp < mid ? -1 : 0;
      }
      if (dir === 0 && st.lastLtp) {
        dir = ltp > st.lastLtp ? 1 : ltp < st.lastLtp ? -1 : st.lastDir;
      }

      if (dir > 0) st.buyVol += dVol;
      else if (dir < 0) st.sellVol += dVol;
      else st.unclassifiedVol += dVol;
      if (dir !== 0) st.lastDir = dir;
      st.samples += 1;

      // the whole delta is booked at this snapshot's LTP (see "Limits" above)
      const key = Math.round(ltp * 100);
      let cell = st.levels.get(key);
      if (!cell) { cell = [0, 0, 0]; st.levels.set(key, cell); }
      cell[dir > 0 ? 0 : dir < 0 ? 1 : 2] += dVol;
      if (st.firstTs === null) st.firstTs = Number(tick.ts) || Date.now();
    }

    st.lastVtt = vtt;
    st.lastLtp = ltp;
    // Quote for the NEXT trade's classification (prevailing-quote rule)
    const nb = num(tick.bid);
    const na = num(tick.ask);
    if (nb && nb > 0) st.lastBid = nb;
    if (na && na > 0) st.lastAsk = na;
    return this.get(symbol);
  }

  get(symbol) {
    const st = this.bySymbol.get(symbol);
    if (!st) return null;
    const classified = st.buyVol + st.sellVol;
    const buyPct = classified > 0 ? Number(((st.buyVol / classified) * 100).toFixed(2)) : null;
    return {
      buyVol: st.buyVol,
      sellVol: st.sellVol,
      unclassifiedVol: st.unclassifiedVol,
      delta: st.buyVol - st.sellVol,
      buyPct,
      samples: st.samples,
      coveragePct: st.lastVtt > 0 ? Number(((classified / st.lastVtt) * 100).toFixed(1)) : 0,
      reliable: buyPct !== null && st.samples >= this.minSamples,
      dateKey: st.dateKey,
    };
  }

  /**
   * Buy / sell / unclassified volume by price, binned into `bins` equal bands over the
   * traded range, for the volume-at-price ladder. Prices are bin edges in rupees; bin i
   * covers [lo + i·step, lo + (i+1)·step). Returns null until something was classified.
   * `since` = exchange time (ms) of the first classified update: earlier volume is unknown.
   */
  profile(symbol, { bins = 48, now = Date.now() } = {}) {
    const st = this.bySymbol.get(symbol);
    if (!st || !st.levels.size) return null;
    if (st.dateKey !== istDateKey(now)) return null;   // yesterday's split never leaks into today
    let lo = Infinity;
    let hi = -Infinity;
    for (const key of st.levels.keys()) {
      if (key < lo) lo = key;
      if (key > hi) hi = key;
    }
    const n = hi > lo ? Math.max(1, Math.floor(bins)) : 1;
    const step = hi > lo ? (hi - lo) / n : 0;
    const b = new Array(n).fill(0);
    const s = new Array(n).fill(0);
    const u = new Array(n).fill(0);
    for (const [key, cell] of st.levels) {
      const i = step > 0 ? Math.min(n - 1, Math.floor((key - lo) / step)) : 0;
      b[i] += cell[0];
      s[i] += cell[1];
      u[i] += cell[2];
    }
    const classified = st.buyVol + st.sellVol;
    return {
      lo: lo / 100,
      hi: hi / 100,
      b,
      s,
      u,
      since: st.firstTs,
      coveragePct: st.lastVtt > 0 ? Number(((classified / st.lastVtt) * 100).toFixed(1)) : 0,
    };
  }

  reset() {
    this.bySymbol.clear();
  }
}

module.exports = { AggressorTracker, istDateKey };
