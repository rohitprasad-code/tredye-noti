'use strict';

const path = require('node:path');
const { loadDotEnv, saveDotEnvKeyValues } = require('../config/env');
const { loadDefaultConfig } = require('../config/defaults');
const { getMarketStatus } = require('../market/hours');
const { TredyeClient } = require('../tredye/client');
const { UpstoxClient, normalizeBearerToken, decodeJwtClaims } = require('../upstox/client');
const { scoreAndRankUniverse, trailingRangePct } = require('../engine/flow');
const { locateActionableOB } = require('../engine/orderblocks');
const {
  buildOrderBlockRealData,
  getDirectionalFlowMetrics,
  computeSetupScore,
  compareOrderBlockCandidates,
} = require('../engine/orderblock-ranking');
const { SignalEngine } = require('../engine/signals');
const { createOutcomeSeed, advanceOutcome, buildEdgeReport } = require('../engine/outcomes');
const { FlowStore } = require('../store/db');
const { createDashboardServer } = require('../server/server');
const { createSampleDataset } = require('../../data/sample-fixture');
const { printDryRunSummary } = require('./dry-run-printer');

class TredyeFlowService {
  constructor(options = {}) {
    this.envFile = options.envPath || path.join(process.cwd(), '.env');
    this.persistProcessEnv = !options.envPath;
    loadDotEnv(this.envFile);
    this.port = Number(options.port || process.env.PORT || 4600);
    this.dashboardUrl = `http://localhost:${this.port}`;
    this.demoMode = Boolean(options.demo);
    this.dryRun = Boolean(options.dryRun);

    this.store = new FlowStore(options.dbPath);
    const baseCfg = loadDefaultConfig();
    const savedCfg = this.store.getSavedSettings();
    this.config = { ...baseCfg, ...(savedCfg || {}) };

    this.client = new TredyeClient();
    this.upstox = new UpstoxClient(options.upstox);
    this.signals = new SignalEngine({ db: this.store });

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
    const obInfo =
      this.state.obBySymbol.get(stock.symbol) ||
      locateActionableOB(stock, this.state.detailBySymbol.get(stock.symbol), flow);
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
      buyPctSource: stock.buy_pct_src || (stock.buy_pct !== undefined && stock.buy_pct !== null ? 'TREDYE' : null),
      bookBuyPct: stock.book_buy_pct ?? null,
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

      const prev = Number(c.prev || ltp / (1 + chg / 100));
      const cp = Number((ltp - prev).toFixed(2));
      const frac = total > 1 ? idx / (total - 1) : 0;
      const p = isBull
        ? Number((0.999 - frac * 0.495).toFixed(4))
        : Number((0.001 + frac * 0.495).toFixed(4));

      const w = Number(Math.max(0.55, Math.min(4.2, 0.7 + Math.abs(Number(c.rupeeFlowCr || 1)) / 22)).toFixed(3));
      const maxTop = isBull ? Math.min(20, maxContendersPerSide) : Math.min(20, maxBearContenders);
      const isTop = idx < maxTop;

      const dirFlow = getDirectionalFlowMetrics(c, isBull);
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
        flowSide: c.side || (isBull ? 'BULL' : 'BEAR'),
        flowAgree: dirFlow.agreeInDir,
        flowTotal: dirFlow.total,
        flowCr: Number(c.rupeeFlowCr || 0),
        strengthScore: dirFlow.strengthInDir,
        setupScore: computeSetupScore(c, isBull),
        obStr: Number(
          (isBull ? c.bestBullOB?.str || c.primaryOB?.str : c.bestBearOB?.str || c.primaryOB?.str) || 1.5
        ),
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

      // Load intraday shard candles BEFORE scoring so each stock's ATR% is available
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

      const ranked = scoreAndRankUniverse(stocks, this.buildScoreOptions());
      this.state.flowBySymbol = ranked.bySymbol;
      this.state.sectors = ranked.sectors;

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

      const isLiveData = this.state.sourceMode === 'LIVE' || this.state.sourceMode === 'UPSTOX_LIVE';
      for (const alert of allTriggered) {
        alert.sector = alert.sector || this.state.stocksBySymbol.get(alert.symbol)?.sector || null;
        alert.sourceMode = this.state.sourceMode;
        const id = this.store.insertAlert(alert);
        const stored = { ...alert, id, reviewed: false };
        savedAlerts.push(stored);

        // Outcome tracking only for live data — demo replays would pollute the edge stats
        if (isLiveData) {
          const seed = createOutcomeSeed(id, alert, this.state.sourceMode);
          if (seed) this.store.insertOutcome(seed);
        }

        if (!this.dryRun) {
          this.broadcast('alert', stored);
        }
      }

      try {
        this.updateAlertOutcomes();
      } catch (err) {
        this.state.lastOutcomeError = err.message;
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
      // buy_pct must be TRADE-side (aggressor) share, never the resting-book ratio, or it
      // duplicates `imb`. Prefer Upstox tick-classified aggressor %, once reliable; otherwise
      // keep the trade-based buy_pct from Tredye. Book ratio is kept for display only.
      const aggr = this.upstox?.aggressor?.get(sym);
      if (aggr?.reliable) {
        s.buy_pct = aggr.buyPct;
        s.buy_pct_src = 'UPSTOX_AGGRESSOR';
        s.aggr_coverage_pct = aggr.coveragePct;
      } else if (q.aggr_buy_pct !== null && q.aggr_buy_pct !== undefined) {
        s.buy_pct = q.aggr_buy_pct;
        s.buy_pct_src = 'UPSTOX_AGGRESSOR';
      } else if (s.buy_pct !== undefined && s.buy_pct !== null && !s.buy_pct_src) {
        s.buy_pct_src = 'TREDYE';
      }
      if (q.book_buy_pct !== null && q.book_buy_pct !== undefined) s.book_buy_pct = q.book_buy_pct;
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

  /**
   * Advances every still-TRACKING alert outcome with the latest candles + LTP.
   * Runs each poll; finalizes rows once their session has closed.
   */
  updateAlertOutcomes(nowMs = Date.now()) {
    const open = this.store.listTrackingOutcomes();
    if (!open.length) return 0;
    const isLiveData = this.state.sourceMode === 'LIVE' || this.state.sourceMode === 'UPSTOX_LIVE';
    const pollMs = Math.max(15, Number(this.config.pollIntervalSec || 60)) * 1000;
    let changed = 0;
    for (const row of open) {
      const detail = this.state.detailBySymbol.get(row.symbol);
      const stock = this.state.stocksBySymbol.get(row.symbol);
      const next = advanceOutcome(row, {
        candles: isLiveData ? detail?.candles : [],
        candleMin: detail?.candle_min || 3,
        ltp: isLiveData ? stock?.ltp : null,
        nowMs,
        lateToleranceMs: Math.max(150000, pollMs * 2.5),
      });
      if (JSON.stringify(next) !== JSON.stringify(row)) {
        this.store.updateOutcome(next);
        changed++;
      }
    }
    return changed;
  }

  getEdgeReport({ days = 30, includeDemo = false } = {}) {
    const d = Math.max(1, Math.min(365, Number(days) || 30));
    const rows = this.store.listOutcomeRows(Date.now() - d * 86400000, { includeDemo });
    return {
      days: d,
      generatedAt: Date.now(),
      ...buildEdgeReport(rows),
      recent: rows.slice(0, 60),
    };
  }

  /**
   * Scoring options = terminal config + each stock's own volatility unit
   * (avg 3m candle range % over the trailing 14 candles) for VWAP normalization.
   */
  buildScoreOptions() {
    const volPctBySymbol = {};
    for (const [sym, detail] of this.state.detailBySymbol) {
      const v = trailingRangePct(detail?.candles, 14);
      if (v) volPctBySymbol[sym] = v;
    }
    return { ...this.config, volPctBySymbol };
  }

  recomputeFromCurrentStocks() {
    const stocks = [...this.state.stocksBySymbol.values()];
    if (stocks.length === 0) return;
    const ranked = scoreAndRankUniverse(stocks, this.buildScoreOptions());
    this.state.flowBySymbol = ranked.bySymbol;
    this.state.sectors = ranked.sectors;
    this.state.topBull = ranked.topBull.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
    this.state.topBear = ranked.topBear.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
    this.state.allRanked = ranked.rankedStocks.map(({ stock, flow }) => this.enrichCardItem(stock, flow));
    this.state.lastPollAt = Date.now();
  }

  async ensureUpstoxWebSocket(symbols) {
    if (!this.upstox.isConnected()) return false;
    const syms = symbols || [...this.state.stocksBySymbol.keys()];
    if (syms.length === 0) return false;

    return this.upstox.startWebSocket(syms, (ticks, marketStatus) => {
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

  _saveEnv(updates) {
    saveDotEnvKeyValues(updates, this.envFile, { updateProcessEnv: this.persistProcessEnv });
  }

  updateUpstoxConfig({ apiKey, apiSecret, redirectUri, accessToken }) {
    const envUpdates = {};
    if (apiKey !== undefined) envUpdates.UPSTOX_API_KEY = String(apiKey).trim();
    if (apiSecret !== undefined && apiSecret !== '') envUpdates.UPSTOX_API_SECRET = String(apiSecret).trim();
    if (redirectUri !== undefined && String(redirectUri).trim()) {
      envUpdates.UPSTOX_REDIRECT_URI = String(redirectUri).trim();
    }
    const cleanToken = accessToken !== undefined ? normalizeBearerToken(accessToken) : '';
    if (cleanToken) {
      envUpdates.UPSTOX_ACCESS_TOKEN = cleanToken;
    }
    this._saveEnv(envUpdates);
    this.upstox.updateConfig({ apiKey, apiSecret, redirectUri, accessToken: cleanToken || undefined });

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

  async saveUpstoxAccessToken(rawToken, { verify = true } = {}) {
    const cleanToken = normalizeBearerToken(rawToken);
    if (!cleanToken) {
      const err = new Error('Upstox token is required');
      err.status = 400;
      throw err;
    }

    if (verify) {
      await this.upstox.verifyAccessToken(cleanToken);
    }

    const claims = decodeJwtClaims(cleanToken);
    const isLongLived = Boolean(
      claims?.expMs && claims?.iatMs && claims.expMs - claims.iatMs >= 30 * 86400 * 1000
    );
    const tokenSource = isLongLived ? 'analytics' : 'manual';

    this._saveEnv({
      UPSTOX_ACCESS_TOKEN: cleanToken,
      UPSTOX_EXTENDED_TOKEN: '',
    });
    this.upstox.updateConfig({
      accessToken: cleanToken,
      extendedToken: '',
      tokenSource,
    });

    if (this.upstox.isConnected() && !this.dryRun) {
      this.ensureUpstoxWebSocket().catch(() => {});
      this.runPollCycle({ manual: true }).catch(() => {});
    }
    this.broadcast('state', this.getPublicState());
    return { ok: true, status: this.upstox.getStatus() };
  }

  async completeUpstoxOAuth(code) {
    const profile = await this.upstox.exchangeCode(code);
    this._saveEnv({
      UPSTOX_ACCESS_TOKEN: this.upstox.accessToken,
      UPSTOX_EXTENDED_TOKEN: this.upstox.extendedToken || '',
    });
    if (!this.dryRun) {
      await this.runPollCycle({ manual: true });
      this.ensureUpstoxWebSocket().catch(() => {});
    }
    this.broadcast('state', this.getPublicState());
    return { profile, status: this.upstox.getStatus() };
  }

  disconnectUpstox() {
    this.upstox.clearToken();
    this._saveEnv({
      UPSTOX_ACCESS_TOKEN: '',
      UPSTOX_EXTENDED_TOKEN: '',
    });
    this.broadcast('state', this.getPublicState());
    return this.upstox.getStatus();
  }

  async start() {
    if (this.dryRun) {
      await this.runPollCycle({ forceDemo: !this.client.hasCredentials() });
      printDryRunSummary(this.state, this.store);
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

    await this.runPollCycle();
    this.startPollLoop();
  }
}

module.exports = { TredyeFlowService };
