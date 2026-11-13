'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getMarketStatus } = require('./market/hours');
const { TredyeClient } = require('./tredye/client');
const { UpstoxClient } = require('./upstox/client');
const { scoreAndRankUniverse } = require('./engine/flow');
const { locateActionableOB } = require('./engine/orderblocks');
const { SignalEngine } = require('./engine/signals');
const { FlowStore } = require('./store/db');
const { createDashboardServer } = require('./server/server');
const { createSampleDataset } = require('../data/sample-fixture');

function loadDotEnv(envPath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function saveDotEnvKeyValues(updates, envPath = path.join(process.cwd(), '.env')) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else if (fs.existsSync(path.join(process.cwd(), '.env.example'))) {
    content = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
  }

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined) continue;
    process.env[key] = String(val);
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  fs.writeFileSync(envPath, content.trim() + '\n', { mode: 0o600 });
}

function loadDefaultConfig() {
  const cfgPath = path.join(process.cwd(), 'config.json');
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {
      pollIntervalSec: 60,
      topN: 5,
      minAgree: 4,
      confirmPolls: 2,
      obProximityPct: 0.5,
      cooldownMinutes: 20,
      minPrice: 0,
      sectors: [],
      watchlist: [],
      ignoreSymbols: [],
      soundOnInZone: true,
      soundOnApproach: true,
      openSummaryAlert: true,
    };
  }
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function istBarDate(bar) {
  if (!bar) return '';
  if (typeof bar.iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(bar.iso)) {
    return bar.iso.slice(0, 10);
  }
  const ts = Number(bar.ts);
  if (Number.isFinite(ts) && ts > 0) {
    return new Date(ts + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  }
  return '';
}

function buildOrderBlockRealData(rawBars, { isBull, ltp, prevClose, quoteDate } = {}) {
  if (!Array.isArray(rawBars) || rawBars.length < 2) return null;
  const lastRaw = rawBars[rawBars.length - 1];
  const lastBarDate = istBarDate(lastRaw);
  if (quoteDate && lastBarDate && lastBarDate < quoteDate) {
    return null;
  }

  const bars = rawBars.slice(-75).map(b => ({
    o: Number(b.o),
    h: Number(b.h),
    l: Number(b.l),
    c: Number(b.c),
    v: Number(b.v || 0),
  }));
  const n = bars.length;
  const lastClose = bars[n - 1].c;
  const live = Number(ltp || lastClose);
  const prev = Number(prevClose || 0);
  if (
    prev > 0 &&
    n >= 60 &&
    Math.abs(lastClose - prev) <= Math.max(0.05, prev * 0.0025) &&
    Math.abs(live - lastClose) > Math.max(0.5, lastClose * 0.008)
  ) {
    return null;
  }

  bars[n - 1].c = live;
  bars[n - 1].h = Math.max(bars[n - 1].h, live);
  bars[n - 1].l = Math.min(bars[n - 1].l, live);

  const o = [];
  const h = [];
  const l = [];
  const c = [];
  const v = [];
  const w = [];
  const trs = [];
  let dayH = -Infinity;
  let dayL = Infinity;
  let cumPV = 0;
  let cumV = 0;

  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    o.push(round2(bar.o));
    h.push(round2(bar.h));
    l.push(round2(bar.l));
    c.push(round2(bar.c));
    v.push(Math.round(bar.v));
    dayH = Math.max(dayH, bar.h);
    dayL = Math.min(dayL, bar.l);
    const vol = bar.v > 0 ? bar.v : 1;
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumPV += tp * vol;
    cumV += vol;
    w.push(round2(cumPV / cumV));
    const tr =
      i === 0
        ? bar.h - bar.l
        : Math.max(bar.h - bar.l, Math.abs(bar.h - bars[i - 1].c), Math.abs(bar.l - bars[i - 1].c));
    trs.push(tr);
  }

  const atrSlice = trs.slice(-14);
  const rawAtr = atrSlice.reduce((s, x) => s + x, 0) / Math.max(1, atrSlice.length);
  const rangeFallback = Math.max((dayH - dayL) / 10, live * 0.003);
  const atr = Math.max(0.05, round2(rawAtr > 0 ? rawAtr : rangeFallback));

  // Find strongest directional displacement candle and its base Order Block candle
  let bestScore = -Infinity;
  let kB = Math.max(0, Math.min(n - 3, Math.floor(n * 0.55)));
  const maxIdx = Math.max(1, n - 2);
  for (let i = 1; i <= maxIdx; i++) {
    const disp = isBull ? bars[i].c - bars[i].o : bars[i].o - bars[i].c;
    const nextDisp = i + 1 < n ? (isBull ? bars[i + 1].c - bars[i + 1].o : bars[i + 1].o - bars[i + 1].c) : 0;
    const base = bars[i - 1];
    const oppositeBonus = (isBull ? base.c <= base.o : base.c >= base.o) ? atr * 0.35 : 0;
    const recencyBonus = (i / n) * atr * 0.25;
    const score = disp + Math.max(0, nextDisp) * 0.5 + oppositeBonus + recencyBonus;
    if (score > bestScore) {
      bestScore = score;
      kB = i - 1;
    }
  }
  kB = Math.max(0, Math.min(n - 2, kB));

  let obLo = bars[kB].l;
  let obHi = bars[kB].h;
  if (obHi - obLo < atr * 0.15) {
    const mid = (obLo + obHi) / 2;
    obLo = mid - atr * 0.15;
    obHi = mid + atr * 0.15;
  }

  // Morning breakout / origin block if earlier displacement exists
  let kub = -1;
  let kO = -1;
  const earlyEnd = Math.min(kB - 2, Math.floor(n * 0.45));
  if (earlyEnd >= 2) {
    let earlyBest = 0;
    for (let i = 1; i <= earlyEnd; i++) {
      const d = isBull ? bars[i].c - bars[i].o : bars[i].o - bars[i].c;
      if (d > earlyBest) {
        earlyBest = d;
        kub = i;
      }
    }
    if (kub >= 1) {
      for (let j = kub - 1; j >= Math.max(0, kub - 6); j--) {
        if (isBull ? bars[j].c < bars[j].o : bars[j].c > bars[j].o) {
          kO = j;
          break;
        }
      }
    }
  }

  // Pullback / retest candle after kB nearest the zone
  let kd = n - 1;
  let nearestDist = Infinity;
  for (let i = kB + 2; i < n; i++) {
    const dist = isBull ? Math.abs(bars[i].l - obHi) : Math.abs(bars[i].h - obLo);
    if (dist <= nearestDist) {
      nearestDist = dist;
      kd = i;
    }
  }

  // Fair-value gap right after kB if present
  let f = [0, 0, -1, kd];
  if (kB + 2 < n) {
    if (isBull && bars[kB + 2].l > bars[kB].h) {
      f = [round2(bars[kB].h), round2(bars[kB + 2].l), kB + 1, kd];
    } else if (!isBull && bars[kB + 2].h < bars[kB].l) {
      f = [round2(bars[kB + 2].h), round2(bars[kB].l), kB + 1, kd];
    }
  }

  const vwapEnd = w[n - 1] || round2(live);
  const zW = obHi - obLo;
  const eLo = round2(obLo);
  const eHi = round2(obHi);
  const E = round2((obLo + obHi) / 2);
  const spanCap = Math.max(atr * 3.2, (dayH - dayL) * 0.55, zW * 2.5);

  let SL;
  let T1;
  let T2;
  let oppLo;
  let oppHi;
  if (isBull) {
    SL = round2(obLo - Math.max(atr * 0.4, zW * 0.22));
    const R = Math.max(E - SL, atr * 0.5);
    const rawT1 = Math.max(live + atr * 0.35, E + R * 1.45);
    const rawT2 = Math.max(dayH + atr * 0.35, E + R * 2.35);
    T1 = round2(Math.min(rawT1, dayH + spanCap * 0.55));
    T2 = round2(Math.min(Math.max(rawT2, T1 + atr * 0.3), Math.max(dayH, live) + spanCap * 0.8));
    oppLo = round2(T2 - atr * 0.35);
    oppHi = round2(T2 + atr * 0.25);
  } else {
    SL = round2(obHi + Math.max(atr * 0.4, zW * 0.22));
    const R = Math.max(SL - E, atr * 0.5);
    const rawT1 = Math.min(live - atr * 0.35, E - R * 1.45);
    const rawT2 = Math.min(dayL - atr * 0.35, E - R * 2.35);
    T1 = round2(Math.max(rawT1, dayL - spanCap * 0.55));
    T2 = round2(Math.max(Math.min(rawT2, T1 - atr * 0.3), Math.min(dayL, live) - spanCap * 0.8));
    oppLo = round2(T2 - atr * 0.25);
    oppHi = round2(T2 + atr * 0.35);
  }

  return {
    z: [eLo, eHi],
    e: [eLo, eHi, E],
    sl: SL,
    t: [T1, T2],
    op: [oppLo, oppHi],
    a: atr,
    hl: [round2(Math.max(dayH, prevClose || dayH)), round2(Math.min(dayL, prevClose || dayL))],
    vw: vwapEnd,
    k: {
      iv: 5,
      o,
      h,
      l,
      c,
      v,
      w,
      b: kB,
      g: kO,
      u: kub,
      f,
    },
  };
}

