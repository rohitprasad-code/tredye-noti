'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateConfluence, scoreAndRankUniverse } = require('../src/engine/flow');
const { detectOrderBlocks, locateActionableOB } = require('../src/engine/orderblocks');
const { SignalEngine } = require('../src/engine/signals');
const { FlowStore } = require('../src/store/db');
const { UpstoxClient } = require('../src/upstox/client');
const { TredyeFlowService, buildOrderBlockRealData, compareOrderBlockCandidates, computeSetupScore } = require('../src/index');
const { createSampleDataset, buildBullishOBCandles, buildBearishOBCandles } = require('../data/sample-fixture');

test('evaluateConfluence matches Tredye sI() 5-signal bull/bear scoring', () => {
  const bullStock = {
    symbol: 'RELIANCE',
    ltp: 2928.4,
    vwap: 2911.2,
    poc: 2908.5,
    buy_pct: 66.4,
    cvd: 485000,
    imb: 28.5,
  };
  const resBull = evaluateConfluence(bullStock);
  assert.equal(resBull.bull, 5);
  assert.equal(resBull.n, 5);
  assert.equal(resBull.score, 5);
  assert.equal(resBull.side, 'BULL');
  assert.equal(resBull.agree, 5);

  const bearStock = {
    symbol: 'TATAMOTORS',
    ltp: 842.6,
    vwap: 849.8,
    poc: 851.5,
    buy_pct: 31.8,
    cvd: -1150000,
    imb: -36.4,
  };
  const resBear = evaluateConfluence(bearStock);
  assert.equal(resBear.bull, 0);
  assert.equal(resBear.bear, 5);
  assert.equal(resBear.score, -5);
  assert.equal(resBear.side, 'BEAR');
  assert.equal(resBear.agree, 5);
});

test('detectOrderBlocks (exact sp() port) detects Bullish and Bearish OBs and locates zones', () => {
  const bullCandles = buildBullishOBCandles(2928.4, 2915.0, 2923.0, 2928.4);
  const bullOBs = detectOrderBlocks(bullCandles);
  assert.ok(bullOBs.length >= 1, 'Expected at least 1 bullish OB');
  const mainBull = bullOBs.find(o => o.bull);
  assert.ok(mainBull, 'Expected a bullish OB');
  assert.equal(mainBull.bot, 2915.0);
  assert.equal(mainBull.top, 2923.0);
  assert.equal(mainBull.mit, false, 'Bullish OB should be untested when price stays at 2928.4');

  const bearCandles = buildBearishOBCandles(842.6, 841.5, 845.0, 842.6);
  const bearOBs = detectOrderBlocks(bearCandles);
  assert.ok(bearOBs.length >= 1, 'Expected at least 1 bearish OB');
  const mainBear = bearOBs.find(o => !o.bull);
  assert.ok(mainBear, 'Expected a bearish OB');
  assert.equal(mainBear.bot, 841.5);
  assert.equal(mainBear.top, 845.0);
});

test('locateActionableOB classifies IN_ZONE vs UNTESTED and computes reference buy/sell zones', () => {
  const sample = createSampleDataset();
  const ranked = scoreAndRankUniverse(sample.orderflow.stocks, { topN: 5 });

  // ICICIBANK has LTP 1284.5 inside Bullish OB [1281, 1286]
  const icici = sample.orderflow.stocks.find(s => s.symbol === 'ICICIBANK');
  const iciciDetail = sample.shards[icici.sh].stocks.find(s => s.symbol === 'ICICIBANK');
  const iciciOB = locateActionableOB(icici, iciciDetail, ranked.bySymbol.ICICIBANK);

  assert.ok(iciciOB.primaryOB);
  assert.equal(iciciOB.primaryOB.status, 'IN_ZONE');
  assert.equal(iciciOB.primaryOB.distPct, 0);
  assert.equal(iciciOB.referencePlan.shortAction, 'BUY OB');

  // RELIANCE has LTP 2928.4 just above Bullish OB [2915, 2923] (~0.184% away)
  const rel = sample.orderflow.stocks.find(s => s.symbol === 'RELIANCE');
  const relDetail = sample.shards[rel.sh].stocks.find(s => s.symbol === 'RELIANCE');
  const relOB = locateActionableOB(rel, relDetail, ranked.bySymbol.RELIANCE);

  assert.ok(relOB.primaryOB);
  assert.equal(relOB.primaryOB.status, 'UNTESTED');
  assert.ok(relOB.primaryOB.distPct > 0 && relOB.primaryOB.distPct < 0.25);
});

