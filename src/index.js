'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getMarketStatus } = require('./market/hours');
const { TredyeClient } = require('./tredye/client');
const { scoreAndRankUniverse } = require('./engine/flow');
const { locateActionableOB } = require('./engine/orderblocks');
const { SignalEngine } = require('./engine/signals');
const { FlowStore } = require('./store/db');
const { dispatchAlertNotification } = require('./notify');
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
      tracker: [],
    };

    this.broadcast = () => {};
    this.pollTimer = null;
    this.reminderTimer = null;
    this.isPolling = false;
    this.seedStarterTrackerIfEmpty();
    this.seedStarterJournalIfEmpty();
  }

  seedStarterJournalIfEmpty() {
    try {
      const existing = this.store.listJournalEntries();
      const alreadySeeded = this.store.db
        .prepare(`SELECT value FROM settings WHERE key = 'journal_seeded'`)
        .get();
      if (existing.length === 0 && !alreadySeeded) {
        const now = Date.now();
        this.store.createJournalEntry({
          symbol: 'UNIONBANK',
          side: 'LONG',
          status: 'OPEN',
          qty: 400,
          entryPrice: 121.8,
          stopPrice: 118.5,
          targetPrice: 132.0,
          obZone: 'Bullish OB ₹121.20–₹122.40',
          setupType: '5/5 Bull Flow + Untested Demand OB',
          thesis: 'Strongest PSU Bank inflow (+5/5 signals, Long Buildup) bouncing off 3m Demand OB.',
          lessons: 'Hold while price stays above VWAP & Demand OB ₹121.20.',
          rating: 5,
          entryAt: now - 3 * 3600 * 1000,
        });
        this.store.createJournalEntry({
          symbol: 'TATASTEEL',
          side: 'LONG',
          status: 'OPEN',
          qty: 550,
          entryPrice: 181.3,
          stopPrice: 179.4,
          targetPrice: 187.5,
          obZone: 'Bullish OB ₹181.18–₹181.45',
          setupType: 'Order Block Pullback',
          thesis: 'Metals sector inflow leader; entered inside 3m Bullish OB with CVD rising.',
          lessons: 'Trail stop to ₹181.10 once R1 is tested.',
          rating: 5,
          entryAt: now - 5 * 3600 * 1000,
        });
        this.store.createJournalEntry({
          symbol: 'RELIANCE',
          side: 'LONG',
          status: 'OPEN',
          qty: 50,
          entryPrice: 1412.0,
          stopPrice: 1392.0,
          targetPrice: 1465.0,
          obZone: 'Demand Zone ₹1,405–₹1,414',
          setupType: 'Core Swing + Flow Confirmation',
          thesis: 'Accumulated near institutional POC support with steady buy-side absorption.',
          lessons: 'Step back only if 3m Bearish OB forms with 4/5 BEAR flow.',
          rating: 4,
          entryAt: now - 28 * 3600 * 1000,
        });
        this.store.createJournalEntry({
          symbol: 'PERSISTENT',
          side: 'LONG',
          status: 'CLOSED',
          qty: 20,
          entryPrice: 5940.0,
          exitPrice: 6110.0,
          stopPrice: 5880.0,
          targetPrice: 6115.0,
          obZone: 'Exited at Bearish Supply OB ₹6,106.50–₹6,114.50',
          setupType: 'OB-to-OB Swing',
          thesis: 'Bought at Demand OB and stepped back right when Tredye flagged Bearish Supply OB ₹6,106–6,114.',
          lessons: 'Stepping back at the opposing Supply OB locked in +₹3,400 before the IT pullback.',
          rating: 5,
          entryAt: now - 48 * 3600 * 1000,
          closedAt: now - 4 * 3600 * 1000,
        });
        this.store.db
          .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('journal_seeded', '1')`)
          .run();
      }
    } catch {
      // ignore
    }
  }

  seedStarterTrackerIfEmpty() {
    try {
      const existing = this.store.listTrackerItems();
      const alreadySeeded = this.store.db
        .prepare(`SELECT value FROM settings WHERE key = 'tracker_seeded'`)
        .get();
      if (existing.length === 0 && !alreadySeeded) {
        this.store.upsertTrackerItem({
          symbol: 'TATAMOTORS',
          mode: 'SELL_WATCH',
          entryPrice: 858,
          stopPrice: 845,
          notes: 'Holding — remind me on Bearish OB or BEAR flow to step back',
        });
        this.store.upsertTrackerItem({
          symbol: 'RELIANCE',
          mode: 'SELL_WATCH',
          entryPrice: 2890,
          targetPrice: 2948,
          notes: 'Riding up move — alert if flow flips BEAR or hits R1 ₹2,948',
        });
        this.store.upsertTrackerItem({
          symbol: 'ICICIBANK',
          mode: 'BUY_WATCH',
          targetPrice: 1286,
          notes: 'Stepped back earlier — notify when in Bullish OB + BULL flow to buy at right time',
        });
        this.store.db
          .prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('tracker_seeded', '1')`)
          .run();
      }
    } catch {
      // ignore
    }
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

  computeJournalState() {
    const rawEntries = this.store.listJournalEntries();
    let totalInvestedOpen = 0;
    let currentPortfolioValue = 0;
    let openPnlRs = 0;
    let realizedPnlRs = 0;
    let closedWins = 0;
    let closedTotal = 0;
    const sectorMap = new Map();

    const entries = rawEntries.map(e => {
      const card = this.state.allRanked.find(c => c.symbol === e.symbol) || null;
      const stock = this.state.stocksBySymbol.get(e.symbol) || null;
      const ltp = card?.ltp ?? stock?.ltp ?? e.exitPrice ?? e.entryPrice;
      const chgPct = card?.chgPct ?? stock?.chg_pct ?? 0;
      const sector = card?.sector ?? stock?.sector ?? 'Other';
      const flowSide = card?.side || 'FLAT';
      const agree = card?.agree ?? 0;
      const totalChecks = card?.totalChecks ?? 5;
      const buildup = card?.buildup || 'NEUTRAL';
      const bullOB = card?.bestBullOB || (card?.primaryOB?.bull ? card.primaryOB : null);
      const bearOB = card?.bestBearOB || (card?.primaryOB && !card.primaryOB.bull ? card.primaryOB : null);

      const isLong = e.side !== 'SHORT';
      const dir = isLong ? 1 : -1;
      const activePrice = e.status === 'CLOSED' && e.exitPrice != null ? e.exitPrice : ltp;
      const investedCapital = Number((e.qty * e.entryPrice).toFixed(2));
      const currentValue = Number((e.qty * activePrice).toFixed(2));
      const pnlPerShare = (activePrice - e.entryPrice) * dir;
      const pnlRs = Number((pnlPerShare * e.qty).toFixed(2));
      const pnlPct = e.entryPrice > 0 ? Number(((pnlPerShare / e.entryPrice) * 100).toFixed(2)) : 0;

      let rMultiple = null;
      if (e.stopPrice && Math.abs(e.entryPrice - e.stopPrice) > 0.001) {
        const riskPerShare = Math.abs(e.entryPrice - e.stopPrice);
        rMultiple = Number((pnlPerShare / riskPerShare).toFixed(2));
      }

      // Live Tredye Order-Flow & Order-Block Health Verdict on this investment
      let healthCode = 'HOLD_STEADY';
      let healthLabel = '🟢 FLOW INTACT — HOLD';
      let healthTone = 'up';
      let healthReason = `Live flow ${agree}/${totalChecks} ${flowSide} (${buildup})`;

      if (e.status === 'CLOSED') {
        healthCode = 'BOOKED';
        healthLabel = pnlRs >= 0 ? '✅ BOOKED PROFIT' : '📕 CLOSED TRADE';
        healthTone = pnlRs >= 0 ? 'up' : 'dn';
        healthReason = `Closed at ₹${activePrice} (${pnlPct >= 0 ? '+' : ''}${pnlPct}%)`;
      } else if (isLong) {
        if (e.stopPrice && ltp <= e.stopPrice) {
          healthCode = 'STOP_ALERT';
          healthLabel = '🚨 BELOW STOP FLOOR — STEP BACK';
          healthTone = 'dn';
          healthReason = `LTP ₹${ltp} broke your stop ₹${e.stopPrice}`;
        } else if (e.targetPrice && ltp >= e.targetPrice) {
          healthCode = 'TARGET_HIT';
          healthLabel = '🎯 TARGET REACHED — BOOK / TRAIL';
          healthTone = 'gold';
          healthReason = `LTP ₹${ltp} reached target ₹${e.targetPrice}`;
        } else if (flowSide === 'BEAR' && agree >= 4) {
          healthCode = 'STEP_BACK_WARNING';
          healthLabel = '⚠️ BEAR FLOW FLIP — WATCH CLOSELY';
          healthTone = 'warn';
          healthReason = `Tredye flow flipped ${agree}/${totalChecks} BEAR (${buildup})${bearOB ? ` · Supply OB ₹${bearOB.bot}–${bearOB.top}` : ''}`;
        } else if (bullOB && bullOB.distPct <= 0.35) {
          healthCode = 'AT_SUPPORT_OB';
          healthLabel = '🧱 IN DEMAND OB SUPPORT';
          healthTone = 'up';
          healthReason = `Testing Bullish Demand OB ₹${bullOB.bot}–₹${bullOB.top} with ${agree}/${totalChecks} ${flowSide}`;
        }
      } else {
        // SHORT position
        if (e.stopPrice && ltp >= e.stopPrice) {
          healthCode = 'STOP_ALERT';
          healthLabel = '🚨 ABOVE STOP — COVER WARNING';
          healthTone = 'dn';
          healthReason = `LTP ₹${ltp} crossed stop ₹${e.stopPrice}`;
        } else if (flowSide === 'BULL' && agree >= 4) {
          healthCode = 'STEP_BACK_WARNING';
          healthLabel = '⚠️ BULL FLOW FLIP — COVER CAUTION';
          healthTone = 'warn';
          healthReason = `Flow flipped ${agree}/${totalChecks} BULL (${buildup})`;
        }
      }

      if (e.status === 'OPEN') {
        totalInvestedOpen += investedCapital;
        currentPortfolioValue += currentValue;
        openPnlRs += pnlRs;
        sectorMap.set(sector, (sectorMap.get(sector) || 0) + currentValue);
      } else if (e.status === 'CLOSED') {
        realizedPnlRs += pnlRs;
        closedTotal += 1;
        if (pnlRs > 0) closedWins += 1;
      }

      const buyPct = Math.round(card?.buyPct ?? (stock ? (stock.bV / Math.max(1, stock.vol)) * 100 : 50));
      const refPrice = e.status === 'CLOSED' && e.exitPrice ? e.exitPrice : ltp;

      return {
        ...e,
        name: card?.name || stock?.name || e.symbol,
        sector,
        ltp,
        liveLtp: ltp,
        refPrice,
        chgPct,
        liveChgPct: chgPct,
        flowSide,
        liveSide: flowSide,
        agree,
        liveAgree: agree,
        totalChecks,
        liveTotalChecks: totalChecks,
        liveBuyPct: buyPct,
        liveStrength: card?.strengthScore || 50,
        buildup,
        investedCapital,
        currentValue,
        pnlRs,
        pnlPct,
        rMultiple,
        bullOB: bullOB ? { bot: bullOB.bot, top: bullOB.top, status: bullOB.status, distPct: bullOB.distPct } : null,
        bearOB: bearOB ? { bot: bearOB.bot, top: bearOB.top, status: bearOB.status, distPct: bearOB.distPct } : null,
        healthCode,
        healthLabel,
        healthTone,
        healthReason,
      };
    });

    const openPnlPct = totalInvestedOpen > 0 ? Number(((openPnlRs / totalInvestedOpen) * 100).toFixed(2)) : 0;
    const winRatePct = closedTotal > 0 ? Math.round((closedWins / closedTotal) * 100) : 100;
    const atRiskCount = entries.filter(
      x => x.status === 'OPEN' && (x.healthTone === 'warn' || x.healthTone === 'danger')
    ).length;
    const sectorAllocation = [...sectorMap.entries()]
      .map(([sector, value]) => {
        const cap = Number(value.toFixed(2));
        const pct = currentPortfolioValue > 0 ? Number(((value / currentPortfolioValue) * 100).toFixed(1)) : 0;
        return {
          sector,
          value: cap,
          capital: cap,
          pct,
          sharePct: pct,
        };
      })
      .sort((a, b) => b.value - a.value);

    return {
      entries,
      enriched: entries,
      summary: {
        totalInvestedOpen: Number(totalInvestedOpen.toFixed(2)),
        currentPortfolioValue: Number(currentPortfolioValue.toFixed(2)),
        totalCurrentOpen: Number(currentPortfolioValue.toFixed(2)),
        openPnlRs: Number(openPnlRs.toFixed(2)),
        openPnlPct,
        realizedPnlRs: Number(realizedPnlRs.toFixed(2)),
        closedPnlRs: Number(realizedPnlRs.toFixed(2)),
        winRatePct,
        openCount: entries.filter(x => x.status === 'OPEN').length,
        closedCount: closedTotal,
        atRiskCount,
        sectorAllocation,
      },
    };
  }

  getPublicState() {
    const market = getMarketStatus();
    const journalData = this.computeJournalState();
    return {
      sourceMode: this.state.sourceMode,
      authStatus: this.state.authStatus,
      hasCredentials: this.client.hasCredentials(),
      configuredEmail: this.client.email || null,
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
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
      tracker: this.state.tracker,
      journal: journalData.entries,
      journalSummary: journalData.summary,
      alerts: this.store.listAlerts(50, true),
      reminders: this.store.listPendingReminders(),
      snoozes: this.store.listActiveSnoozes(),
      config: this.config,
    };
  }

  recomputeTrackerState({ emitAlerts = false, manual = false } = {}) {
    const trackerItems = this.store.listTrackerItems();
    for (const item of trackerItems) {
      const stock = this.state.stocksBySymbol.get(item.symbol);
      if (stock && !this.state.obBySymbol.has(item.symbol)) {
        const obInfo = locateActionableOB(
          stock,
          this.state.detailBySymbol.get(item.symbol),
          this.state.flowBySymbol[item.symbol]
        );
        this.state.obBySymbol.set(item.symbol, obInfo);
      }
    }

    const { enrichedTracker, trackerAlerts } = this.signals.evaluateTrackerPositions(
      trackerItems,
      {
        bySymbol: this.state.flowBySymbol,
        stocksBySymbol: this.state.stocksBySymbol,
        obBySymbol: this.state.obBySymbol,
      },
      this.config,
      Date.now()
    );

    this.state.tracker = enrichedTracker;

    const saved = [];
    if (emitAlerts && trackerAlerts.length > 0) {
      for (const alert of trackerAlerts) {
        const id = this.store.insertAlert(alert);
        const stored = { ...alert, id, reviewed: false };
        saved.push(stored);
        if (!this.dryRun) {
          if (this.state.sourceMode === 'LIVE' || manual) {
            dispatchAlertNotification(stored, this.config, this.dashboardUrl).catch(() => {});
          }
          this.broadcast('alert', stored);
        }
      }
    }

    return { enrichedTracker, trackerAlerts, saved };
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

      // Evaluate any due reminders
      const dueReminders = this.store.getDueReminders(Date.now());
      const reminderAlerts = this.signals.evaluateDueReminders(
        dueReminders,
        {
          bySymbol: this.state.flowBySymbol,
          stocksBySymbol: this.state.stocksBySymbol,
          obBySymbol: this.state.obBySymbol,
        },
        Date.now()
      );
      for (const rem of dueReminders) {
        this.store.markReminderFired(rem.id);
      }

      // Evaluate "My Tracker" positions (Sell / Step-Back & Buy at Right Time)
      const { trackerAlerts } = this.recomputeTrackerState({ emitAlerts: false });

      const allTriggered = [...reminderAlerts, ...trackerAlerts, ...warmupAlerts, ...newAlerts];
      const savedAlerts = [];

      for (const alert of allTriggered) {
        const id = this.store.insertAlert(alert);
        const stored = { ...alert, id, reviewed: false };
        savedAlerts.push(stored);

        if (!this.dryRun) {
          // Dispatch macOS + Telegram notification for live mode or manual/reminder/tracker triggers
          const shouldNotifyOs =
            this.state.sourceMode === 'LIVE' ||
            alert.type === 'REMINDER_DUE' ||
            alert.type === 'TRACKER_SELL' ||
            alert.type === 'TRACKER_BUY' ||
            (manual && savedAlerts.length <= 3);
          if (shouldNotifyOs) {
            dispatchAlertNotification(stored, this.config, this.dashboardUrl).catch(() => {});
          }
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

  async checkDueRemindersTick() {
    const due = this.store.getDueReminders(Date.now());
    if (due.length === 0) return;

    // If last poll was > 20s ago, run a fresh poll first so the reminder checks fresh data
    if (!this.state.lastPollAt || Date.now() - this.state.lastPollAt > 20000) {
      await this.runPollCycle();
      return;
    }

    const reminderAlerts = this.signals.evaluateDueReminders(
      due,
      {
        bySymbol: this.state.flowBySymbol,
        stocksBySymbol: this.state.stocksBySymbol,
        obBySymbol: this.state.obBySymbol,
      },
      Date.now()
    );

    for (const rem of due) {
      this.store.markReminderFired(rem.id);
    }

    for (const alert of reminderAlerts) {
      const id = this.store.insertAlert(alert);
      const stored = { ...alert, id, reviewed: false };
      dispatchAlertNotification(stored, this.config, this.dashboardUrl).catch(() => {});
      this.broadcast('alert', stored);
    }

    this.broadcast('state', this.getPublicState());
  }

  scheduleReminder({ symbol, minutes = 15, expectedSide, obBot, obTop, note }) {
    const sym = symbol.toUpperCase();
    const flow = this.state.flowBySymbol[sym];
    const obInfo = this.state.obBySymbol.get(sym);
    const rem = this.store.addReminder({
      symbol: sym,
      minutes,
      expectedSide: expectedSide || flow?.side || null,
      obBot: obBot ?? obInfo?.primaryOB?.bot ?? null,
      obTop: obTop ?? obInfo?.primaryOB?.top ?? null,
      note: note || null,
    });
    this.broadcast('state', this.getPublicState());
    return rem;
  }

  cancelReminder(id) {
    this.store.cancelReminder(id);
    this.broadcast('state', this.getPublicState());
  }

  snoozeSymbol(symbol, minutes = 30) {
    this.store.snoozeSymbol(symbol, minutes);
    this.broadcast('state', this.getPublicState());
  }

  unsnoozeSymbol(symbol) {
    this.store.unsnoozeSymbol(symbol);
    this.broadcast('state', this.getPublicState());
  }

  markAlertReviewed(id, reviewed = true) {
    this.store.markAlertReviewed(id, reviewed);
    this.broadcast('state', this.getPublicState());
  }

  markAllAlertsReviewed() {
    this.store.markAllAlertsReviewed();
    this.broadcast('state', this.getPublicState());
  }

  async upsertTrackerPosition(payload) {
    const sym = String(payload.symbol || '').trim().toUpperCase();
    if (!sym) throw new Error('symbol is required');

    // If we don't have shard detail for this symbol yet, fetch it
    await this.getStockDetail(sym).catch(() => {});

    const item = this.store.upsertTrackerItem({
      symbol: sym,
      mode: payload.mode || 'SELL_WATCH',
      entryPrice: payload.entryPrice,
      targetPrice: payload.targetPrice,
      stopPrice: payload.stopPrice,
      qty: payload.qty,
      notes: payload.notes,
    });

    // Clear cooldowns for this symbol's tracker alerts so user gets immediate evaluation
    this.signals.cooldowns.delete(`${sym}:TRACKER_SELL`);
    this.signals.cooldowns.delete(`${sym}:TRACKER_BUY`);

    this.recomputeTrackerState({ emitAlerts: true, manual: true });
    this.broadcast('state', this.getPublicState());
    return this.state.tracker.find(t => t.symbol === sym) || item;
  }

  async switchTrackerMode(symbol, mode, extra = {}) {
    const sym = String(symbol || '').trim().toUpperCase();
    await this.getStockDetail(sym).catch(() => {});
    this.store.updateTrackerMode(sym, mode, extra);

    this.signals.cooldowns.delete(`${sym}:TRACKER_SELL`);
    this.signals.cooldowns.delete(`${sym}:TRACKER_BUY`);

    this.recomputeTrackerState({ emitAlerts: true, manual: true });
    this.broadcast('state', this.getPublicState());
    return this.state.tracker.find(t => t.symbol === sym);
  }

  removeTrackerPosition(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    this.store.removeTrackerItem(sym);
    this.recomputeTrackerState({ emitAlerts: false });
    this.broadcast('state', this.getPublicState());
  }

  getJournalState() {
    const { enriched, summary } = this.computeJournalState();
    return { journal: enriched, journalSummary: summary };
  }

  async createJournalItem(payload) {
    const sym = String(payload.symbol || '').trim().toUpperCase();
    if (!sym) throw new Error('symbol is required');

    await this.getStockDetail(sym).catch(() => {});
    const stock = this.state.stocksBySymbol.get(sym);
    const obInfo = this.state.obBySymbol.get(sym);
    const side = (payload.side || 'BUY').toUpperCase();
    const defaultOb = side === 'SELL' ? obInfo?.bestBearOB : obInfo?.bestBullOB;
    const defaultZone =
      defaultOb
        ? `${defaultOb.type === 'bear' ? 'Bear' : 'Bull'} OB ₹${defaultOb.bot}–₹${defaultOb.top} (${defaultOb.str}x)`
        : '';

    const created = this.store.createJournalEntry({
      ...payload,
      symbol: sym,
      sector: payload.sector || stock?.sector || '',
      obZone: payload.obZone || defaultZone,
      entryPrice: payload.entryPrice !== undefined && payload.entryPrice !== '' ? payload.entryPrice : stock?.ltp,
    });

    if (payload.syncToTracker && (created.status || 'OPEN') === 'OPEN') {
      await this.upsertTrackerPosition({
        symbol: sym,
        mode: 'SELL_WATCH',
        entryPrice: created.entryPrice,
        stopPrice: created.stopPrice,
        targetPrice: created.targetPrice,
        qty: created.qty,
        notes: created.thesis || created.setupType || 'Synced from Journal Booklet',
      }).catch(() => {});
    }

    this.broadcast('state', this.getPublicState());
    const { enriched, summary } = this.computeJournalState();
    return {
      item: enriched.find(e => e.id === created.id) || created,
      journal: enriched,
      journalSummary: summary,
    };
  }

  async updateJournalItem(id, patch) {
    const updated = this.store.updateJournalEntry(id, patch);
    if (!updated) throw new Error(`Journal entry #${id} not found`);
    this.broadcast('state', this.getPublicState());
    const { enriched, summary } = this.computeJournalState();
    return {
      item: enriched.find(e => e.id === Number(id)) || updated,
      journal: enriched,
      journalSummary: summary,
    };
  }

  deleteJournalItem(id) {
    this.store.deleteJournalEntry(id);
    this.broadcast('state', this.getPublicState());
    const { enriched, summary } = this.computeJournalState();
    return {
      journal: enriched,
      journalSummary: summary,
    };
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

  async updateCredentials({ email, password, cookie, telegramBotToken, telegramChatId }) {
    const envUpdates = {};
    if (email !== undefined) envUpdates.TREDYE_EMAIL = String(email).trim();
    if (password !== undefined && password !== '') envUpdates.TREDYE_PASSWORD = String(password);
    if (cookie !== undefined) envUpdates.TREDYE_COOKIE = String(cookie).trim();
    if (telegramBotToken !== undefined) envUpdates.TELEGRAM_BOT_TOKEN = String(telegramBotToken).trim();
    if (telegramChatId !== undefined) envUpdates.TELEGRAM_CHAT_ID = String(telegramChatId).trim();

    saveDotEnvKeyValues(envUpdates);
    this.client.updateCredentials({ email, password, cookie });
    this.demoMode = false;

    let loginResult = { ok: true };
    if (this.client.email && this.client.password) {
      try {
        loginResult = await this.client.login();
      } catch (err) {
        this.state.lastError = err.message;
        this.state.authStatus = 'AUTH_ERROR';
        this.broadcast('state', this.getPublicState());
        return { ok: false, error: err.message };
      }
    }

    while (this.isPolling) {
      await new Promise(r => setTimeout(r, 150));
    }
    const pollRes = await this.runPollCycle({ manual: true });
    return {
      ok: pollRes.ok !== false,
      error: pollRes.error || null,
      loginResult,
      state: this.getPublicState(),
    };
  }

  async sendTestNotification(symbol) {
    const targetCard =
      (symbol && this.state.allRanked.find(c => c.symbol === symbol.toUpperCase())) ||
      this.state.topBull[0] ||
      this.state.topBear[0];

    const testAlert = targetCard
      ? {
          symbol: targetCard.symbol,
          type: 'IN_ZONE',
          priority: 'HIGH',
          side: targetCard.side,
          action: targetCard.side === 'BEAR' ? 'SELL' : 'BUY',
          title: `🔔 Test Reminder: ${targetCard.symbol} — ${targetCard.side} Flow (${targetCard.agree}/${targetCard.totalChecks})`,
          message: `${targetCard.symbol} at ₹${targetCard.ltp} · ${targetCard.referencePlan?.action || 'Order Block'} ${targetCard.referencePlan?.zoneText || ''}. Review setup on dashboard.`,
          ltp: targetCard.ltp,
          obBot: targetCard.primaryOB?.bot,
          obTop: targetCard.primaryOB?.top,
          obDistPct: targetCard.primaryOB?.distPct ?? 0,
        }
      : {
          symbol: 'RELIANCE',
          type: 'IN_ZONE',
          priority: 'HIGH',
          side: 'BULL',
          action: 'BUY',
          title: '🔔 Tredye Flow Alerts — Test Notification',
          message: 'RELIANCE — strong BUY flow (5/5), price 0.18% above Bullish OB ₹2,915–2,923. Review it.',
          ltp: 2928.4,
          obBot: 2915,
          obTop: 2923,
          obDistPct: 0.18,
        };

    const res = await dispatchAlertNotification(testAlert, this.config, this.dashboardUrl);
    this.broadcast('toast', {
      title: testAlert.title,
      message: testAlert.message,
      symbol: testAlert.symbol,
      side: testAlert.side,
    });
    return res;
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

    // 5s reminder check loop so scheduled reminders fire promptly
    this.reminderTimer = setInterval(() => {
      this.checkDueRemindersTick().catch(() => {});
    }, 5000);
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

module.exports = { TredyeFlowService };
