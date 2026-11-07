'use strict';

const { formatISTTime } = require('../market/hours');

/**
 * Exact port of Tredye's `sp(candles)` Order Block detection algorithm
 * from `42elg8__kgrje.js`!
 *
 * Each candle tuple is: `[t, open, high, low, close, volume, delta, cvd]`
 *   index 0: unix timestamp (seconds)
 *   index 1: open
 *   index 2: high
 *   index 3: low
 *   index 4: close
 *   index 5: volume
 *   index 6: delta
 *   index 7: cvd
 *
 * Bullish OB (`bull: true`):
 *   Last down candle (`close < open`) before a 1–3 candle impulse move whose max close
 *   breaks above the highest high of the preceding 7 candles (`slice(max(0, l-6), l+1)`)
 *   and moves at least `1.8 * avgCandleRange` from the OB candle's low.
 *
 * Bearish OB (`bull: false`):
 *   Last up candle (`close > open`) before a 1–3 candle impulse move whose min close
 *   breaks below the lowest low of the preceding 7 candles and moves at least
 *   `1.8 * avgCandleRange` from the OB candle's high.
 */
function detectOrderBlocks(candles = [], options = {}) {
  if (!Array.isArray(candles) || candles.length < 8) return [];
  const maxBlocks = options.maxBlocks ?? 4;

  const avgRange =
    candles.reduce((sum, c) => sum + (c[2] - c[3]), 0) / candles.length || 1;

  const candidates = [];
  for (let l = 3; l < candles.length - 1; l++) {
    const r = candles[l];
    const prevWindow = candles.slice(Math.max(0, l - 6), l + 1);
    const nextWindow = candles.slice(l + 1, l + 4);

    for (const bull of [true, false]) {
      // Bullish OB requires a down candle; Bearish OB requires an up candle
      if (bull ? r[4] >= r[1] : r[4] <= r[1]) continue;

      const extremeClose = bull
        ? Math.max(...nextWindow.map(c => c[4]))
        : Math.min(...nextWindow.map(c => c[4]));

      const brokeStructure = bull
        ? extremeClose > Math.max(...prevWindow.map(c => c[2]))
        : extremeClose < Math.min(...prevWindow.map(c => c[3]));

      const move = bull ? extremeClose - r[3] : r[2] - extremeClose;
      if (!brokeStructure || move < 1.8 * avgRange) continue;

      const breakIdx = l + 1 + nextWindow.findIndex(c => c[4] === extremeClose);
      const top = r[2];
      const bot = r[3];
      const postBreakCandles = candles.slice(breakIdx + 1);

      // Tredye's exact mitigation flag: did any candle after break touch into the zone?
      const mit = postBreakCandles.some(c => (bull ? c[3] <= top : c[2] >= bot));

      // Did any candle after break close beyond the invalidation edge of the OB?
      const invalidated = postBreakCandles.some(c => (bull ? c[4] < bot : c[4] > top));

      // Total volume of OB candle + impulse candles up to breakIdx
      const vol = nextWindow
        .slice(0, breakIdx - l)
        .reduce((sum, c) => sum + c[5], r[5]);

      candidates.push({
        bull,
        side: bull ? 'BULL' : 'BEAR',
        action: bull ? 'BUY' : 'SELL',
        i: l,
        t: r[0],
        timeIST: formatISTTime(r[0]),
        top: Number(top.toFixed(2)),
        bot: Number(bot.toFixed(2)),
        mid: Number(((top + bot) / 2).toFixed(2)),
        vol,
        str: Number((move / avgRange).toFixed(2)),
        mit,
        invalidated,
      });
    }
  }

  // Exact Tredye deduplication and sorting: unmitigated first, then highest str
  candidates.sort((a, b) => Number(a.mit) - Number(b.mit) || b.str - a.str);

  const selected = [];
  for (const ob of candidates) {
    const overlaps = selected.some(
      existing =>
        existing.bull === ob.bull &&
        ob.bot <= existing.top &&
        ob.top >= existing.bot
    );
    if (!overlaps && selected.length < maxBlocks) {
      selected.push(ob);
    }
  }

  return selected;
}

/**
 * Computes distance % from `ltp` to an order block `[bot, top]`.
 * Returns 0 when `bot <= ltp <= top` (price is inside the zone).
 */
function computeOBDistance(ltp, ob) {
  if (!ltp || !ob) return null;
  if (ltp >= ob.bot && ltp <= ob.top) {
    return 0;
  }
  if (ltp > ob.top) {
    return Number((((ltp - ob.top) / ltp) * 100).toFixed(3));
  }
  return Number((((ob.bot - ltp) / ltp) * 100).toFixed(3));
}

/**
 * Locates the actionable Order Block for a stock given its flow direction (`BULL` or `BEAR`).
 *
 * - For `BULL` flow (looking for a BUY setup):
 *   Finds Bullish OBs (`bull === true`) that are NOT invalidated (`ltp >= bot` and `!invalidated`),
 *   preferring:
 *     1. Price currently IN ZONE (`bot <= ltp <= top`)
 *     2. Nearest untested Bullish OB at or below price (`ob.top <= ltp * 1.003`)
 *     3. Nearest retested-but-holding Bullish OB below price
 *
 * - For `BEAR` flow (looking for a SELL setup):
 *   Finds Bearish OBs (`bull === false`) that are NOT invalidated (`ltp <= top` and `!invalidated`),
 *   preferring:
 *     1. Price currently IN ZONE (`bot <= ltp <= top`)
 *     2. Nearest untested Bearish OB at or above price (`ob.bot >= ltp * 0.997`)
 *     3. Nearest retested-but-holding Bearish OB above price
 */