test('SignalEngine fires IN_ZONE, APPROACHING_OB, 2-poll NEW_STRONG_FLOW, FLOW_FLIP, and REMINDER_DUE', () => {
  const store = new FlowStore(':memory:');
  const engine = new SignalEngine({ db: store });
  const sample = createSampleDataset();
  const ranked = scoreAndRankUniverse(sample.orderflow.stocks, { topN: 5 });

  const stocksBySymbol = new Map(sample.orderflow.stocks.map(s => [s.symbol, s]));
  const obBySymbol = new Map();
  const candidates = [];

  for (const item of [...ranked.topBull, ...ranked.topBear]) {
    const sh = item.stock.sh;
    const detail = sample.shards[sh].stocks.find(s => s.symbol === item.stock.symbol);
    const obInfo = locateActionableOB(item.stock, detail, item.flow);
    obBySymbol.set(item.stock.symbol, obInfo);
    candidates.push({ stock: item.stock, flow: item.flow, obInfo });
  }

  const config = { minAgree: 4, confirmPolls: 2, obProximityPct: 0.5, cooldownMinutes: 20 };
  const t0 = 1762400000000;

  // Poll 1: IN_ZONE and APPROACHING_OB fire immediately; NEW_STRONG_FLOW waits for poll 2
  const alerts1 = engine.evaluatePoll(
    { candidates, bySymbol: ranked.bySymbol, stocksBySymbol, obBySymbol },
    config,
    t0
  );
  assert.ok(alerts1.some(a => a.symbol === 'ICICIBANK' && a.type === 'IN_ZONE'));
  assert.ok(alerts1.some(a => a.symbol === 'TATAMOTORS' && a.type === 'IN_ZONE'));
  assert.ok(alerts1.some(a => a.symbol === 'RELIANCE' && a.type === 'APPROACHING_OB'));
  assert.ok(!alerts1.some(a => a.type === 'NEW_STRONG_FLOW'), 'NEW_STRONG_FLOW should require 2 consecutive polls');

  // Poll 2 (60s later): NEW_STRONG_FLOW fires; IN_ZONE and APPROACHING_OB are suppressed by cooldown
  const alerts2 = engine.evaluatePoll(
    { candidates, bySymbol: ranked.bySymbol, stocksBySymbol, obBySymbol },
    config,
    t0 + 60000
  );
  assert.ok(alerts2.some(a => a.symbol === 'RELIANCE' && a.type === 'NEW_STRONG_FLOW'));
  assert.ok(!alerts2.some(a => a.symbol === 'ICICIBANK' && a.type === 'IN_ZONE'), 'Cooldown should suppress duplicate IN_ZONE');

  // Schedule a reminder and verify REMINDER_DUE evaluation
  const rem = store.addReminder({
    symbol: 'RELIANCE',
    expectedSide: 'BULL',
    minutes: 15,
    nowMs: t0,
  });
  const due = store.getDueReminders(t0 + 16 * 60 * 1000);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, rem.id);

  const remAlerts = engine.evaluateDueReminders(
    due,
    { bySymbol: ranked.bySymbol, stocksBySymbol, obBySymbol },
    t0 + 16 * 60 * 1000
  );
  assert.equal(remAlerts.length, 1);
  assert.equal(remAlerts[0].type, 'REMINDER_DUE');
  assert.match(remAlerts[0].title, /STILL HOLDS/);

  store.close();
});

test('My Tracker evaluates SELL_WATCH (step-back reminder) and BUY_WATCH (buy at right time)', () => {
  const store = new FlowStore(':memory:');
  const engine = new SignalEngine({ db: store });
  const sample = createSampleDataset();
  const ranked = scoreAndRankUniverse(sample.orderflow.stocks, { topN: 5 });

  const stocksBySymbol = new Map(sample.orderflow.stocks.map(s => [s.symbol, s]));
  const obBySymbol = new Map();
  for (const s of sample.orderflow.stocks) {
    const detail = sample.shards[s.sh]?.stocks?.find(d => d.symbol === s.symbol);
    obBySymbol.set(s.symbol, locateActionableOB(s, detail, ranked.bySymbol[s.symbol]));
  }

  store.upsertTrackerItem({ symbol: 'TATAMOTORS', mode: 'SELL_WATCH', entryPrice: 858 });
  store.upsertTrackerItem({ symbol: 'RELIANCE', mode: 'SELL_WATCH', entryPrice: 2890 });
  store.upsertTrackerItem({ symbol: 'ICICIBANK', mode: 'BUY_WATCH' });

  const { enrichedTracker, trackerAlerts } = engine.evaluateTrackerPositions(
    store.listTrackerItems(),
    { bySymbol: ranked.bySymbol, stocksBySymbol, obBySymbol },
    { minAgree: 4, obProximityPct: 0.5, cooldownMinutes: 20 }
  );

  const tata = enrichedTracker.find(t => t.symbol === 'TATAMOTORS');
  const rel = enrichedTracker.find(t => t.symbol === 'RELIANCE');
  const icici = enrichedTracker.find(t => t.symbol === 'ICICIBANK');

  assert.equal(tata.verdictCode, 'STEP_BACK_NOW');
  assert.equal(rel.verdictCode, 'HOLD_BULL_INTACT');
  assert.equal(icici.verdictCode, 'BUY_RIGHT_TIME');

  assert.ok(trackerAlerts.some(a => a.symbol === 'TATAMOTORS' && a.type === 'TRACKER_SELL'));
  assert.ok(trackerAlerts.some(a => a.symbol === 'ICICIBANK' && a.type === 'TRACKER_BUY'));

  store.close();
});

