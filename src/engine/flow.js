'use strict';

/**
 * Exact port of Tredye's order-flow confluence scoring (`sI()` in orderflow bundle)
 * plus a continuous 0–100 Strength Score for ranking the strongest flows.
 *
 * Tredye's 5 confluence checks:
 *   1. ltp > vwap
 *   2. ltp > poc
 *   3. buy_pct > 50
 *   4. cvd > 0
 *   5. depth imbalance > 0 (when imb or depth.tbq + depth.tsq > 0 is present)
 *
 * Each check is BULL, BEAR or NEUTRAL (inside NEUTRAL_BANDS); missing inputs are dropped.
 * score = bullCount - bearCount
 * side  = score > 0 ? 'BULL' : score < 0 ? 'BEAR' : 'FLAT'
 */

function estimateRupeeFlowCr(stock) {
  // Exact port of sA = e => e.cvd * e.ltp / 1e7
  return ((stock.cvd || 0) * (stock.ltp || 0)) / 1e7;
}

function getDepthImbalance(stock) {
  if (stock.imb !== undefined && stock.imb !== null) {
    return Number(stock.imb);
  }
  if (stock.depth && (stock.depth.tbq + stock.depth.tsq) > 0) {
    if (stock.depth.imb !== undefined && stock.depth.imb !== null) {
      return Number(stock.depth.imb);
    }
    return ((stock.depth.tbq - stock.depth.tsq) / (stock.depth.tbq + stock.depth.tsq)) * 100;
  }
  if (stock.depth && Array.isArray(stock.depth.buy) && Array.isArray(stock.depth.sell)) {
    const tbq = stock.depth.buy.reduce((sum, lvl) => sum + Number(lvl?.quantity || 0), 0);
    const tsq = stock.depth.sell.reduce((sum, lvl) => sum + Number(lvl?.quantity || 0), 0);
    if (tbq + tsq > 0) {
      return ((tbq - tsq) / (tbq + tsq)) * 100;
    }
  }
  return null;
}

/**
 * Neutral bands (fix for tie bias): a value inside its band counts for NEITHER side.
 * The original port used `ltp > vwap` for bull and everything else (including exact ties
 * and missing data) for bear, which tilted flat/early-session stocks bearish.
 *   pricePct  : |ltp − level| / level * 100 within this % → neutral (VWAP, POC)
 *   buyPct    : |buy_pct − 50| within this many points → neutral
 *   imbPct    : |book imbalance| within this % → neutral
 *   cvdVolFrac: |cvd| within this fraction of session volume → neutral (exact 0 if volume unknown)
 * Missing inputs drop the check entirely (it no longer counts as bearish).
 */
const NEUTRAL_BANDS = Object.freeze({
  pricePct: 0.03,
  buyPct: 1,
  imbPct: 2,
  cvdVolFrac: 0.001,
});

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function classifySigned(value, band = 0) {
  if (!isNum(value)) return null;
  if (Math.abs(value) <= band) return 0;
  return value > 0 ? 1 : -1;
}

// imb can arrive as -1..1 (fraction) or -100..100 (percent) depending on source
function normalizeImbPct(imb) {
  if (!isNum(imb)) return null;
  return Math.abs(imb) <= 1 ? imb * 100 : imb;
}

function makeCheck(key, label, dir) {
  const state = dir > 0 ? 'BULL' : dir < 0 ? 'BEAR' : 'NEUTRAL';
  return { key, label, state, dir, bull: dir > 0, bear: dir < 0 };
}