/**
 * Computes a 0–100 Setup Score combining flow strength (60%),
 * directional % momentum (20%), and aligned Order Block proximity/status (20%).
 */
function computeSetupScore(c, isBull) {
  const flowPts = Math.max(0, Math.min(100, Number(c.strengthScore || 0))) * 0.6;
  const absChg = Math.abs(Number(c.chgPct || 0));
  const momPts = Math.min(1, absChg / 5) * 20;

  const alignedOB = isBull
    ? (c.bestBullOB || (c.primaryOB?.bull ? c.primaryOB : null))
    : (c.bestBearOB || (c.primaryOB && !c.primaryOB.bull ? c.primaryOB : null));

  let obPts = 0;
  if (alignedOB && !alignedOB.invalidated && !alignedOB.mit) {
    const dist = alignedOB.distPct;
    if (alignedOB.status === 'IN_ZONE' || dist === 0) obPts = 20;
    else if (alignedOB.status === 'RETESTED_HELD' && dist !== null && dist <= 0.5) obPts = 17;
    else if (dist !== null && dist <= 0.5) obPts = 15;
    else if (dist !== null && dist <= 1.5) obPts = 10;
    else obPts = 5;
  }

  return Math.round((flowPts + momPts + obPts) * 10) / 10;
}

function compareOrderBlockCandidates(a, b, isBull, sort = 'MAX_GAINS') {
  const dir = isBull ? 1 : -1;
  const absChgA = Math.abs(Number(a.chgPct || 0));
  const absChgB = Math.abs(Number(b.chgPct || 0));
  const flowA = Number(a.rupeeFlowCr || 0) * dir;
  const flowB = Number(b.rupeeFlowCr || 0) * dir;

  if (sort === 'SETUP_SCORE') {
    return (
      computeSetupScore(b, isBull) - computeSetupScore(a, isBull) ||
      Number(b.agree || 0) - Number(a.agree || 0) ||
      Number(b.strengthScore || 0) - Number(a.strengthScore || 0) ||
      flowB - flowA ||
      absChgB - absChgA
    );
  }

  if (sort === 'FLOW_SCORE') {
    return (
      Number(b.agree || 0) - Number(a.agree || 0) ||
      Number(b.strengthScore || 0) - Number(a.strengthScore || 0) ||
      flowB - flowA ||
      absChgB - absChgA
    );
  }

  // MAX_GAINS — rank strictly by % move first, then strengthScore and directional flow
  return (
    absChgB - absChgA ||
    Number(b.strengthScore || 0) - Number(a.strengthScore || 0) ||
    flowB - flowA
  );
}