test('buildOrderBlockRealData rejects stale prior-day bars instead of spiking the last candle to live LTP', () => {
  const prevDayBars = Array.from({ length: 75 }, (_, i) => ({
    iso: `2026-11-09T09:${String(15 + (i % 45)).padStart(2, '0')}:00+05:30`,
    o: 610,
    h: 611.5,
    l: 609.5,
    c: 611,
    v: 10000,
  }));

  // Case 1: quoteDate is newer than rawBars date
  assert.equal(
    buildOrderBlockRealData(prevDayBars, {
      isBull: true,
      ltp: 663.75,
      prevClose: 611,
      quoteDate: '2026-11-11',
    }),
    null
  );

  // Case 2: even without quoteDate, full session closing on prevClose with large LTP jump is rejected
  assert.equal(
    buildOrderBlockRealData(prevDayBars, {
      isBull: true,
      ltp: 663.75,
      prevClose: 611,
    }),
    null
  );

  // Case 3: same-day bars matching the live session succeed without fabricating a spike
  const sameDayBars = prevDayBars.map((b, i) => ({
    ...b,
    iso: `2026-11-11T09:${String(15 + (i % 45)).padStart(2, '0')}:00+05:30`,
    o: 660,
    h: 664,
    l: 659,
    c: 663.5,
  }));
  const realX = buildOrderBlockRealData(sameDayBars, {
    isBull: true,
    ltp: 663.75,
    prevClose: 611,
    quoteDate: '2026-11-11',
  });
  assert.ok(realX);
  assert.equal(realX.k.c[realX.k.c.length - 1], 663.75);
  assert.ok(realX.k.h[realX.k.h.length - 1] <= 664);
});

test('compareOrderBlockCandidates ranks MAX_GAINS strictly by % move and FLOW_SCORE by confluence & strength', () => {
  const hdfc = { symbol: 'HDFCBANK', chgPct: 0.5, rupeeFlowCr: 5243, agree: 4, strengthScore: 53.4 };
  const paytm = { symbol: 'PAYTM', chgPct: 5.34, rupeeFlowCr: 294.7, agree: 4, strengthScore: 69.2 };
  const abcap = { symbol: 'ABCAPITAL', chgPct: 5.76, rupeeFlowCr: 68.3, agree: 5, strengthScore: 65.6 };
  const datap = { symbol: 'DATAPATTNS', chgPct: 5.18, rupeeFlowCr: -1330.4, agree: 3, strengthScore: 40.5 };

  const byMaxGains = [hdfc, paytm, abcap, datap]
    .slice()
    .sort((a, b) => compareOrderBlockCandidates(a, b, true, 'MAX_GAINS'))
    .map(x => x.symbol);
  assert.deepEqual(byMaxGains, ['ABCAPITAL', 'PAYTM', 'DATAPATTNS', 'HDFCBANK']);

  const byFlowScore = [hdfc, paytm, abcap, datap]
    .slice()
    .sort((a, b) => compareOrderBlockCandidates(a, b, true, 'FLOW_SCORE'))
    .map(x => x.symbol);
  assert.deepEqual(byFlowScore, ['ABCAPITAL', 'PAYTM', 'HDFCBANK', 'DATAPATTNS']);
});

test('evaluateConfluence computes depth imbalance from Upstox bid/ask depth arrays', () => {
  const res = evaluateConfluence({
    symbol: 'PAYTM',
    ltp: 1890,
    vwap: 1848,
    poc: 1788,
    buy_pct: 61.3,
    cvd: 1559781,
    imb: null,
    flowScore: -5, // stale value should be ignored when live depth is present
    depth: {
      buy: [{ price: 1889.9, quantity: 3000 }],
      sell: [{ price: 1890.1, quantity: 1000 }],
    },
  });
  assert.equal(res.agree, 5);
  assert.equal(res.side, 'BULL');
  assert.equal(res.checks.find(c => c.key === 'imb')?.bull, true);
});

