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
      universe: this.state.allRanked.slice(0, 60),
      sectors: this.state.sectors,
      tracker: this.state.tracker,
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

      // Determine which shards we need to fetch for Top-N BULL + Top-N BEAR + pending reminders
      const neededShards = new Set();
      for (const item of [...ranked.topBull, ...ranked.topBear]) {
        if (item.stock.sh !== undefined && item.stock.sh !== null) {
          neededShards.add(item.stock.sh);
        }
      }
      for (const rem of this.store.listPendingReminders()) {
        const st = this.state.stocksBySymbol.get(rem.symbol);
        if (st && st.sh !== undefined && st.sh !== null) {
          neededShards.add(st.sh);
        }
      }
      for (const tr of this.store.listTrackerItems()) {
        const st = this.state.stocksBySymbol.get(tr.symbol);
        if (st && st.sh !== undefined && st.sh !== null) {
          neededShards.add(st.sh);
        }
      }

      for (const sh of neededShards) {
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
      }

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