class TredyeFlowService {
  constructor(options = {}) {
    loadDotEnv();
    this.port = Number(options.port || process.env.PORT || 4600);
    this.dashboardUrl = `http://localhost:${this.port}`;
    this.demoMode = Boolean(options.demo);
    this.dryRun = Boolean(options.dryRun);

    this.store = new FlowStore(options.dbPath);
    const baseCfg = loadDefaultConfig();
    const savedCfg = this.store.getSavedSettings();
    this.config = { ...baseCfg, ...(savedCfg || {}) };

    this.client = new TredyeClient();
    this.upstox = new UpstoxClient();
    this.signals = new SignalEngine({ db: this.store });

    // Runtime state for dashboard & inspector
    this.state = {
      sourceMode: this.client.hasCredentials() && !this.demoMode ? 'LIVE' : 'DEMO_REPLAY',
      authStatus: this.client.hasCredentials() ? 'CONFIGURED' : 'DEMO_NO_CREDENTIALS',
      lastError: null,
      lastPollAt: null,
      nextPollAt: null,
      pollCount: 0,
      orderflowMeta: { open: false, asof: null, sources: [] },
      stocksBySymbol: new Map(),
      detailBySymbol: new Map(),
      flowBySymbol: {},
      obBySymbol: new Map(),
      topBull: [],
      topBear: [],
      allRanked: [],
      sectors: [],
    };

    this.broadcast = () => {};
    this.pollTimer = null;
    this.isPolling = false;
    this.upstoxTickTimer = null;
    this.pendingUpstoxTicks = {};
  }

  enrichCardItem(stock, flow) {
    const obInfo = this.state.obBySymbol.get(stock.symbol) || locateActionableOB(
      stock,
      this.state.detailBySymbol.get(stock.symbol),
      flow
    );
    this.state.obBySymbol.set(stock.symbol, obInfo);

    const detail = this.state.detailBySymbol.get(stock.symbol);
    const inferredBuildup =
      stock.buildup ||
      ((stock.chg_pct ?? 0) >= 0 && (stock.cvd ?? 0) >= 0
        ? 'LONG BUILD-UP'
        : (stock.chg_pct ?? 0) >= 0
        ? 'SHORT COVERING'
        : (stock.cvd ?? 0) < 0
        ? 'SHORT BUILD-UP'
        : 'LONG UNWINDING');

    return {
      symbol: stock.symbol,
      name: stock.name,
      sector: stock.sector || 'Other',
      sh: stock.sh,
      ltp: stock.ltp,
      prev: stock.prev,
      chgPct: stock.chg_pct,
      vwap: stock.vwap,
      poc: stock.poc,
      val: stock.val,
      vah: stock.vah,
      buyPct: stock.buy_pct,
      cvd: stock.cvd,
      tv: stock.tv ?? null,
      buildup: String(inferredBuildup).toUpperCase(),
      doi: stock.doi ?? null,
      imb: flow.imb,
      rupeeFlowCr: Number(flow.rupeeFlowCr.toFixed(2)),
      side: flow.side,
      agree: flow.agree,
      totalChecks: flow.n,
      score: flow.score,
      strengthScore: flow.strengthScore,
      rank: flow.rank,
      chgRank: flow.chgRank,
      tag: flow.tag,
      checks: flow.checks,
      primaryOB: obInfo.primaryOB,
      bestBullOB: obInfo.bestBullOB || null,
      bestBearOB: obInfo.bestBearOB || null,
      keyLevels: obInfo.keyLevels || {},
      levels: detail?.levels || stock.levels || [],
      profile: detail?.profile || null,
      referencePlan: obInfo.referencePlan,
      allOBs: obInfo.allOBs,
      summaryOB: stock.ob || null,
    };
  }