test('computeSetupScore and SETUP_SCORE sort reward aligned OB proximity + strong flow', () => {
  const inZoneStrong = {
    symbol: 'ICICIBANK',
    chgPct: 2.5,
    rupeeFlowCr: 500,
    agree: 5,
    strengthScore: 75,
    bestBullOB: { status: 'IN_ZONE', distPct: 0, invalidated: false, mit: false },
  };
  const extendedStrong = {
    symbol: 'ABCAPITAL',
    chgPct: 5.5,
    rupeeFlowCr: 100,
    agree: 5,
    strengthScore: 72,
    bestBullOB: { status: 'UNTESTED', distPct: 4.2, invalidated: false, mit: false },
  };

  assert.equal(computeSetupScore(inZoneStrong, true), 75);
  assert.equal(computeSetupScore(extendedStrong, true), 68.2);

  const bySetup = [extendedStrong, inZoneStrong]
    .slice()
    .sort((a, b) => compareOrderBlockCandidates(a, b, true, 'SETUP_SCORE'))
    .map(x => x.symbol);
  assert.deepEqual(bySetup, ['ICICIBANK', 'ABCAPITAL']);
});

test('UpstoxClient.loadCachedInstruments invalidates v1 cache lacking exchangeToken and preserves v2', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tredye-upstox-cache-'));
  try {
    const cacheFile = path.join(tmpDir, 'instruments.json');
    const client = new UpstoxClient({});
    client.instrumentsFile = cacheFile;

    // Legacy v1 cache without exchangeToken should load fallback map but force refresh (instrumentsLoadedAt === 0)
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        loadedAt: Date.now(),
        entries: [{ sym: 'RELIANCE', key: 'NSE_EQ|INE002A01018', name: 'Reliance Industries', isin: 'INE002A01018', lotSize: 1 }],
      })
    );
    assert.equal(client.loadCachedInstruments(), true);
    assert.equal(client.instrumentsLoadedAt, 0);
    assert.equal(client.instrumentBySymbol.get('RELIANCE')?.isin, 'INE002A01018');

    // Version 2 cache with exchangeToken retains its loadedAt timestamp
    const freshTs = Date.now();
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        loadedAt: freshTs,
        entries: [{ sym: 'RELIANCE', key: 'NSE_EQ|INE002A01018', exchangeToken: '2885', name: 'Reliance Industries', isin: 'INE002A01018', lotSize: 1 }],
      })
    );
    assert.equal(client.loadCachedInstruments(), true);
    assert.equal(client.instrumentsLoadedAt, freshTs);
    assert.equal(client.instrumentBySymbol.get('RELIANCE')?.exchangeToken, '2885');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getOrderBlockFunnelSnapshot includes Upstox exchangeToken (et) and isin on formatted stocks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tredye-ob-et-'));
  const svc = new TredyeFlowService({ demo: true, dryRun: true, dbPath: path.join(tmpDir, 'flow.db') });
  try {
    // Prevent network fetches during offline unit test while injecting known instrument metadata
    svc.upstox.accessToken = '';
    svc.upstox.hasCredentials = () => false;
    svc.upstox.instrumentBySymbol.set('RELIANCE', {
      sym: 'RELIANCE',
      key: 'NSE_EQ|INE002A01018',
      exchangeToken: '2885',
      name: 'Reliance Industries',
      isin: 'INE002A01018',
      lotSize: 1,
    });
    svc.state.allRanked = [
      {
        symbol: 'RELIANCE',
        name: 'Reliance Industries',
        sector: 'ENERGY',
        chgPct: 2.1,
        ltp: 2928.4,
        prevClose: 2868.2,
        agree: 5,
        rupeeFlowCr: 420,
        strengthScore: 78,
        buildup: 'LONG BUILD-UP',
        bestBullOB: { str: 2.2, status: 'IN_ZONE', distPct: 0, invalidated: false, mit: false },
      },
      {
        symbol: 'UNMAPPED',
        name: 'Unmapped Corp',
        sector: 'IT',
        chgPct: -1.4,
        ltp: 100,
        prevClose: 101.4,
        agree: 4,
        rupeeFlowCr: -80,
        strengthScore: 60,
        buildup: 'SHORT BUILD-UP',
        bestBearOB: { str: 1.8, status: 'UNTESTED', distPct: 0.4, invalidated: false, mit: false },
      },
    ];
    const snap = await svc.getOrderBlockFunnelSnapshot({ sector: 'ALL', side: 'ALL', sort: 'MAX_GAINS' });
    const rel = snap.stocks.find(x => x.s === 'RELIANCE');
    const unmapped = snap.stocks.find(x => x.s === 'UNMAPPED');
    assert.ok(rel, 'Expected RELIANCE in funnel snapshot');
    assert.equal(rel.et, '2885');
    assert.equal(rel.isin, 'INE002A01018');
    assert.ok(unmapped, 'Expected UNMAPPED in funnel snapshot');
    assert.equal(unmapped.et, null);
    assert.equal(unmapped.isin, null);
  } finally {
    svc.store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});





