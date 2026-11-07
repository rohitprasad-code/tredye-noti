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
  return null;
}

function evaluateConfluence(stock) {
  const checks = [
    { key: 'vwap', label: 'LTP > VWAP', bull: stock.ltp > stock.vwap },
    { key: 'poc', label: 'LTP > POC', bull: stock.ltp > stock.poc },
    { key: 'buy_pct', label: 'Buy% > 50', bull: stock.buy_pct > 50 },
    { key: 'cvd', label: 'CVD > 0', bull: stock.cvd > 0 },
  ];

  const imb = getDepthImbalance(stock);
  if (imb !== null) {
    checks.push({ key: 'imb', label: 'Book Imb > 0', bull: imb > 0 });
  } else if (stock.flowScore !== undefined || stock.chg_pct !== undefined) {
    const netFlow = stock.flowScore !== undefined ? stock.flowScore : stock.chg_pct;
    checks.push({ key: 'flow', label: 'Net Flow > 0', bull: Number(netFlow) > 0 });
  }

  const bull = checks.filter(c => c.bull).length;
  const n = checks.length;
  const bear = n - bull;
  const score = bull - bear;
  const side = score > 0 ? 'BULL' : score < 0 ? 'BEAR' : 'FLAT';
  const agree = side === 'BULL' ? bull : side === 'BEAR' ? bear : Math.max(bull, bear);

  return {
    bull,
    bear,
    n,
    agree,
    score,
    side,
    imb,
    checks,
    rupeeFlowCr: estimateRupeeFlowCr(stock),
  };
}

/**
 * Ranks all stocks in an `/api/orderflow` response:
 * 1. Computes exact Tredye tags (`BULLISH #1`, `BEARISH #1`, `MIXED FLOW`) and `chgRank`
 * 2. Computes a 0–100 composite `strengthScore` in the direction of `side`:
 *    - Confluence ratio (agree / n): 40 pts
 *    - Buy/sell dominance (|buy_pct - 50| / 25 capped at 1): 20 pts
 *    - Normalized rupee CVD across the universe in flow direction: 15 pts
 *    - Order-book depth imbalance in flow direction: 10 pts
 *    - VWAP extension in flow direction (|ltp - vwap| / vwap up to 1.5%): 15 pts
 */
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

  // Compute P90 rupee flow across the universe for normalization
  const absFlows = stocks
    .map(s => Math.abs(estimateRupeeFlowCr(s)))
    .filter(v => v > 0)
    .sort((a, b) => a - b);
  const p90FlowCr = absFlows.length
    ? absFlows[Math.min(absFlows.length - 1, Math.floor(absFlows.length * 0.9))] || 1
    : 1;

  // Sort by % change descending for Tredye's chgRank
  const chgSortedSymbols = [...stocks]
    .sort((a, b) => (b.chg_pct ?? 0) - (a.chg_pct ?? 0))
    .map(s => s.symbol);

  const items = stocks.map(s => {
    const conf = evaluateConfluence(s);
    const dir = conf.side === 'BULL' ? 1 : conf.side === 'BEAR' ? -1 : 0;

    // 1. Confluence component (0–40)
    const confluencePts = conf.n > 0 ? (conf.agree / conf.n) * 40 : 0;

    // 2. Buy/Sell dominance component (0–20)
    const signedBuyEdge = ((s.buy_pct ?? 50) - 50) * dir;
    const buyDominancePts = Math.max(0, Math.min(1, signedBuyEdge / 22)) * 20;

    // 3. Rupee CVD component (0–15)
    const signedFlowCr = conf.rupeeFlowCr * dir;
    const cvdPts = Math.max(0, Math.min(1, signedFlowCr / p90FlowCr)) * 15;

    // 4. Depth imbalance component (0–10)
    let imbRatio = 0;
    if (conf.imb !== null) {
      // imb can be -1..1 or -100..100 depending on endpoint scale
      const normImb = Math.abs(conf.imb) <= 1 ? conf.imb * 100 : conf.imb;
      imbRatio = Math.max(0, Math.min(1, (normImb * dir) / 35));
    } else {
      imbRatio = 0.5; // neutral when market closed / depth unavailable
    }
    const depthPts = imbRatio * 10;

    // 5. VWAP impulse component (0–15)
    const vwapPct = s.vwap ? (((s.ltp - s.vwap) / s.vwap) * 100) * dir : 0;
    const vwapPts = Math.max(0, Math.min(1, vwapPct / 1.25)) * 15;

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
    .sort((a, b) => (b.flow.score - a.flow.score) || ((b.stock.chg_pct ?? 0) - (a.stock.chg_pct ?? 0)));

  return {
    bySymbol,
    rankedStocks,
    topBull,
    topBear,
    sectors,
  };
}

module.exports = {
  estimateRupeeFlowCr,
  getDepthImbalance,
  evaluateConfluence,
  scoreAndRankUniverse,
};