  getPublicState() {
    const market = getMarketStatus();
    return {
      sourceMode: this.state.sourceMode,
      authStatus: this.state.authStatus,
      hasCredentials: this.client.hasCredentials(),
      upstox: this.upstox.getStatus(),
      lastError: this.state.lastError,
      lastPollAt: this.state.lastPollAt,
      nextPollAt: this.state.nextPollAt,
      pollCount: this.state.pollCount,
      market,
      orderflowMeta: this.state.orderflowMeta,
      topBull: this.state.topBull,
      topBear: this.state.topBear,
      universe: this.state.allRanked,
      sectors: this.state.sectors,
      alerts: this.store.listAlerts(50, true),
      config: this.config,
    };
  }

  async getOrderBlockFunnelSnapshot({ sector = 'ALL', side = 'ALL', sort = 'MAX_GAINS' } = {}) {
    const all = this.state.allRanked || [];
    const secStatsMap = new Map();
    for (const c of all) {
      const sec = String(c.sector || 'OTHER').toUpperCase();
      if (!secStatsMap.has(sec)) {
        secStatsMap.set(sec, { sec, sumChg: 0, adv: 0, n: 0 });
      }
      const st = secStatsMap.get(sec);
      const chg = Number(c.chgPct || 0);
      st.sumChg += chg;
      if (chg > 0 || (chg === 0 && c.side !== 'BEAR')) st.adv += 1;
      st.n += 1;
    }

    const allSectors = [...secStatsMap.values()]
      .map(s => ({
        sec: s.sec,
        chg: Number((s.sumChg / Math.max(1, s.n)).toFixed(2)),
        adv: s.adv,
        n: s.n,
      }))
      .sort((a, b) => b.chg - a.chg);

    const normSector = String(sector || 'ALL').trim().toUpperCase();
    const sectorFiltered =
      normSector && normSector !== 'ALL'
        ? all.filter(c => String(c.sector || 'OTHER').toUpperCase() === normSector)
        : all;

    const rawBulls = [];
    const rawBears = [];
    for (const c of sectorFiltered) {
      const chg = Number(c.chgPct || 0);
      const isBull = chg > 0 || (chg === 0 && c.side !== 'BEAR');
      if (isBull) rawBulls.push(c);
      else rawBears.push(c);
    }

    const counts = {
      all: sectorFiltered.length,
      bull: rawBulls.length,
      bear: rawBears.length,
      universeTotal: all.length,
    };

    rawBulls.sort((a, b) => compareOrderBlockCandidates(a, b, true, sort));
    rawBears.sort((a, b) => compareOrderBlockCandidates(a, b, false, sort));

    const maxContendersPerSide = normSector !== 'ALL' ? Math.min(20, Math.max(3, rawBulls.length)) : 20;
    const maxBearContenders = normSector !== 'ALL' ? Math.min(20, Math.max(3, rawBears.length)) : 20;

    // Fetch genuine 1-day 5m Upstox candles for the displayed top contenders (tiles + hero tickets + popup)
    const chartSymbols = [
      ...rawBulls.slice(0, maxContendersPerSide).map(c => c.symbol),
      ...rawBears.slice(0, maxBearContenders).map(c => c.symbol),
    ];
    let candleMap = new Map();
    if (this.upstox?.isConnected() && chartSymbols.length > 0) {
      candleMap = await this.upstox.fetchOneDayCandlesBatch(chartSymbols, 5, {
        concurrency: 10,
        ttlMs: 45000,
      });
    }

    let maxBars = 0;
    for (const bars of candleMap.values()) {
      if (Array.isArray(bars) && bars.length > maxBars) {
        maxBars = Math.min(75, bars.length);
      }
    }

    const formatStock = (c, idx, total, isBull) => {
      const ltp = Number(c.ltp || 100);
      let chg = Number(c.chgPct || 0);
      if (isBull && chg <= 0) chg = 0.08;
      if (!isBull && chg >= 0) chg = -0.08;
      // Ensure non-event unless truly >10% crash
      if (!isBull && chg < -9.8 && idx > 0) chg = -9.5;

      const prev = Number(c.prev || (ltp / (1 + chg / 100)));
      const cp = Number((ltp - prev).toFixed(2));
      const frac = total > 1 ? idx / (total - 1) : 0;
      const p = isBull
        ? Number((0.999 - frac * 0.495).toFixed(4))
        : Number((0.001 + frac * 0.495).toFixed(4));

      const w = Number(Math.max(0.55, Math.min(4.2, 0.7 + Math.abs(Number(c.rupeeFlowCr || 1)) / 22)).toFixed(3));
      const maxTop = isBull ? Math.min(20, maxContendersPerSide) : Math.min(20, maxBearContenders);
      const isTop = idx < maxTop;

      const inst = this.upstox?.instrumentBySymbol?.get(c.symbol);
      const item = {
        s: c.symbol,
        n: c.name || c.symbol,
        et: inst?.exchangeToken || null,
        isin: inst?.isin || null,
        sec: String(c.sector || 'OTHER').toUpperCase(),
        g: isBull ? 'bull' : 'bear',
        c: Number(chg.toFixed(2)),
        cp,
        p,
        o: Number(prev.toFixed(2)),
        l: Number(ltp.toFixed(2)),
        top: isTop,
        fo: true,
        w,
        bu: c.buildup || (isBull ? 'LONG BUILD-UP' : 'SHORT BUILD-UP'),
        flowAgree: Number(c.agree || 0),
        flowCr: Number(c.rupeeFlowCr || 0),
        strengthScore: Number(c.strengthScore || 0),
        setupScore: computeSetupScore(c, isBull),
        obStr: Number((isBull ? (c.bestBullOB?.str || c.primaryOB?.str) : (c.bestBearOB?.str || c.primaryOB?.str)) || 1.5),
      };

      if (isTop && candleMap.has(c.symbol)) {
        const quoteDate = this.state.stocksBySymbol.get(c.symbol)?.quoteDate || '';
        const realX = buildOrderBlockRealData(candleMap.get(c.symbol), {
          isBull,
          ltp,
          prevClose: prev,
          quoteDate,
        });
        if (realX) {
          item.x = realX;
        }
      }

      return item;
    };

    const bullItems = rawBulls.map((c, i) => formatStock(c, i, rawBulls.length, true));
    const bearItems = rawBears.map((c, i) => formatStock(c, i, rawBears.length, false));
    const stocksOut = [...bullItems, ...bearItems];

    const activeSecNames = new Set(stocksOut.map(s => s.sec));
    const activeSectors = allSectors.filter(s => activeSecNames.has(s.sec));

    const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
    const hh = String(nowIst.getUTCHours()).padStart(2, '0');
    const mm = String(nowIst.getUTCMinutes()).padStart(2, '0');
    const ss = String(nowIst.getUTCSeconds()).padStart(2, '0');
    const elMinutes = maxBars > 0 ? Math.min(375, Math.max(5, maxBars * 5)) : 375;

    return {
      meta: {
        generated_at_ist: new Date().toISOString(),
        universe: {
          total_stocks: stocksOut.length,
          priced: stocksOut.length,
          bullish: bullItems.length,
          bearish: bearItems.length,
          mosaic_cells: stocksOut.filter(s => s.top).length,
          real_charts: candleMap.size,
        },
        status: 'live',
        clock: `${hh}:${mm}:${ss}`,
        el: elMinutes,
        open: '09:15',
        close: '15:30',
        filter: { sector: normSector, side: String(side || 'ALL').toUpperCase(), sort },
        counts,
        allSectors,
      },
      sectors: activeSectors.length ? activeSectors : allSectors,
      stocks: stocksOut,
    };
  }