function locateActionableOB(stock, detailStock, flowInfo) {
  const ltp = stock?.ltp ?? detailStock?.ltp ?? 0;
  const candles = detailStock?.candles || [];
  const allOBs = detectOrderBlocks(candles, { maxBlocks: 6 });
  const levels = detailStock?.levels || stock?.levels || [];

  const enrichedOBs = allOBs.map(ob => {
    const distPct = computeOBDistance(ltp, ob);
    const inZone = ltp >= ob.bot && ltp <= ob.top;
    // Is price on the valid side of the OB?
    const onValidSide = ob.bull ? ltp >= ob.bot : ltp <= ob.top;
    let status = 'UNTESTED';
    if (inZone && !ob.invalidated) {
      status = 'IN_ZONE';
    } else if (!ob.mit) {
      status = 'UNTESTED';
    } else if (ob.mit && !ob.invalidated && onValidSide) {
      status = 'RETESTED_HELD';
    } else {
      status = 'MITIGATED';
    }
    return {
      ...ob,
      distPct,
      inZone,
      onValidSide,
      status,
    };
  });

  const pickBestForSide = isBullSide => {
    const valid = enrichedOBs.filter(
      ob => ob.bull === isBullSide && ob.onValidSide && !ob.invalidated && ob.status !== 'MITIGATED'
    );
    valid.sort((a, b) => {
      const rankStatus = s => (s === 'IN_ZONE' ? 0 : s === 'UNTESTED' ? 1 : 2);
      return rankStatus(a.status) - rankStatus(b.status) || (a.distPct ?? 999) - (b.distPct ?? 999) || b.str - a.str;
    });
    return valid[0] || null;
  };

  const bestBullOB = pickBestForSide(true);
  const bestBearOB = pickBestForSide(false);

  const wantBull = flowInfo?.side === 'BULL' ? true : flowInfo?.side === 'BEAR' ? false : null;
  let primaryOB = null;

  if (wantBull === true) {
    primaryOB = bestBullOB;
  } else if (wantBull === false) {
    primaryOB = bestBearOB;
  } else {
    primaryOB = enrichedOBs[0] || null;
  }

  const findLevel = label => levels.find(l => l.label === label)?.price ?? null;
  const keyLevels = {
    s1: findLevel('S1'),
    s2: findLevel('S2'),
    r1: findLevel('R1'),
    r2: findLevel('R2'),
    vah: stock?.vah ?? detailStock?.vah ?? null,
    val: stock?.val ?? detailStock?.val ?? null,
    vwap: stock?.vwap ?? detailStock?.vwap ?? null,
    poc: stock?.poc ?? detailStock?.poc ?? null,
  };

  // Reference levels (for review only — never automated execution)
  let referencePlan = null;
  if (primaryOB && ltp) {
    const isBuy = primaryOB.bull;
    const zoneWidth = Math.max(primaryOB.top - primaryOB.bot, ltp * 0.0015);
    const invalidation = isBuy
      ? Number((primaryOB.bot - zoneWidth * 0.25).toFixed(2))
      : Number((primaryOB.top + zoneWidth * 0.25).toFixed(2));

    const t1 = isBuy
      ? keyLevels.r1 || stock?.vah || Number((primaryOB.top + zoneWidth * 2).toFixed(2))
      : keyLevels.s1 || stock?.val || Number((primaryOB.bot - zoneWidth * 2).toFixed(2));
    const t2 = isBuy
      ? keyLevels.r2 || Number((primaryOB.top + zoneWidth * 3.5).toFixed(2))
      : keyLevels.s2 || Number((primaryOB.bot - zoneWidth * 3.5).toFixed(2));

    referencePlan = {
      action: isBuy ? 'BUY ZONE (Bullish OB)' : 'SELL ZONE (Bearish OB)',
      shortAction: isBuy ? 'BUY OB' : 'SELL OB',
      zoneText: `₹${primaryOB.bot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}–₹${primaryOB.top.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      bot: primaryOB.bot,
      top: primaryOB.top,
      mid: primaryOB.mid,
      invalidation: Number(invalidation.toFixed(2)),
      target1: t1 ? Number(Number(t1).toFixed(2)) : null,
      target2: t2 ? Number(Number(t2).toFixed(2)) : null,
      vwap: keyLevels.vwap,
      poc: keyLevels.poc,
    };
  } else if (stock?.ob && (stock.ob.bull > 0 || stock.ob.bear > 0)) {
    // Fallback if shard candles haven't been fetched yet, using summary ob metadata
    const isBuy = flowInfo?.side !== 'BEAR';
    const nearPct = stock.ob.near ?? null;
    const estEdge = nearPct !== null && ltp
      ? Number((isBuy ? ltp * (1 - nearPct / 100) : ltp * (1 + nearPct / 100)).toFixed(2))
      : null;
    referencePlan = {
      action: isBuy ? 'BUY ZONE (Bullish OB)' : 'SELL ZONE (Bearish OB)',
      shortAction: isBuy ? 'BUY OB' : 'SELL OB',
      zoneText: estEdge ? `~₹${estEdge.toLocaleString('en-IN')}` : 'Fetching OB zone…',
      bot: estEdge,
      top: estEdge,
      mid: estEdge,
      invalidation: null,
      target1: levels.find(l => l.label === (isBuy ? 'R1' : 'S1'))?.price ?? null,
      target2: levels.find(l => l.label === (isBuy ? 'R2' : 'S2'))?.price ?? null,
      vwap: stock.vwap,
      poc: stock.poc,
    };
  }

  return {
    allOBs: enrichedOBs.slice(0, 4),
    primaryOB,
    bestBullOB,
    bestBearOB,
    keyLevels,
    referencePlan,
    summaryOB: stock?.ob || null,
  };
}

module.exports = {
  detectOrderBlocks,
  computeOBDistance,
  locateActionableOB,
};