function evaluateConfluence(stock, bands = NEUTRAL_BANDS) {
  const b = { ...NEUTRAL_BANDS, ...(bands || {}) };
  const checks = [];
  const ltp = Number(stock.ltp);
  const pctFrom = level => (isNum(ltp) && ltp > 0 && isNum(level) && level > 0 ? ((ltp - level) / level) * 100 : null);

  const vwapDir = classifySigned(pctFrom(stock.vwap), b.pricePct);
  if (vwapDir !== null) checks.push(makeCheck('vwap', 'LTP > VWAP', vwapDir));

  const pocDir = classifySigned(pctFrom(stock.poc), b.pricePct);
  if (pocDir !== null) checks.push(makeCheck('poc', 'LTP > POC', pocDir));

  const buyDir = classifySigned(isNum(stock.buy_pct) ? stock.buy_pct - 50 : null, b.buyPct);
  if (buyDir !== null) checks.push(makeCheck('buy_pct', 'Buy% > 50', buyDir));

  const vol = Number(stock.volume);
  const cvdBand = isNum(vol) && vol > 0 ? vol * b.cvdVolFrac : 0;
  const cvdDir = classifySigned(stock.cvd, cvdBand);
  if (cvdDir !== null) checks.push(makeCheck('cvd', 'CVD > 0', cvdDir));

  const imb = getDepthImbalance(stock);
  const imbDir = classifySigned(normalizeImbPct(imb), b.imbPct);
  if (imbDir !== null) {
    checks.push(makeCheck('imb', 'Book Imb > 0', imbDir));
  } else if (stock.flowScore !== undefined || stock.chg_pct !== undefined) {
    const netFlow = Number(stock.flowScore !== undefined ? stock.flowScore : stock.chg_pct);
    const flowDir = classifySigned(netFlow, 0);
    if (flowDir !== null) checks.push(makeCheck('flow', 'Net Flow > 0', flowDir));
  }

  const bull = checks.filter(c => c.dir > 0).length;
  const bear = checks.filter(c => c.dir < 0).length;
  const neutral = checks.length - bull - bear;
  const n = checks.length;
  const score = bull - bear;
  const side = score > 0 ? 'BULL' : score < 0 ? 'BEAR' : 'FLAT';
  const agree = side === 'BULL' ? bull : side === 'BEAR' ? bear : Math.max(bull, bear);

  return {
    bull,
    bear,
    neutral,
    n,
    agree,
    score,
    side,
    imb,
    checks,
    rupeeFlowCr: estimateRupeeFlowCr(stock),
  };
}

/** 90th percentile of |values| (finite, non-zero), never below `floor`. */
function p90Abs(values, floor) {
  const abs = values.filter(isNum).map(Math.abs).filter(v => v > 0).sort((a, b) => a - b);
  if (!abs.length) return floor;
  const v = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.9))];
  return Math.max(floor, v);
}

/**
 * Average candle range as % of close over the trailing `lookback` candles
 * (candle tuples `[t, o, h, l, c, ...]`). Used as the stock's own intraday volatility unit.
 */
function trailingRangePct(candles = [], lookback = 14) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const tail = candles.slice(-lookback);
  const vals = tail
    .map(c => (Number(c[4]) > 0 ? ((Number(c[2]) - Number(c[3])) / Number(c[4])) * 100 : null))
    .filter(v => isNum(v) && v >= 0);
  if (!vals.length) return null;
  const avg = vals.reduce((a, v) => a + v, 0) / vals.length;
  return avg > 0 ? avg : null;
}

/**
 * Ranks all stocks in an `/api/orderflow` response:
 * 1. Computes exact Tredye tags (`BULLISH #1`, `BEARISH #1`, `MIXED FLOW`) and `chgRank`
 * 2. Computes a 0–100 composite `strengthScore` in the direction of `side`:
 *    - Confluence ratio (agree / n, neutral checks count against): 40 pts
 *    - Buy/sell dominance, scaled by the universe P90 of |buy_pct − 50|: 20 pts
 *    - Rupee CVD, scaled by the universe P90 of |rupeeFlowCr|: 15 pts
 *    - Book imbalance, scaled by the universe P90 of |imb|: 10 pts
 *    - VWAP distance in the stock's own volatility units (ATR%), scaled by the
 *      universe P90 of that distance: 15 pts
 *
 * Every component is relative to what the strongest ~10% of the universe shows right now,
 * instead of fixed constants (/22, /35, /1.25%) that treated a ₹200 PSU bank and a
 * ₹12,000 stock as equally volatile. Floors stop a dead tape from awarding full points
 * to tiny edges.
 *
 * options.volPctBySymbol: { SYMBOL: avgCandleRangePct } (see trailingRangePct). Stocks
 * without it fall back to a raw-% VWAP distance scaled by its own universe P90.
 */
const SCALE_FLOORS = Object.freeze({
  buyEdge: 5,       // pts of buy% away from 50
  imbPct: 10,       // % book imbalance
  vwapAtr: 0.5,     // VWAP distance in ATR units
  vwapPct: 0.25,    // VWAP distance in raw %
});