  async getStockDetail(symbol) {
    const sym = symbol.toUpperCase();
    const stock = this.state.stocksBySymbol.get(sym);
    if (!stock) return null;

    let detail = this.state.detailBySymbol.get(sym);
    if (!detail && this.state.sourceMode === 'LIVE' && stock.sh !== undefined) {
      try {
        const shardData = await this.client.fetchOrderFlowShard(stock.sh);
        if (shardData?.stocks) {
          for (const ds of shardData.stocks) {
            this.state.detailBySymbol.set(ds.symbol, {
              ...ds,
              candle_min: shardData.candle_min || 3,
            });
          }
          detail = this.state.detailBySymbol.get(sym);
        }
      } catch {
        // fallback to summary stock
      }
    }

    if (this.upstox.isConnected()) {
      try {
        const upCandles = await this.upstox.fetchIntradayCandles(sym, 'minutes', 3);
        if (Array.isArray(upCandles) && upCandles.length > 0) {
          detail = { ...(detail || { symbol: sym }), candles: upCandles, candle_min: 3 };
          this.state.detailBySymbol.set(sym, detail);
        }
      } catch {
        // fallback to existing detail
      }
    }

    const flow = this.state.flowBySymbol[sym];
    const obInfo = locateActionableOB(stock, detail, flow);
    this.state.obBySymbol.set(sym, obInfo);

    return {
      symbol: sym,
      stock,
      detail: detail || null,
      candleMin: detail?.candle_min || 3,
      candles: detail?.candles || [],
      profile: detail?.profile || null,
      levels: detail?.levels || stock.levels || [],
      depth: detail?.depth || stock.depth || null,
      flow,
      obInfo,
    };
  }

  async runPollCycle({ forceDemo = false, manual = false } = {}) {
    if (this.isPolling) return { skipped: true };
    this.isPolling = true;

    try {
      let orderflowData = null;
      let shardResolver = null;
      const useDemo = forceDemo || this.demoMode || !this.client.hasCredentials();

      if (!useDemo) {
        try {
          orderflowData = await this.client.fetchOrderFlow();
          this.state.sourceMode = 'LIVE';
          this.state.authStatus = 'AUTHENTICATED';
          this.state.lastError = null;
          shardResolver = async sh => this.client.fetchOrderFlowShard(sh);
        } catch (err) {
          this.state.lastError = err.message;
          this.state.authStatus = err.status === 401 ? 'AUTH_ERROR' : 'NETWORK_ERROR';
          // If we have no data loaded yet, load sample replay so dashboard isn't blank
          if (this.state.stocksBySymbol.size === 0) {
            const sample = createSampleDataset();
            orderflowData = sample.orderflow;
            shardResolver = async sh => sample.shards[sh];
            this.state.sourceMode = 'DEMO_FALLBACK';
          } else {
            this.broadcast('state', this.getPublicState());
            return { ok: false, error: err.message };
          }
        }
      } else {
        const sample = createSampleDataset();
        orderflowData = sample.orderflow;
        shardResolver = async sh => sample.shards[sh];
        this.state.sourceMode = 'DEMO_REPLAY';
        this.state.authStatus = this.client.hasCredentials() ? 'DEMO_FORCED' : 'DEMO_NO_CREDENTIALS';
      }

      const stocks = orderflowData?.stocks || [];
      this.state.orderflowMeta = {
        open: Boolean(orderflowData?.open),
        asof: orderflowData?.asof || Math.floor(Date.now() / 1000),
        sources: orderflowData?.sources || [],
        totalStocks: stocks.length,
      };

      this.state.stocksBySymbol.clear();
      for (const s of stocks) {
        this.state.stocksBySymbol.set(s.symbol, s);
      }

      // Overlay real-time Upstox market quotes when connected
      if (this.upstox.isConnected() && stocks.length > 0) {
        try {
          const quotes = await this.upstox.fetchQuotes(stocks.map(s => s.symbol));
          this.mergeUpstoxTicks(quotes);
          if (Object.keys(quotes).length > 0) {
            this.state.sourceMode = 'UPSTOX_LIVE';
          }
          if (!this.dryRun && !this.upstox.wsConnected) {
            this.ensureUpstoxWebSocket(stocks.map(s => s.symbol)).catch(() => {});
          }
        } catch (err) {
          if (err.status === 401) {
            this.upstox.lastError = err.message;
          }
        }
      }

      // Score and rank universe
      const ranked = scoreAndRankUniverse(stocks, this.config);
      this.state.flowBySymbol = ranked.bySymbol;
      this.state.sectors = ranked.sectors;

      // Load all shards across the universe so every single stock (all 218) has real-time 3m Order Blocks & Volume Profile
      const neededShards = new Set();
      for (const s of stocks) {
        if (s.sh !== undefined && s.sh !== null) {
          neededShards.add(s.sh);
        }
      }

      await Promise.all(
        [...neededShards].map(async sh => {
          try {
            const shardPayload = await shardResolver(sh);
            if (shardPayload && Array.isArray(shardPayload.stocks)) {
              for (const ds of shardPayload.stocks) {
                this.state.detailBySymbol.set(ds.symbol, {
                  ...ds,
                  candle_min: shardPayload.candle_min || 3,
                });
              }
            }
          } catch {
            // continue if single shard fails
          }
        })
      );

      // Locate Order Blocks for top candidates and all stocks with detail
      this.state.obBySymbol.clear();
      const topCandidates = [];

      const topBullCards = ranked.topBull.map(({ stock, flow }) => {
        const card = this.enrichCardItem(stock, flow);
        topCandidates.push({ stock, flow, obInfo: this.state.obBySymbol.get(stock.symbol) });
        return card;
      });

      const topBearCards = ranked.topBear.map(({ stock, flow }) => {
        const card = this.enrichCardItem(stock, flow);
        topCandidates.push({ stock, flow, obInfo: this.state.obBySymbol.get(stock.symbol) });
        return card;
      });

      this.state.topBull = topBullCards;
      this.state.topBear = topBearCards;
      this.state.allRanked = ranked.rankedStocks.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
      const intervalMs = Math.max(15, Number(this.config.pollIntervalSec || 60)) * 1000;
      this.state.lastPollAt = Date.now();
      this.state.nextPollAt = Date.now() + intervalMs;
      this.state.pollCount += 1;

      // In demo replay on first boot, run a warm-up pass so 2-poll persistence triggers cleanly
      let warmupAlerts = [];
      if (this.state.sourceMode !== 'LIVE' && this.state.pollCount === 1 && this.store.listAlerts(5).length === 0) {
        warmupAlerts = this.signals.evaluatePoll(
          {
            candidates: topCandidates,
            bySymbol: this.state.flowBySymbol,
            stocksBySymbol: this.state.stocksBySymbol,
            obBySymbol: this.state.obBySymbol,
          },
          this.config,
          Date.now() - 65000
        );
      }

      // Evaluate signal rules
      const newAlerts = this.signals.evaluatePoll(
        {
          candidates: topCandidates,
          bySymbol: this.state.flowBySymbol,
          stocksBySymbol: this.state.stocksBySymbol,
          obBySymbol: this.state.obBySymbol,
        },
        this.config,
        Date.now()
      );

      const allTriggered = [...warmupAlerts, ...newAlerts];
      const savedAlerts = [];

      for (const alert of allTriggered) {
        const id = this.store.insertAlert(alert);
        const stored = { ...alert, id, reviewed: false };
        savedAlerts.push(stored);

        if (!this.dryRun) {
          this.broadcast('alert', stored);
        }
      }

      this.broadcast('state', this.getPublicState());
      return {
        ok: true,
        sourceMode: this.state.sourceMode,
        alertsTriggered: savedAlerts.length,
        alerts: savedAlerts,
      };
    } finally {
      this.isPolling = false;
    }
  }