function scoreAndRankUniverse(stocks = [], options = {}) {
  if (!Array.isArray(stocks) || stocks.length === 0) {
    return {
      bySymbol: {},
      rankedStocks: [],
      topBull: [],
      topBear: [],
      sectors: [],
    };
  }

  const topN = options.topN ?? 5;
  const minPrice = options.minPrice ?? 0;
  const sectorFilter = Array.isArray(options.sectors) && options.sectors.length > 0
    ? new Set(options.sectors.map(s => s.toLowerCase()))
    : null;
  const watchlist = Array.isArray(options.watchlist) && options.watchlist.length > 0
    ? new Set(options.watchlist.map(s => s.toUpperCase()))
    : null;
  const ignoreSymbols = Array.isArray(options.ignoreSymbols) && options.ignoreSymbols.length > 0
    ? new Set(options.ignoreSymbols.map(s => s.toUpperCase()))
    : null;

  const volPctBySymbol = options.volPctBySymbol || {};
  const bands = options.neutralBands || NEUTRAL_BANDS;

  // Evaluate confluence once per stock
  const confBySymbol = new Map(stocks.map(s => [s.symbol, evaluateConfluence(s, bands)]));

  // Universe distributions for relative (percentile) scaling
  const p90FlowCr = p90Abs(stocks.map(estimateRupeeFlowCr), 1e-9);
  const p90BuyEdge = p90Abs(stocks.map(s => (isNum(s.buy_pct) ? s.buy_pct - 50 : null)), SCALE_FLOORS.buyEdge);
  const p90Imb = p90Abs([...confBySymbol.values()].map(c => normalizeImbPct(c.imb)), SCALE_FLOORS.imbPct);

  const vwapDistPct = s => (isNum(s.vwap) && s.vwap > 0 && isNum(s.ltp) ? ((s.ltp - s.vwap) / s.vwap) * 100 : null);
  const vwapAtrUnits = s => {
    const d = vwapDistPct(s);
    const vol = Number(volPctBySymbol[s.symbol]);
    return d !== null && vol > 0 ? d / vol : null;
  };
  const p90VwapAtr = p90Abs(stocks.map(vwapAtrUnits), SCALE_FLOORS.vwapAtr);
  const p90VwapPct = p90Abs(
    stocks.filter(s => vwapAtrUnits(s) === null).map(vwapDistPct),
    SCALE_FLOORS.vwapPct
  );
  const clamp01 = v => Math.max(0, Math.min(1, v));

  // Sort by % change descending for Tredye's chgRank
  const chgSortedSymbols = [...stocks]
    .sort((a, b) => (b.chg_pct ?? 0) - (a.chg_pct ?? 0))
    .map(s => s.symbol);

  const items = stocks.map(s => {
    const conf = confBySymbol.get(s.symbol) || evaluateConfluence(s, bands);
    const dir = conf.side === 'BULL' ? 1 : conf.side === 'BEAR' ? -1 : 0;

    // 1. Confluence component (0–40)
    const confluencePts = conf.n > 0 ? (conf.agree / conf.n) * 40 : 0;

    // 2. Buy/Sell dominance component (0–20)
    const signedBuyEdge = ((isNum(s.buy_pct) ? s.buy_pct : 50) - 50) * dir;
    const buyDominancePts = clamp01(signedBuyEdge / p90BuyEdge) * 20;

    // 3. Rupee CVD component (0–15)
    const signedFlowCr = conf.rupeeFlowCr * dir;
    const cvdPts = clamp01(signedFlowCr / p90FlowCr) * 15;

    // 4. Depth imbalance component (0–10)
    const normImb = normalizeImbPct(conf.imb);
    const imbRatio = normImb !== null
      ? clamp01((normImb * dir) / p90Imb)
      : 0.5; // neutral when market closed / depth unavailable
    const depthPts = imbRatio * 10;

    // 5. VWAP impulse component (0–15), in the stock's own volatility units when available
    const atrUnits = vwapAtrUnits(s);
    const vwapRatio = atrUnits !== null
      ? clamp01((atrUnits * dir) / p90VwapAtr)
      : clamp01(((vwapDistPct(s) ?? 0) * dir) / p90VwapPct);
    const vwapPts = vwapRatio * 15;

    const strengthScore = dir === 0
      ? Math.round(confluencePts)
      : Math.round((confluencePts + buyDominancePts + cvdPts + depthPts + vwapPts) * 10) / 10;

    return {
      stock: s,
      ...conf,
      strengthScore,
      chgRank: chgSortedSymbols.indexOf(s.symbol) + 1,
    };
  });

  const bySymbol = {};

  // Exact Tredye ranking within BULL and BEAR sides (by |score| desc, then |chg_pct| desc, then strengthScore desc)
  for (const side of ['BULL', 'BEAR']) {
    items
      .filter(it => it.side === side)
      .sort(
        (a, b) =>
          Math.abs(b.score) - Math.abs(a.score) ||
          b.strengthScore - a.strengthScore ||
          Math.abs(b.stock.chg_pct ?? 0) - Math.abs(a.stock.chg_pct ?? 0)
      )
      .forEach((it, idx) => {
        const rank = idx + 1;
        bySymbol[it.stock.symbol] = {
          symbol: it.stock.symbol,
          side,
          bull: it.bull,
          bear: it.bear,
          n: it.n,
          neutral: it.neutral,
          agree: it.agree,
          score: it.score,
          strengthScore: it.strengthScore,
          rupeeFlowCr: it.rupeeFlowCr,
          imb: it.imb,
          checks: it.checks,
          rank,
          chgRank: it.chgRank,
          tag: `${side === 'BULL' ? 'BULLISH' : 'BEARISH'} #${rank}`,
        };
      });
  }

  for (const it of items) {
    if (!bySymbol[it.stock.symbol]) {
      bySymbol[it.stock.symbol] = {
        symbol: it.stock.symbol,
        side: 'FLAT',
        bull: it.bull,
        bear: it.bear,
        n: it.n,
        neutral: it.neutral,
        agree: it.agree,
        score: 0,
        strengthScore: it.strengthScore,
        rupeeFlowCr: it.rupeeFlowCr,
        imb: it.imb,
        checks: it.checks,
        rank: null,
        chgRank: it.chgRank,
        tag: 'MIXED FLOW',
      };
    }
  }

  // Filter eligible universe for Top-N candidate lists
  const isEligible = s => {
    if (minPrice > 0 && (s.ltp || 0) < minPrice) return false;
    if (ignoreSymbols && ignoreSymbols.has(s.symbol.toUpperCase())) return false;
    if (watchlist && !watchlist.has(s.symbol.toUpperCase())) return false;
    if (sectorFilter && !sectorFilter.has((s.sector || 'Other').toLowerCase())) return false;
    return true;
  };

  const eligibleStocks = stocks.filter(isEligible);

  const topBull = eligibleStocks
    .filter(s => bySymbol[s.symbol]?.side === 'BULL')
    .sort((a, b) => {
      const fa = bySymbol[a.symbol];
      const fb = bySymbol[b.symbol];
      return fb.agree - fa.agree || fb.strengthScore - fa.strengthScore || (b.chg_pct ?? 0) - (a.chg_pct ?? 0);
    })
    .slice(0, topN)
    .map(s => ({ stock: s, flow: bySymbol[s.symbol] }));

  const topBear = eligibleStocks
    .filter(s => bySymbol[s.symbol]?.side === 'BEAR')
    .sort((a, b) => {
      const fa = bySymbol[a.symbol];
      const fb = bySymbol[b.symbol];
      return fb.agree - fa.agree || fb.strengthScore - fa.strengthScore || (a.chg_pct ?? 0) - (b.chg_pct ?? 0);
    })
    .slice(0, topN)
    .map(s => ({ stock: s, flow: bySymbol[s.symbol] }));

  // Sector aggregation (exact port of sT in orderflow bundle)
  const sectorMap = new Map();
  for (const s of stocks) {
    const sec = s.sector || 'Other';
    const cur = sectorMap.get(sec) || { sector: sec, flowCr: 0, tv: 0, pw: 0, count: 0, bullCount: 0, bearCount: 0 };
    const f = bySymbol[s.symbol];
    cur.flowCr += estimateRupeeFlowCr(s);
    cur.tv += s.tv || 0;
    cur.pw += (s.chg_pct ?? 0) * (s.tv || 1);
    cur.count += 1;
    if (f?.side === 'BULL') cur.bullCount += 1;
    if (f?.side === 'BEAR') cur.bearCount += 1;
    sectorMap.set(sec, cur);
  }
  const sectors = [...sectorMap.values()]
    .map(sec => ({
      sector: sec.sector,
      flowCr: Math.round(sec.flowCr * 100) / 100,
      avgChgPct: sec.tv ? Math.round((sec.pw / sec.tv) * 100) / 100 : 0,
      count: sec.count,
      bullCount: sec.bullCount,
      bearCount: sec.bearCount,
    }))
    .sort((a, b) => b.flowCr - a.flowCr);

  const rankedStocks = stocks
    .map(s => ({ stock: s, flow: bySymbol[s.symbol] }))
    .sort((a, b) => (b.flow.score - a.flow.score) || (b.flow.strengthScore - a.flow.strengthScore) || ((b.stock.chg_pct ?? 0) - (a.stock.chg_pct ?? 0)));

  return {
    bySymbol,
    rankedStocks,
    topBull,
    topBear,
    sectors,
  };
}

module.exports = {
  NEUTRAL_BANDS,
  SCALE_FLOORS,
  normalizeImbPct,
  trailingRangePct,
  estimateRupeeFlowCr,
  getDepthImbalance,
  evaluateConfluence,
  scoreAndRankUniverse,
};