  updateConfig(partial) {
    const clean = {};
    if (partial.topN !== undefined) clean.topN = Math.max(1, Math.min(15, Number(partial.topN)));
    if (partial.pollIntervalSec !== undefined) {
      clean.pollIntervalSec = Math.max(15, Math.min(300, Number(partial.pollIntervalSec)));
    }
    if (partial.pollAlways !== undefined) clean.pollAlways = Boolean(partial.pollAlways);
    if (partial.minAgree !== undefined) clean.minAgree = Math.max(1, Math.min(5, Number(partial.minAgree)));
    if (partial.confirmPolls !== undefined) clean.confirmPolls = Math.max(1, Math.min(5, Number(partial.confirmPolls)));
    if (partial.obProximityPct !== undefined) clean.obProximityPct = Math.max(0.05, Math.min(5, Number(partial.obProximityPct)));
    if (partial.cooldownMinutes !== undefined) clean.cooldownMinutes = Math.max(1, Math.min(240, Number(partial.cooldownMinutes)));
    if (partial.minPrice !== undefined) clean.minPrice = Math.max(0, Number(partial.minPrice));
    if (Array.isArray(partial.sectors)) clean.sectors = partial.sectors.map(s => String(s).trim()).filter(Boolean);
    if (Array.isArray(partial.watchlist)) clean.watchlist = partial.watchlist.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    if (Array.isArray(partial.ignoreSymbols)) clean.ignoreSymbols = partial.ignoreSymbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    if (partial.soundOnInZone !== undefined) clean.soundOnInZone = Boolean(partial.soundOnInZone);
    if (partial.soundOnApproach !== undefined) clean.soundOnApproach = Boolean(partial.soundOnApproach);

    this.config = { ...this.config, ...clean };
    this.store.saveSettings(this.config);
    if (this.pollTimer && clean.pollIntervalSec !== undefined) {
      this.startPollLoop();
    }
    this.broadcast('state', this.getPublicState());
    return this.config;
  }

  startPollLoop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const intervalMs = Math.max(15, Number(this.config.pollIntervalSec || 60)) * 1000;
    this.state.nextPollAt = Date.now() + intervalMs;
    this.pollTimer = setInterval(async () => {
      const mkt = getMarketStatus();
      const pollAlways =
        this.config.pollAlways !== false ||
        String(process.env.POLL_ALWAYS || '').toLowerCase() === 'true';
      if (mkt.open || pollAlways) {
        await this.runPollCycle();
      } else {
        this.state.nextPollAt = Date.now() + intervalMs;
      }
    }, intervalMs);
  }

  mergeUpstoxTicks(ticks = {}) {
    let updated = 0;
    for (const [sym, q] of Object.entries(ticks)) {
      const s = this.state.stocksBySymbol.get(sym);
      if (!s || !q || !q.ltp) continue;
      if (q.ltp > 0) s.ltp = q.ltp;
      if (q.prev > 0) s.prev = q.prev;
      if (q.chg_pct !== undefined) s.chg_pct = q.chg_pct;
      else if (s.prev > 0) s.chg_pct = Number((((s.ltp - s.prev) / s.prev) * 100).toFixed(2));
      if (q.vwap > 0) s.vwap = q.vwap;
      if (q.buy_pct !== null && q.buy_pct !== undefined) s.buy_pct = q.buy_pct;
      if (q.imb !== null && q.imb !== undefined) s.imb = q.imb;
      if (q.oi > 0) s.oi = q.oi;
      if (q.depth) {
        s.depth = q.tbq || q.tsq ? { ...q.depth, tbq: q.tbq, tsq: q.tsq } : q.depth;
      } else if (q.tbq > 0 || q.tsq > 0) {
        s.depth = { ...(s.depth || {}), tbq: q.tbq, tsq: q.tsq };
      }
      if (q.volume > 0) s.volume = q.volume;
      if (q.lastTradeDate) s.quoteDate = q.lastTradeDate;
      updated++;
    }
    return updated;
  }

  recomputeFromCurrentStocks() {
    const stocks = [...this.state.stocksBySymbol.values()];
    if (stocks.length === 0) return;
    const ranked = scoreAndRankUniverse(stocks, this.config);
    this.state.flowBySymbol = ranked.bySymbol;
    this.state.sectors = ranked.sectors;
    this.state.topBull = ranked.topBull.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
    this.state.topBear = ranked.topBear.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
    this.state.allRanked = ranked.rankedStocks.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
    this.state.lastPollAt = Date.now();
  }

  async ensureUpstoxWebSocket(symbols) {
    if (!this.upstox.isConnected()) return false;
    const list = symbols && symbols.length ? symbols : [...this.state.stocksBySymbol.keys()];
    return this.upstox.startWebSocket(list, ticks => {
      Object.assign(this.pendingUpstoxTicks, ticks);
      if (this.upstoxTickTimer) return;
      this.upstoxTickTimer = setTimeout(() => {
        this.upstoxTickTimer = null;
        const batch = this.pendingUpstoxTicks;
        this.pendingUpstoxTicks = {};
        if (this.mergeUpstoxTicks(batch) > 0) {
          this.state.sourceMode = 'UPSTOX_LIVE';
          this.recomputeFromCurrentStocks();
          this.broadcast('upstox_tick', {
            ts: Date.now(),
            symbols: Object.keys(batch),
            upstox: this.upstox.getStatus(),
          });
          this.broadcast('state', this.getPublicState());
        }
      }, 900);
    });
  }

  getUpstoxStatus() {
    return this.upstox.getStatus();
  }

  updateUpstoxConfig({ apiKey, apiSecret, redirectUri, accessToken }) {
    const envUpdates = {};
    if (apiKey !== undefined) envUpdates.UPSTOX_API_KEY = String(apiKey).trim();
    if (apiSecret !== undefined && apiSecret !== '') envUpdates.UPSTOX_API_SECRET = String(apiSecret).trim();
    if (redirectUri !== undefined && String(redirectUri).trim()) {
      envUpdates.UPSTOX_REDIRECT_URI = String(redirectUri).trim();
    }
    if (accessToken !== undefined && String(accessToken).trim()) {
      envUpdates.UPSTOX_ACCESS_TOKEN = String(accessToken).trim();
    }
    saveDotEnvKeyValues(envUpdates);
    this.upstox.updateConfig({ apiKey, apiSecret, redirectUri, accessToken });

    if (this.upstox.isConnected() && !this.dryRun) {
      this.ensureUpstoxWebSocket().catch(() => {});
      this.runPollCycle({ manual: true }).catch(() => {});
    }
    this.broadcast('state', this.getPublicState());
    return {
      ok: true,
      status: this.upstox.getStatus(),
      authUrl: this.upstox.isConfigured() ? this.upstox.getAuthUrl() : null,
    };
  }

  async completeUpstoxOAuth(code) {
    const profile = await this.upstox.exchangeCode(code);
    saveDotEnvKeyValues({ UPSTOX_ACCESS_TOKEN: this.upstox.accessToken });
    if (!this.dryRun) {
      await this.runPollCycle({ manual: true });
      this.ensureUpstoxWebSocket().catch(() => {});
    }
    this.broadcast('state', this.getPublicState());
    return { profile, status: this.upstox.getStatus() };
  }

  disconnectUpstox() {
    this.upstox.clearToken();
    saveDotEnvKeyValues({ UPSTOX_ACCESS_TOKEN: '' });
    this.broadcast('state', this.getPublicState());
    return this.upstox.getStatus();
  }

  async start() {
    if (this.dryRun) {
      await this.runPollCycle({ forceDemo: !this.client.hasCredentials() });
      console.log('=== TREDYE FLOW ALERTS — DRY RUN SUMMARY ===');
      console.log(`Source Mode: ${this.state.sourceMode}`);
      console.log(`\nTop ${this.state.topBull.length} BULLISH (BUY OB Setups):`);
      for (const c of this.state.topBull) {
        console.log(
          `  🟢 #${c.rank} ${c.symbol.padEnd(11)} ₹${String(c.ltp).padEnd(8)} | ${c.agree}/${c.totalChecks} BULL (Strength ${c.strengthScore}/100) | Buy ${Math.round(c.buyPct)}% | ${c.referencePlan?.shortAction || 'OB'}: ${c.referencePlan?.zoneText || '—'} (${c.primaryOB?.distPct === 0 ? 'IN ZONE' : `${c.primaryOB?.distPct ?? '—'}% away`})`
        );
      }
      console.log(`\nTop ${this.state.topBear.length} BEARISH (SELL OB Setups):`);
      for (const c of this.state.topBear) {
        console.log(
          `  🔴 #${c.rank} ${c.symbol.padEnd(11)} ₹${String(c.ltp).padEnd(8)} | ${c.agree}/${c.totalChecks} BEAR (Strength ${c.strengthScore}/100) | Sell ${Math.round(100 - c.buyPct)}% | ${c.referencePlan?.shortAction || 'OB'}: ${c.referencePlan?.zoneText || '—'} (${c.primaryOB?.distPct === 0 ? 'IN ZONE' : `${c.primaryOB?.distPct ?? '—'}% away`})`
        );
      }
      const alerts = this.store.listAlerts(20);
      console.log(`\nGenerated Alerts (${alerts.length}):`);
      for (const a of alerts) {
        console.log(`  [${a.type}] ${a.title}\n    -> ${a.message}`);
      }
      this.store.close();
      return;
    }

    const { server, broadcast } = createDashboardServer(this);
    this.broadcast = broadcast;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', resolve);
    });

    console.log(`🚀 Tredye Flow Alerts running at ${this.dashboardUrl}`);

    // Initial poll on startup
    await this.runPollCycle();

    // Continuous background poll loop (default 60s, configurable down to 15s)
    this.startPollLoop();
  }
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const service = new TredyeFlowService({
    demo: args.has('--demo'),
    dryRun: args.has('--dry-run'),
  });
  service.start().catch(err => {
    console.error('Fatal error starting Tredye Flow Alerts:', err);
    process.exit(1);
  });
}

module.exports = { TredyeFlowService, buildOrderBlockRealData, compareOrderBlockCandidates, computeSetupScore };
