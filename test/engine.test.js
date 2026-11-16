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
const { UpstoxClient, normalizeBearerToken, decodeJwtClaims } = require('../src/upstox/client');
const { TredyeFlowService, buildOrderBlockRealData, compareOrderBlockCandidates, computeSetupScore } = require('../src/index');
const { createDashboardServer } = require('../src/server/server');
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

test('computeSetupScore rewards RETESTED_HELD OBs and excludes opposing-flow credit', () => {
  const retestedBull = {
    symbol: 'AMBER',
    side: 'BULL',
    chgPct: 2.5,
    rupeeFlowCr: 200,
    agree: 5,
    strengthScore: 60,
    bestBullOB: { status: 'RETESTED_HELD', distPct: 0.35, invalidated: false, mit: true },
  };
  const mitigatedBull = {
    ...retestedBull,
    symbol: 'MITIGATED_CO',
    bestBullOB: { status: 'MITIGATED', distPct: 0.2, invalidated: false, mit: true },
  };
  // flow = 60*0.6 = 36, mom = (2.5/5)*20 = 10, RETESTED_HELD<=0.5 = 17 => 63
  assert.equal(computeSetupScore(retestedBull, true), 63);
  assert.equal(computeSetupScore(mitigatedBull, true), 46);

  const counterBearInGreen = {
    symbol: 'LT',
    side: 'BEAR',
    chgPct: 0.5,
    rupeeFlowCr: -1300,
    agree: 5,
    strengthScore: 80,
    checks: Array(5).fill({ bull: false }),
    bestBullOB: { status: 'UNTESTED', distPct: 0.4, invalidated: false, mit: false },
  };
  const alignedBull = {
    symbol: 'CUMMINSIND',
    side: 'BULL',
    chgPct: 1.5,
    rupeeFlowCr: 150,
    agree: 4,
    strengthScore: 55,
    checks: [true, true, true, true, false].map(b => ({ bull: b })),
    bestBullOB: { status: 'UNTESTED', distPct: 0.8, invalidated: false, mit: false },
  };

  // Counter-flow BEAR stock gets 0 flowPts (mom=2 + ob=15 => 17), never 80*0.6!
  assert.equal(computeSetupScore(counterBearInGreen, true), 17);
  assert.equal(computeSetupScore(alignedBull, true), 49);

  for (const sort of ['FLOW_SCORE', 'SETUP_SCORE']) {
    const ordered = [counterBearInGreen, alignedBull]
      .slice()
      .sort((a, b) => compareOrderBlockCandidates(a, b, true, sort))
      .map(x => x.symbol);
    assert.deepEqual(ordered, ['CUMMINSIND', 'LT']);
  }

  // Missing buy_pct must be skipped rather than counted as a BEAR check
  const noBuyPct = evaluateConfluence({
    symbol: 'TEST',
    ltp: 110,
    vwap: 100,
    poc: 102,
    buy_pct: null,
    cvd: 5000,
    imb: 15,
  });
  assert.equal(noBuyPct.n, 4);
  assert.equal(noBuyPct.agree, 4);
  assert.equal(noBuyPct.side, 'BULL');
});

test('getOrderBlockFunnelSnapshot keeps directional flowAgree and uncorrupted crash % moves', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tredye-sort-snap-'));
  const svc = new TredyeFlowService({ demo: true, dryRun: true, dbPath: path.join(tmpDir, 'flow.db') });
  try {
    svc.upstox.accessToken = '';
    svc.upstox.hasCredentials = () => false;
    svc.state.allRanked = [
      {
        symbol: 'ONGC',
        name: 'ONGC',
        sector: 'OIL & GAS',
        side: 'BEAR',
        chgPct: 0.6,
        ltp: 250,
        prevClose: 248.5,
        agree: 5,
        totalChecks: 5,
        checks: Array(5).fill({ bull: false }),
        rupeeFlowCr: -450,
        strengthScore: 76,
        buildup: 'LONG UNWINDING',
      },
      {
        symbol: 'AMBER',
        name: 'Amber',
        sector: 'CONSUMER',
        side: 'BULL',
        chgPct: 4.0,
        ltp: 6500,
        prevClose: 6250,
        agree: 4,
        totalChecks: 5,
        checks: [true, true, true, true, false].map(b => ({ bull: b })),
        rupeeFlowCr: 220,
        strengthScore: 70,
        buildup: 'LONG BUILD-UP',
      },
      {
        symbol: 'CRASH1',
        name: 'Crash One',
        sector: 'FIN',
        side: 'BEAR',
        chgPct: -12.4,
        ltp: 87.6,
        prevClose: 100,
        agree: 5,
        totalChecks: 5,
        checks: Array(5).fill({ bull: false }),
        rupeeFlowCr: -300,
        strengthScore: 80,
      },
      {
        symbol: 'CRASH2',
        name: 'Crash Two',
        sector: 'FIN',
        side: 'BEAR',
        chgPct: -10.8,
        ltp: 89.2,
        prevClose: 100,
        agree: 4,
        totalChecks: 5,
        checks: [false, false, false, false, true].map(b => ({ bull: b })),
        rupeeFlowCr: -150,
        strengthScore: 65,
      },
    ];

    const flowSnap = await svc.getOrderBlockFunnelSnapshot({ sort: 'FLOW_SCORE' });
    const bulls = flowSnap.stocks.filter(s => s.g === 'bull');
    assert.deepEqual(bulls.map(b => b.s), ['AMBER', 'ONGC']);
    assert.equal(bulls[1].flowAgree, 0);
    assert.equal(bulls[1].strengthScore, 0);

    const crash2 = flowSnap.stocks.find(s => s.s === 'CRASH2');
    assert.equal(crash2?.c, -10.8);
  } finally {
    svc.store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TredyeClient normalizes BUILDUP strings from flow.json feed', async () => {
  const { TredyeClient } = require('../src/tredye/client');
  const origFetch = global.fetch;
  try {
    global.fetch = async url => {
      if (String(url).includes('orderflow.json')) {
        return {
          ok: true,
          json: async () => ({
            stocks: [
              { symbol: 'POWERINDIA', buy_pct: 64, tv: 100 },
              { symbol: 'POWERGRID', buy_pct: 36, tv: 90 },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          stocks: [
            { s: 'POWERINDIA', fo: true, g: 'CAP GOODS', f: 1400, bu: 'LONG BUILDUP', doi: 4.5, rv: 2.1 },
            { s: 'POWERGRID', fo: true, g: 'POWER', f: -1200, bu: 'SHORT BUILDUP', doi: 3.1, rv: 1.8 },
          ],
        }),
      };
    };

    const client = new TredyeClient({ cookie: 'session=ok' });
    const data = await client.fetchOrderFlow();
    const pIndia = data.stocks.find(s => s.symbol === 'POWERINDIA');
    const pGrid = data.stocks.find(s => s.symbol === 'POWERGRID');
    assert.equal(pIndia.buildup, 'LONG BUILD-UP');
    assert.equal(pGrid.buildup, 'SHORT BUILD-UP');
  } finally {
    global.fetch = origFetch;
  }
});

test('orderblock.html handles 0-bull sectors, pure BULL/BEAR side filters, and BUILDUP OI sign without crashing', () => {
  const vm = require('node:vm');
  const { getOrderBlockTestScripts } = require('../src/client/orderblock');
  const scripts = getOrderBlockTestScripts();
  assert.equal(scripts.length, 3);
  scripts[2] = scripts[2].replace(
    /\}\)\(\);\s*$/,
    '; window.__OB_TEST = { buildModel, layout, buildTickets, setM: m => { M = m; }, setG: g => { G = g; } }; })();'
  );

  const c2dProxy = () =>
    new Proxy(
      {
        measureText: () => ({ width: 20 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        font: '',
      },
      { get: (t, k) => (k in t ? t[k] : () => {}) }
    );
  function mkEl(tag) {
    const cls = new Set();
    const el = {
      tagName: (tag || 'DIV').toUpperCase(),
      style: { setProperty() {}, getPropertyValue: () => '' },
      dataset: { vfs: '12' },
      children: [],
      parentNode: null,
      classList: {
        add(...a) { a.forEach(x => cls.add(x)); },
        remove(...a) { a.forEach(x => cls.delete(x)); },
        toggle() {},
        contains: x => cls.has(x),
      },
      className: '',
      innerHTML: '',
      textContent: '',
      scrollWidth: 50,
      clientWidth: 100,
      offsetWidth: 100,
      offsetLeft: 0,
      offsetTop: 0,
      querySelector() {
        const c = mkEl('div');
        c.parentNode = el;
        c.children = [mkEl('div'), mkEl('div')];
        c.children.forEach(x => { x.parentNode = c; });
        return c;
      },
      querySelectorAll: () => [],
      closest: () => el,
      appendChild(c) { c.parentNode = el; this.children.push(c); return c; },
      insertBefore(c) { c.parentNode = el; this.children.unshift(c); return c; },
      remove() {},
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      getContext: () => c2dProxy(),
    };
    el.parentNode = el;
    return el;
  }

  const ctx = vm.createContext({
    location: { search: '' },
    innerWidth: 1600,
    innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    CanvasRenderingContext2D: Object.assign(function () {}, {
      prototype: { fillStyle: '', strokeStyle: '', globalCompositeOperation: 'source-over', createLinearGradient() {}, createRadialGradient() {} },
    }),
    CanvasGradient: Object.assign(function () {}, { prototype: { addColorStop() {} } }),
    history: { replaceState() {} },
    document: {
      documentElement: mkEl('html'),
      body: mkEl('body'),
      createElement: t => mkEl(t),
      getElementById: () => mkEl('div'),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      readyState: 'complete',
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'node' },
    URLSearchParams,
    EventSource: function () { return { addEventListener() {} }; },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame() {},
    getComputedStyle: () => ({ fontSize: '12px', getPropertyValue: () => '' }),
    performance: { now: () => 0 },
    Math, Date, Number, String, Array, Object, Set, Map, Float32Array, Int32Array, JSON, Error, RegExp, console, Promise,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
  });
  ctx.window = ctx;
  ctx.self = ctx;
  for (const sc of scripts) vm.runInContext(sc, ctx);
  const { buildModel, layout, buildTickets, setM, setG } = ctx.__OB_TEST;

  const baseSnap = {
    meta: { status: 'live', clock: '14:00:00', el: 285, open: '09:15', close: '15:30', filter: { sector: 'ALL', side: 'ALL', sort: 'SETUP_SCORE' } },
    sectors: [{ sec: 'POWER', chg: -1.8, adv: 0, n: 2 }, { sec: 'CAP GOODS', chg: 1.5, adv: 1, n: 1 }],
    stocks: [
      { s: 'POWERGRID', n: 'Power Grid', sec: 'POWER', g: 'bear', c: -2.4, cp: -2.4, p: 0.01, o: 300, l: 292.8, top: true, fo: true, w: 1.2, bu: 'SHORT BUILDUP', setupScore: 80, flowAgree: 5 },
      { s: 'TATAPOWER', n: 'Tata Power', sec: 'POWER', g: 'bear', c: -1.9, cp: -1.9, p: 0.12, o: 400, l: 392.4, top: true, fo: true, w: 1.1, bu: 'LONG UNWINDING', setupScore: 65, flowAgree: 4 },
      { s: 'POWERINDIA', n: 'Hitachi Energy', sec: 'CAP GOODS', g: 'bull', c: 5.2, cp: 5.2, p: 0.99, o: 10000, l: 10520, top: true, fo: true, w: 1.4, bu: 'LONG BUILDUP', setupScore: 90, flowAgree: 5 },
    ],
  };

  // 1) 0-bull sector must render bear tickets without M.buyPicks[0] TypeError + normalize BUILDUP & OI sign
  const zeroBullSnap = {
    ...baseSnap,
    meta: { ...baseSnap.meta, filter: { sector: 'POWER', side: 'ALL', sort: 'SETUP_SCORE' } },
    stocks: baseSnap.stocks.filter(x => x.sec === 'POWER'),
  };
  const mZeroBull = buildModel(zeroBullSnap);
  const gZeroBull = layout(760, mZeroBull);
  setM(mZeroBull);
  setG(gZeroBull);
  assert.doesNotThrow(() => buildTickets(mZeroBull, gZeroBull, mkEl('div')));
  assert.equal(mZeroBull.buyPicks.length, 0);
  assert.equal(mZeroBull.sellPicks[0].bu, 'SHORT BUILD-UP');
  assert.ok(mZeroBull.sellPicks[0].oi > 0, 'SHORT BUILDUP must yield positive OI');
  assert.equal(mZeroBull.sellPicks[1].bu, 'LONG UNWINDING');
  assert.ok(mZeroBull.sellPicks[1].oi < 0, 'LONG UNWINDING must yield negative OI');

  // 2) side=BEAR and side=BULL must not inject fake _anchor picks/tickets
  const mBear = buildModel({ ...baseSnap, meta: { ...baseSnap.meta, filter: { sector: 'ALL', side: 'BEAR', sort: 'SETUP_SCORE' } } });
  assert.equal(mBear.buyPicks.length, 0);
  assert.equal(mBear.bulls.length, 0);
  assert.ok(mBear.sellPicks.every(s => !s._anchor));

  const mBull = buildModel({ ...baseSnap, meta: { ...baseSnap.meta, filter: { sector: 'ALL', side: 'BULL', sort: 'SETUP_SCORE' } } });
  assert.equal(mBull.sellPicks.length, 0);
  assert.equal(mBull.bears.length, 0);
  assert.equal(mBull.buyPicks[0].bu, 'LONG BUILD-UP');
  assert.ok(mBull.buyPicks[0].oi > 0, 'LONG BUILDUP must yield positive OI');
  assert.equal(mBull.buyPicks[0].pips[2], true);
});

test('orderblock.html preserves hover brush and inspector across fetch/rerender updates without flicker', () => {
  const vm = require('node:vm');
  const { getOrderBlockTestScripts } = require('../src/client/orderblock');
  const scripts = getOrderBlockTestScripts();
  assert.equal(scripts.length, 3);
  scripts[2] = scripts[2].replace(
    /\}\)\(\);\s*$/,
    '; window.__OB_HOVER_TEST = { setM: m => { M = m; }, getFX: () => FX, buildModel, renderStage, rerender, applyBrush, bindInteractions }; })();'
  );

  const c2dProxy = () =>
    new Proxy(
      {
        measureText: () => ({ width: 20 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        font: '',
      },
      { get: (t, k) => (k in t ? t[k] : () => {}) }
    );

  const byId = new Map();
  function mkEl(tag, id) {
    const cls = new Set();
    const attrs = new Map();
    const listeners = new Map();
    let _innerHTML = '';
    const el = {
      tagName: (tag || 'DIV').toUpperCase(),
      id: id || '',
      style: { setProperty() {}, getPropertyValue: () => '' },
      dataset: { vfs: '12' },
      children: [],
      parentNode: null,
      classList: {
        add(...a) { a.forEach(x => cls.add(x)); },
        remove(...a) { a.forEach(x => cls.delete(x)); },
        toggle(x, force) {
          if (force === true) cls.add(x);
          else if (force === false) cls.delete(x);
          else if (cls.has(x)) cls.delete(x);
          else cls.add(x);
        },
        contains: x => cls.has(x),
      },
      set className(v) {
        cls.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach(x => cls.add(x));
      },
      get className() {
        return [...cls].join(' ');
      },
      set innerHTML(v) {
        _innerHTML = String(v || '');
        if (_innerHTML === '') this.children = [];
      },
      get innerHTML() {
        return _innerHTML;
      },
      textContent: '',
      scrollWidth: 50,
      clientWidth: 100,
      offsetWidth: 100,
      offsetHeight: 280,
      offsetLeft: 0,
      offsetTop: 0,
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentNode === cur ? null : cur.parentNode;
        }
        return false;
      },
      querySelector(sel) {
        const list = el.querySelectorAll(sel);
        if (list.length) return list[0];
        if (sel.includes('data-k') || sel.includes('data-sec') || sel.startsWith('#')) return null;
        const fallback = mkEl('div');
        fallback.parentNode = el;
        fallback.children = [mkEl('div'), mkEl('div')];
        fallback.children.forEach(x => { x.parentNode = fallback; });
        return fallback;
      },
      querySelectorAll(sel) {
        const parts = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
        const matchesPart = (node, p) => {
          const dataMatch = p.match(/\[data-k="([^"]+)"\]/);
          if (dataMatch) {
            return (node.dataset && node.dataset.k) === dataMatch[1] || node.getAttribute('data-k') === dataMatch[1];
          }
          const secMatch = p.match(/\.chip\[data-sec="([^"]+)"\]/);
          if (secMatch) {
            return node.classList.contains('chip') && ((node.dataset && node.dataset.sec) === secMatch[1] || node.getAttribute('data-sec') === secMatch[1]);
          }
          if (p.startsWith('#')) {
            return node.id === p.slice(1);
          }
          if (p.startsWith('.')) {
            return node.classList.contains(p.slice(1));
          }
          return false;
        };
        const out = [];
        const walk = node => {
          for (const ch of node.children || []) {
            if (parts.some(p => matchesPart(ch, p))) out.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
      closest(sel) {
        const toks = String(sel || '').split(',').map(s => s.trim()).filter(Boolean);
        let cur = el;
        while (cur) {
          for (const tok of toks) {
            if (tok === '[data-k]' && ((cur.dataset && cur.dataset.k !== undefined) || cur.getAttribute('data-k') !== null)) return cur;
            if (tok.startsWith('.') && cur.classList.contains(tok.slice(1))) return cur;
            if (tok.startsWith('#') && cur.id === tok.slice(1)) return cur;
          }
          cur = cur.parentNode === cur ? null : cur.parentNode;
        }
        return null;
      },
      appendChild(c) {
        c.parentNode = el;
        this.children.push(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      insertBefore(c) {
        c.parentNode = el;
        this.children.unshift(c);
        if (c.id) byId.set(c.id, c);
        return c;
      },
      remove() {},
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') { el.id = String(v); byId.set(el.id, el); }
        if (k.startsWith('data-')) el.dataset[k.slice(5)] = String(v);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        ev.target = ev.target || el;
        ev.preventDefault = ev.preventDefault || (() => {});
        ev.stopPropagation = ev.stopPropagation || (() => {});
        let cur = el;
        while (cur) {
          const handlers = cur._listeners && cur._listeners.get(ev.type);
          if (handlers) handlers.forEach(fn => fn(ev));
          cur = cur.parentNode === cur ? null : cur.parentNode;
        }
        return true;
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
      getContext: () => c2dProxy(),
      _listeners: listeners,
    };
    if (id) byId.set(id, el);
    return el;
  }

  const stage = mkEl('div', 'stage');
  for (const id of ['crest', 'plumeWrap', 'chips', 'idxTags', 'ladderWrap', 'nodes', 'tiles', 'bridges', 'tickets', 'fxWrap', 'inspector', 'footer']) {
    stage.appendChild(mkEl('div', id));
  }
  const toastEl = mkEl('div', 'obActionToast');
  toastEl.className = 'ob-toast';
  let pointEl = null;

  const gsapSets = [];
  const gsapTos = [];

  const ctx = vm.createContext({
    location: { search: '', origin: 'http://localhost:4600' },
    innerWidth: 2100,
    innerHeight: 1200,
    CSS: { escape: s => String(s) },
    MouseEvent: function (type, init) { return Object.assign({ type }, init || {}); },
    gsap: {
      set(el, props) { gsapSets.push({ el, props }); },
      to(el, props) { gsapTos.push({ el, props }); },
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    CanvasRenderingContext2D: Object.assign(function () {}, {
      prototype: { fillStyle: '', strokeStyle: '', globalCompositeOperation: 'source-over', createLinearGradient() {}, createRadialGradient() {} },
    }),
    CanvasGradient: Object.assign(function () {}, { prototype: { addColorStop() {} } }),
    history: { replaceState() {} },
    document: {
      documentElement: mkEl('html'),
      body: mkEl('body'),
      createElement: t => mkEl(t),
      getElementById: id => byId.get(id) || mkEl('div', id),
      querySelector: sel => {
        if (sel === '#stage') return stage;
        if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
        return stage.querySelector(sel);
      },
      querySelectorAll: sel => stage.querySelectorAll(sel),
      elementFromPoint: () => {
        if (pointEl === toastEl && toastEl.style.pointerEvents === 'none') {
          return stage.querySelector('[data-k="POWERINDIA"]') || stage;
        }
        return pointEl;
      },
      addEventListener() {},
      readyState: 'complete',
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'node' },
    URLSearchParams,
    EventSource: function () { return { addEventListener() {} }; },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame() {},
    getComputedStyle: () => ({ fontSize: '12px', getPropertyValue: () => '' }),
    performance: { now: () => 1000 },
    Math, Date, Number, String, Array, Object, Set, Map, Float32Array, Int32Array, JSON, Error, RegExp, console, Promise,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
  });
  ctx.window = ctx;
  ctx.self = ctx;
  for (const sc of scripts) vm.runInContext(sc, ctx);

  const api = ctx.__OB_HOVER_TEST;
  const makeSnap = ltp => ({
    meta: { status: 'live', clock: '14:00:00', el: 285, open: '09:15', close: '15:30', filter: { sector: 'ALL', side: 'ALL', sort: 'SETUP_SCORE' } },
    sectors: [{ sec: 'CAP GOODS', chg: 1.5, adv: 1, n: 1 }, { sec: 'POWER', chg: -1.8, adv: 0, n: 1 }],
    stocks: [
      { s: 'POWERINDIA', n: 'Hitachi Energy', sec: 'CAP GOODS', g: 'bull', c: 5.2, cp: 5.2, p: 0.99, o: 10000, l: ltp, top: true, fo: true, w: 1.4, bu: 'LONG BUILD-UP', setupScore: 90, flowAgree: 5 },
      { s: 'POWERGRID', n: 'Power Grid', sec: 'POWER', g: 'bear', c: -2.4, cp: -2.4, p: 0.01, o: 300, l: 292.8, top: true, fo: true, w: 1.2, bu: 'SHORT BUILD-UP', setupScore: 80, flowAgree: 5 },
    ],
  });

  api.setM(api.buildModel(makeSnap(10520)));
  api.rerender();

  const card = stage.querySelector('[data-k="POWERINDIA"]');
  assert.ok(card, 'POWERINDIA card must be rendered');
  pointEl = card;
  card.dispatchEvent({ type: 'mousemove', bubbles: true, clientX: 1500, clientY: 220, target: card });

  const inspector = byId.get('inspector');
  assert.equal(stage.classList.contains('brush'), true);
  assert.equal(inspector.classList.contains('on'), true);
  assert.equal(api.getFX().hover.sym, 'POWERINDIA');
  const firstAt = inspector._at;
  const setsBeforeRefresh = gsapSets.length;
  assert.equal(setsBeforeRefresh, 1, 'initial hover animates inspector fade-in once');

  // Simulate background fetch refresh arriving while cursor rests on the card (even behind a toast)
  pointEl = toastEl;
  ctx.OBF_FEED.onUpdate(makeSnap(10585));

  assert.equal(stage.classList.contains('brush'), true, 'fetch/rerender must keep active #stage.brush');
  assert.equal(inspector.classList.contains('on'), true, 'fetch/rerender must keep #inspector open');
  assert.equal(api.getFX().hover.sym, 'POWERINDIA');
  assert.equal(inspector._at[0], firstAt[0], 'inspector position continuity should prevent pop-in flicker');
  assert.equal(gsapSets.length, setsBeforeRefresh, 'fetch/rerender must not re-run firstShow opacity:0 pop-in');
  assert.ok(inspector.innerHTML.includes('10,585') || inspector.innerHTML.includes('10585'), 'inspector updates with refreshed LTP');

  // Calling applyBrush on missing symbol must not throw and must clear brush cleanly
  assert.doesNotThrow(() => api.applyBrush({ kind: 'stock', sym: 'MISSING' }));
  assert.equal(stage.classList.contains('brush'), false);

  // Move pointer to empty stage, re-hover card, then mouseleave -> toggles .brush and #inspector cleanly
  const card2 = stage.querySelector('[data-k="POWERINDIA"]');
  stage.dispatchEvent({ type: 'mousemove', bubbles: true, clientX: 10, clientY: 10, target: stage });
  pointEl = card2;
  card2.dispatchEvent({ type: 'mousemove', bubbles: true, clientX: 1500, clientY: 220, target: card2 });
  assert.equal(stage.classList.contains('brush'), true);
  pointEl = null;
  stage.dispatchEvent({ type: 'mouseleave', bubbles: false, target: stage });
  assert.equal(stage.classList.contains('brush'), false);
  assert.equal(inspector.classList.contains('on'), false);
});

function buildTestJwt(payload) {
  const b64url = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

test('UpstoxClient classifies JWT lifetimes, strips Bearer prefix, and reports expired tokens honestly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstox-jwt-'));
  try {
    const tokenFile = path.join(tmpDir, 'token.json');
    const instFile = path.join(tmpDir, 'instruments.json');
    const nowSec = Math.floor(Date.now() / 1000);

    const dailyExpiredJwt = buildTestJwt({ iat: nowSec - 72000, exp: nowSec - 3600, sub: 'USER1' });
    assert.equal(normalizeBearerToken(`  Bearer  ${dailyExpiredJwt} `), dailyExpiredJwt);
    const claims = decodeJwtClaims(dailyExpiredJwt);
    assert.equal(claims.sub, 'USER1');

    const c1 = new UpstoxClient({
      apiKey: 'test-key-1234',
      apiSecret: 'secret-1234',
      tokenFile,
      instrumentsFile: instFile,
      accessToken: `Bearer ${dailyExpiredJwt}`,
    });
    assert.equal(c1.isTokenExpired(), true);
    assert.equal(c1.isConnected(), false);
    const st1 = c1.getStatus();
    assert.equal(st1.connected, false);
    assert.equal(st1.hasToken, true);
    assert.equal(st1.tokenExpired, true);
    assert.equal(st1.tokenType, 'daily_oauth');

    const dailyValidJwt = buildTestJwt({ iat: nowSec - 1800, exp: nowSec + 14400, sub: 'USER1' });
    c1.updateConfig({ accessToken: dailyValidJwt });
    assert.equal(c1.isTokenExpired(), false);
    assert.equal(c1.isConnected(), true);
    assert.equal(c1.getStatus().tokenType, 'daily_oauth');

    const analyticsJwt = buildTestJwt({
      iat: nowSec,
      exp: nowSec + 365 * 86400,
      sub: 'ANALYTICS1',
    });
    c1.updateConfig({ accessToken: `Bearer ${analyticsJwt}` });
    assert.equal(c1.accessToken, analyticsJwt);
    assert.equal(c1.isConnected(), true);
    const stAnalytics = c1.getStatus();
    assert.equal(stAnalytics.tokenType, 'analytics');
    assert.ok(stAnalytics.expiresInDays >= 364);

    // Non-JWT opaque tokens must still be supported gracefully
    c1.updateConfig({ accessToken: 'opaque-test-token-value' });
    assert.equal(c1.isTokenExpired(), false);
    assert.equal(c1.isConnected(), true);
    assert.equal(c1.getStatus().tokenType, 'manual');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('UpstoxClient verifyAccessToken uses read-only quotes endpoint and apiRequest handles extended_token fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstox-verify-'));
  const origFetch = global.fetch;
  const calls = [];
  try {
    const tokenFile = path.join(tmpDir, 'token.json');
    const instFile = path.join(tmpDir, 'instruments.json');
    const nowSec = Math.floor(Date.now() / 1000);
    const expiredJwt = buildTestJwt({ iat: nowSec - 72000, exp: nowSec - 60 });
    const analyticsJwt = buildTestJwt({ iat: nowSec, exp: nowSec + 365 * 86400 });
    const extendedJwt = buildTestJwt({ iat: nowSec, exp: nowSec + 7 * 86400 });

    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), auth: init.headers?.Authorization || '' });
      if (String(url).includes('/v2/login/authorization/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: expiredJwt,
            extended_token: extendedJwt,
            user_id: 'U1',
            user_name: 'Trader',
          }),
        };
      }
      if (init.headers?.Authorization === `Bearer ${analyticsJwt}`) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
      }
      if (init.headers?.Authorization === `Bearer ${extendedJwt}`) {
        if (String(url).includes('/trigger-block')) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ errors: [{ errorCode: 'UDAPI100067', message: 'Extended token disabled' }] }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: { ok: 1 } }) };
      }
      return {
        ok: false,
        status: 401,
        json: async () => ({ errors: [{ message: 'Invalid token used to access API' }] }),
      };
    };

    const client = new UpstoxClient({
      apiKey: 'api-key-12345',
      apiSecret: 'api-secret-67890',
      redirectUri: 'http://localhost:4600/api/upstox/callback',
      tokenFile,
      instrumentsFile: instFile,
      accessToken: '',
    });

    await assert.rejects(
      () => client.verifyAccessToken(expiredJwt),
      err => err.status === 400 && /expired/i.test(err.message)
    );
    assert.equal(calls.length, 0, 'expired JWT must fail locally before hitting Upstox');

    await assert.rejects(
      () => client.verifyAccessToken('invalid-token-string'),
      err => err.status === 401
    );

    const verified = await client.verifyAccessToken(`Bearer ${analyticsJwt}`);
    assert.equal(verified.ok, true);
    assert.equal(verified.token, analyticsJwt);
    const quoteCall = calls.at(-1);
    assert.ok(quoteCall.url.includes('/v2/market-quote/quotes?instrument_key=NSE_EQ%7CINE002A01018'));
    assert.ok(!quoteCall.url.includes('/v2/user/profile'));

    await client.exchangeCode('auth-code-123');
    assert.equal(client.extendedToken, extendedJwt);

    // Primary expired -> promotes extendedToken on 200
    const resOk = await client.apiRequest('/v2/market-quote/quotes?instrument_key=NSE_EQ%7CINE002A01018');
    assert.equal(resOk.data.ok, 1);
    assert.equal(client.accessToken, extendedJwt);
    assert.equal(client.tokenSource, 'extended');

    // Primary rejected & extended blocked on UDAPI100067 -> sets authFailed cleanly without retry loop
    client.accessToken = expiredJwt;
    client.extendedToken = extendedJwt;
    client.extendedTokenBlocked = false;
    await assert.rejects(() => client.apiRequest('/trigger-block'), err => err.status === 401);
    assert.equal(client.extendedTokenBlocked, true);
    assert.equal(client.authFailed, true);
    assert.equal(client.isConnected(), false);
  } finally {
    global.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/upstox/token verifies and saves 1-Year Analytics Token into isolated env', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstox-server-'));
  const origFetch = global.fetch;
  let server;
  let svc;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const analyticsJwt = buildTestJwt({ iat: nowSec, exp: nowSec + 365 * 86400, sub: 'A1' });
    const envPath = path.join(tmpDir, '.env');

    global.fetch = async (url, init = {}) => {
      const sUrl = String(url);
      if (sUrl.startsWith('http://127.0.0.1:')) return origFetch(url, init);
      if (init.headers?.Authorization === `Bearer ${analyticsJwt}`) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
      }
      return {
        ok: false,
        status: 401,
        json: async () => ({ errors: [{ message: 'Invalid token used to access API' }] }),
      };
    };

    svc = new TredyeFlowService({
      demo: true,
      dryRun: true,
      dbPath: path.join(tmpDir, 'flow.sqlite'),
      envPath,
      upstox: {
        apiKey: 'demo-key-1234',
        apiSecret: 'demo-secret-1234',
        tokenFile: path.join(tmpDir, 'upstox-token.json'),
        instrumentsFile: path.join(tmpDir, 'upstox-instruments.json'),
        accessToken: '',
        extendedToken: '',
      },
    });
    const created = createDashboardServer(svc);
    server = created.server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    const badEmpty = await origFetch(`${base}/api/upstox/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '   ' }),
    });
    assert.equal(badEmpty.status, 400);

    const badToken = await origFetch(`${base}/api/upstox/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bad-token-value-123456' }),
    });
    assert.equal(badToken.status, 401);
    const badJson = await badToken.json();
    assert.equal(badJson.ok, false);

    const goodRes = await origFetch(`${base}/api/upstox/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: `Bearer ${analyticsJwt}` }),
    });
    assert.equal(goodRes.status, 200);
    const goodJson = await goodRes.json();
    assert.equal(goodJson.ok, true);
    assert.equal(goodJson.status.connected, true);
    assert.equal(goodJson.status.tokenType, 'analytics');
    assert.ok(fs.readFileSync(envPath, 'utf8').includes(`UPSTOX_ACCESS_TOKEN=${analyticsJwt}`));

    const settingsHtml = await (await origFetch(`${base}/app/settings`)).text();
    assert.ok(settingsHtml.includes('id="upstoxTokenForm"'));
    assert.ok(settingsHtml.includes('id="upstoxOAuthDetails"'));
  } finally {
    global.fetch = origFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    if (svc?.store) svc.store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('settings.js resets token validation state cleanly after saving 1-Year Analytics Token without triggering red error', async () => {
  const vm = require('node:vm');
  const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'settings', 'settings-controller.js'), 'utf8');

  const elements = new Map();
  const docListeners = new Map();
  const makeClassList = () => {
    const s = new Set();
    return {
      add: (...c) => c.forEach(x => s.add(x)),
      remove: (...c) => c.forEach(x => s.delete(x)),
      toggle: (c, f) => (f === undefined ? (s.has(c) ? (s.delete(c), false) : (s.add(c), true)) : (f ? s.add(c) : s.delete(c), f)),
      contains: c => s.has(c),
    };
  };
  const makeNode = (id, tag = 'div', extras = {}) => {
    const attrs = new Map();
    const listeners = new Map();
    const node = {
      id,
      tagName: tag.toUpperCase(),
      className: '',
      classList: makeClassList(),
      dataset: {},
      textContent: '',
      value: '',
      type: tag === 'input' ? 'password' : '',
      required: tag === 'input',
      minLength: tag === 'input' ? 20 : -1,
      hidden: false,
      disabled: false,
      focused: false,
      interacted: false,
      ...extras,
      focus() {
        this.focused = true;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      matches(sel) {
        if (sel === 'input, select, textarea') return tag === 'input' || tag === 'select' || tag === 'textarea';
        if (sel === ':user-invalid') return Boolean(this.interacted && !this.validity.valid);
        return false;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      async dispatchEvent(ev) {
        ev.target = ev.target || this;
        ev.preventDefault = ev.preventDefault || (() => {});
        for (const fn of listeners.get(ev.type) || []) await fn(ev);
      },
      closest() {
        return null;
      },
      querySelectorAll: () => [],
      querySelector(sel) {
        if (sel === ':invalid' && !this.validity.valid) return this;
        if (sel === ':invalid' && id === 'upstoxTokenForm') {
          const inp = elements.get('upstoxAnalyticsToken');
          return inp && !inp.validity.valid ? inp : null;
        }
        return null;
      },
      checkValidity() {
        if (id === 'upstoxTokenForm') return elements.get('upstoxAnalyticsToken').checkValidity();
        return this.validity.valid;
      },
      get validity() {
        if (tag !== 'input') return { valid: true };
        const val = String(this.value || '');
        const valid = (!this.required || val.length > 0) && (val.length === 0 || val.length >= (this.minLength || 0));
        return { valid };
      },
    };
    if (id) elements.set(id, node);
    return node;
  };

  const section = makeNode('upstoxSection', 'section');
  const badge = makeNode('upstoxStatusBadge', 'span');
  const meta = makeNode('upstoxTokenMeta', 'p');
  const tokenInput = makeNode('upstoxAnalyticsToken', 'input', { minLength: 20, required: true });
  tokenInput.dataset.error = 'upstoxTokenError';
  tokenInput.setAttribute('aria-describedby', 'upstoxTokenHelp');
  const toggleBtn = makeNode('toggleAnalyticsBtn', 'button');
  const reqStar = makeNode('analyticsReqStar', 'span');
  const tokenError = makeNode('upstoxTokenError', 'div');
  const tokenStatus = makeNode('upstoxTokenStatusMsg', 'div');
  const saveBtn = makeNode('upstoxSaveTokenBtn', 'button');
  const disBtn = makeNode('upstoxDisconnectBtn', 'button');
  const tokenForm = makeNode('upstoxTokenForm', 'form');
  tokenForm.reset = () => {
    tokenInput.value = '';
    tokenInput.interacted = false;
  };
  makeNode('upstoxRedirectCode', 'code');
  makeNode('oauthKeysSummaryPill', 'span');
  makeNode('upstoxConnectBtn', 'button');

  let statePayload = { upstox: { configured: true, connected: false, hasToken: false, tokenType: 'none' }, config: {} };
  const fetchCalls = [];
  const ctx = vm.createContext({
    document: {
      body: { append() {} },
      createElement: t => makeNode('', t),
      getElementById: id => elements.get(id) || null,
      querySelectorAll: sel => (sel === 'input, select, textarea' ? [tokenInput] : []),
      addEventListener: (type, fn) => {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
    },
    CSS: { supports: () => true },
    WeakMap, WeakSet, Map, Set, URL, Date, JSON, Number, String, Boolean, Math, Array, Object,
    navigator: {},
    window: {},
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (url === '/api/state') return { ok: true, json: async () => statePayload };
      if (url === '/api/upstox/token') {
        statePayload = {
          upstox: { configured: true, connected: true, hasToken: true, tokenType: 'analytics', expiresInDays: 365 },
          config: {},
        };
        return { ok: true, json: async () => ({ ok: true, status: statePayload.upstox }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  vm.runInContext(scriptSrc, ctx);
  await new Promise(r => setImmediate(r));

  // Toggle Show -> paste valid 1-Year Analytics Token -> submit
  await toggleBtn.dispatchEvent({ type: 'click' });
  assert.equal(tokenInput.type, 'text');
  tokenInput.value = 'valid-analytics-token-over-20-characters-long';
  tokenInput.interacted = true;
  await tokenForm.dispatchEvent({ type: 'submit' });
  await new Promise(r => setImmediate(r));

  assert.equal(tokenInput.value, '');
  assert.equal(tokenInput.required, false);
  assert.equal(reqStar.hidden, true);
  assert.equal(tokenInput.type, 'password');
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(tokenInput.getAttribute('aria-invalid'), 'false');
  assert.equal(tokenInput.getAttribute('aria-describedby'), 'upstoxTokenHelp');
  assert.equal(tokenInput.matches(':user-invalid'), false);
  assert.ok(tokenStatus.className.includes('ok'));

  // Clicking Save 1-Year Token again while input is empty must trigger validation cleanly
  const beforeEmptyCalls = fetchCalls.length;
  await tokenForm.dispatchEvent({ type: 'submit' });
  assert.equal(fetchCalls.length, beforeEmptyCalls);
  assert.equal(tokenInput.required, true);
  assert.equal(tokenInput.getAttribute('aria-invalid'), 'true');
  assert.equal(tokenInput.getAttribute('aria-describedby'), 'upstoxTokenHelp upstoxTokenError');
  assert.equal(tokenInput.focused, true);

  assert.ok(badge && meta && tokenError && saveBtn && disBtn && section);
});

test('orderblock.html skips redundant rerenders, defers non-selected OHLC arrays, uses compositor inspector transforms, and pauses idle FX cleanly', () => {
  const vm = require('node:vm');
  const { getOrderBlockTestScripts } = require('../src/client/orderblock');
  const scripts = getOrderBlockTestScripts();
  assert.equal(scripts.length, 3);
  scripts[2] = scripts[2].replace(
    /\}\)\(\);\s*$/,
    '; window.__OB_PERF_TEST = { setM: m => { M = m; }, getM: () => M, getFX: () => FX, buildModel, renderStage, rerender, obSnapDigest, obControlsMount, showInspector, fxLoop, S }; })();'
  );

  const byId = new Map();
  const c2dProxy = () =>
    new Proxy(
      {
        measureText: () => ({ width: 20 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: new Uint8ClampedArray(16) }),
        font: '',
      },
      { get: (t, k) => (k in t ? t[k] : () => {}) }
    );
  const mk = (tag, id) => {
    const cls = new Set();
    const attrs = new Map();
    const listeners = new Map();
    let htmlStr = '';
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      id: id || '',
      style: { setProperty() {}, getPropertyValue: () => '' },
      dataset: { vfs: '12' },
      children: [],
      parentNode: null,
      offsetWidth: id === 'inspector' ? 330 : 80,
      offsetHeight: id === 'inspector' ? 280 : 20,
      offsetLeft: 0,
      offsetTop: 0,
      offsetParent: null,
      clientWidth: 120,
      scrollWidth: 60,
      isConnected: true,
      classList: {
        add: (...a) => a.forEach(x => cls.add(x)),
        remove: (...a) => a.forEach(x => cls.delete(x)),
        toggle: (x, f) => (f === true ? cls.add(x) : f === false ? cls.delete(x) : cls.has(x) ? (cls.delete(x), false) : (cls.add(x), true)),
        contains: x => cls.has(x),
      },
      set className(v) { cls.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach(x => cls.add(x)); },
      get className() { return [...cls].join(' '); },
      set innerHTML(v) { htmlStr = String(v || ''); if (!htmlStr) this.children = []; },
      get innerHTML() { return htmlStr; },
      setAttribute(k, v) { attrs.set(k, String(v)); if (k.startsWith('data-')) el.dataset[k.slice(5)] = String(v); },
      getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
      hasAttribute: k => attrs.has(k),
      removeAttribute: k => attrs.delete(k),
      addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      dispatchEvent: ev => { ev.target = ev.target || el; (listeners.get(ev.type) || []).forEach(fn => fn(ev)); },
      appendChild(c) { c.parentNode = el; this.children.push(c); if (c.id) byId.set(c.id, c); return c; },
      insertBefore(c) { c.parentNode = el; this.children.unshift(c); if (c.id) byId.set(c.id, c); return c; },
      remove() {},
      closest() { return null; },
      querySelector(sel) {
        if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
        return this.children[0] || mk('div');
      },
      querySelectorAll: sel => (sel === '.obc-pill' ? [] : []),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
      getContext: () => c2dProxy(),
    };
    if (id) byId.set(id, el);
    return el;
  };

  const stage = mk('div', 'stage');
  ['crest', 'plumeWrap', 'chips', 'idxTags', 'ladderWrap', 'nodes', 'tiles', 'bridges', 'tickets', 'fxWrap', 'inspector', 'footer'].forEach(id => stage.appendChild(mk('div', id)));
  const topBar = mk('header', 'obTopBar');
  ['obSecSel', 'obSortSel', 'obSyncBtn', 'obLiveClock', 'obMarketStatus', 'obMarketState', 'obMarketCount'].forEach(id => topBar.appendChild(mk('div', id)));

  const gsapCalls = [];
  const rafQueue = [];
  const winListeners = new Map();
  const ctx = vm.createContext({
    location: { search: '', origin: 'http://localhost:4600' },
    innerWidth: 2100,
    innerHeight: 1200,
    CSS: { escape: s => String(s) },
    gsap: {
      set(el, props) { gsapCalls.push({ kind: 'set', el, props }); },
      to(el, props) { gsapCalls.push({ kind: 'to', el, props }); },
      fromTo() {},
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener() {},
    CanvasRenderingContext2D: Object.assign(function () {}, {
      prototype: { fillStyle: '', strokeStyle: '', globalCompositeOperation: 'source-over', createLinearGradient() {}, createRadialGradient() {} },
    }),
    CanvasGradient: Object.assign(function () {}, { prototype: { addColorStop() {} } }),
    history: { replaceState() {} },
    document: {
      documentElement: mk('html'),
      body: mk('body'),
      hidden: false,
      createElement: t => mk(t),
      getElementById: id => byId.get(id) || mk('div', id),
      querySelector: sel => (sel === '#stage' ? stage : sel.startsWith('#') ? byId.get(sel.slice(1)) || null : null),
      querySelectorAll: () => [],
      addEventListener() {},
      readyState: 'complete',
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { userAgent: 'node' },
    URLSearchParams,
    EventSource: function () { return { addEventListener() {} }; },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
    getComputedStyle: () => ({ fontSize: '12px', getPropertyValue: () => '' }),
    performance: { now: () => 2000 },
    Math, Date, Number, String, Array, Object, Set, Map, Float32Array, Float64Array, Int32Array, JSON, Error, RegExp, console, Promise,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  ctx.window = ctx; ctx.self = ctx;
  for (const sc of scripts) vm.runInContext(sc, ctx);

  const api = ctx.__OB_PERF_TEST;
  const snap1 = {
    meta: { status: 'live', clock: '13:10:00', el: 240, open: '09:15', close: '15:30', counts: { all: 6, bull: 5, bear: 1 }, filter: { sector: 'ALL', side: 'ALL', sort: 'MAX_GAINS' } },
    sectors: [{ sec: 'IT', chg: 1.8, adv: 3, n: 3 }, { sec: 'BANK', chg: 0.4, adv: 1, n: 1 }, { sec: 'ENERGY', chg: 1.2, adv: 1, n: 1 }, { sec: 'POWER', chg: -1.4, adv: 0, n: 1 }],
    stocks: [
      { s: 'INFY', n: 'Infosys', sec: 'IT', g: 'bull', c: 2.8, cp: 2.8, p: 0.96, o: 1800, l: 1850.4, top: true, fo: true, w: 1.2, bu: 'LONG BUILD-UP', setupScore: 88, flowAgree: 5 },
      { s: 'TCS', n: 'TCS', sec: 'IT', g: 'bull', c: 2.4, cp: 2.4, p: 0.92, o: 3900, l: 3993.6, top: true, fo: true, w: 1.1, bu: 'LONG BUILD-UP', setupScore: 84, flowAgree: 5 },
      { s: 'RELIANCE', n: 'Reliance', sec: 'ENERGY', g: 'bull', c: 2.0, cp: 2.0, p: 0.88, o: 2900, l: 2958, top: true, fo: true, w: 1.0, bu: 'LONG BUILD-UP', setupScore: 80, flowAgree: 4 },
      { s: 'WIPRO', n: 'Wipro', sec: 'IT', g: 'bull', c: 1.5, cp: 1.5, p: 0.80, o: 550, l: 558.25, top: true, fo: true, w: 0.9, bu: 'LONG BUILD-UP', setupScore: 74, flowAgree: 4 },
      { s: 'HDFCBANK', n: 'HDFC Bank', sec: 'BANK', g: 'bull', c: 0.4, cp: 0.4, p: 0.55, o: 1700, l: 1706.8, top: false, fo: true, w: 0.8, bu: 'LONG BUILD-UP', setupScore: 50, flowAgree: 3 },
      { s: 'POWERGRID', n: 'Power Grid', sec: 'POWER', g: 'bear', c: -1.4, cp: -1.4, p: 0.12, o: 300, l: 295.8, top: true, fo: true, w: 1.1, bu: 'SHORT BUILD-UP', setupScore: 76, flowAgree: 4 },
    ],
  };

  const m1 = api.buildModel(snap1);
  m1._sig = api.obSnapDigest(snap1);
  api.setM(m1);
  api.renderStage();

  assert.equal(m1.bySym.INFY._hasOhlc, true, 'selected stock prebuilds OHLC arrays');
  assert.equal(m1.bySym.HDFCBANK._hasOhlc, false, 'non-selected stock skips OHLC array allocations upfront');
  assert.equal(m1.bySym.HDFCBANK.O, undefined);
  assert.ok(m1.bySym.HDFCBANK.vwapEnd > 0 && m1.bySym.HDFCBANK.volTot > 0, 'scalar metrics still computed accurately');

  // Hovering a non-selected stock lazily computes OHLC arrays cleanly without throwing
  assert.doesNotThrow(() => api.showInspector(m1.bySym.HDFCBANK, { clientX: 600, clientY: 300 }));
  assert.equal(m1.bySym.HDFCBANK._hasOhlc, true);
  assert.ok(ArrayBuffer.isView(m1.bySym.HDFCBANK.vwap));

  // Verify inspector uses compositor x/y transforms rather than animating left/top
  const firstSet = gsapCalls.find(c => c.kind === 'set');
  assert.ok(firstSet && typeof firstSet.props.x === 'number' && typeof firstSet.props.y === 'number');
  api.showInspector(m1.bySym.INFY, { clientX: 900, clientY: 400 });
  const moveTo = gsapCalls.filter(c => c.kind === 'to').at(-1);
  assert.equal('left' in moveTo.props, false, 'placeInspector must animate x/y transform, not layout left/top');
  assert.equal('top' in moveTo.props, false);

  // Feed identical digest (clock-only tick) -> M reference preserved, no heavy rebuild
  const snapSame = { ...snap1, meta: { ...snap1.meta, clock: '13:11:00' } };
  ctx.OBF_FEED.onUpdate(snapSame);
  assert.equal(api.getM(), m1, 'unchanged snapshot digest must skip full rebuild');

  // Feed changed LTP -> M rebuilt cleanly
  const snapChanged = {
    ...snap1,
    stocks: [{ ...snap1.stocks[0], l: 1862.0 }, ...snap1.stocks.slice(1)],
  };
  ctx.OBF_FEED.onUpdate(snapChanged);
  assert.notEqual(api.getM(), m1, 'changed stock price must trigger model rebuild');

  // Cross-tab storage event from Settings FX toggle -> toggles fx-paused and halts idle fxLoop
  assert.equal(topBar.querySelector('#obMotionBtn'), null, 'main screen top bar must not render Pause/Play FX button');
  (winListeners.get('storage') || []).forEach(fn => fn({ key: 'ob_fx_paused', newValue: '1' }));
  assert.equal(api.getFX().userPaused, true);
  assert.equal(ctx.document.body.classList.contains('fx-paused'), true);
  api.getFX().hover = null;
  api.getFX().pinned = null;
  api.getFX().flashes = [];
  api.getFX().packets = [];
  api.getFX().dirty = false;
  api.fxLoop(2100);
  assert.equal(api.getFX().running, false, 'idle fxLoop must halt cleanly when paused');
});

test('modular architecture, fonts bundle, external CSS/JS bundles, and dark-mode zero-overhead Canvas2D descriptors work cleanly', () => {
  const vm = require('node:vm');
  const { getFontsBundleCss } = require('../src/server/fonts-bundle');
  const {
    DARK_CSS_FILES,
    STAGE_JS_MODULES,
    getOrderBlockCssBundle,
    getOrderBlockLightCss,
    getOrderBlockJsBundle,
    getOrderBlockTestScripts,
  } = require('../src/client/orderblock');

  // 1) HTML shells are lightweight and use external cached bundles + defer scripts
  const obHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'public', 'orderblock.html'), 'utf8');
  assert.ok(Buffer.byteLength(obHtml, 'utf8') < 10_000, 'orderblock.html shell must be under 10 KB');
  assert.ok(obHtml.includes('/vendor/fonts.css'));
  assert.ok(obHtml.includes('/static/ob/orderblock.css'));
  assert.ok(obHtml.includes('<script defer src="/vendor/gsap.min.js"></script>'));
  assert.ok(obHtml.includes('<script defer src="/static/ob/orderblock.js"></script>'));

  // 2) Fonts bundle combines @fontsource rules into a single stylesheet with font-display: swap
  const fontsCss = getFontsBundleCss();
  assert.ok(fontsCss.includes('@font-face'));
  assert.ok(fontsCss.includes('font-display: swap;'));
  assert.ok(fontsCss.includes('/vendor/fonts/inter-tight/files/'));

  // 3) Modular CSS & JS bundles assemble all expected files
  assert.equal(DARK_CSS_FILES.length, 3);
  assert.equal(STAGE_JS_MODULES.length, 6);
  assert.ok(getOrderBlockCssBundle().length > 20_000);
  assert.ok(getOrderBlockLightCss().length > 5_000);
  assert.ok(getOrderBlockJsBundle().length > 100_000);

  // 4) Dark mode preserves native CanvasRenderingContext2D descriptors; light mode hooks and unhooks cleanly
  const [themeScript] = getOrderBlockTestScripts();
  const nativeSetter = function (v) { this._fill = v; };
  const nativeGetter = function () { return this._fill; };
  const proto = {};
  Object.defineProperty(proto, 'fillStyle', {
    configurable: true,
    enumerable: true,
    get: nativeGetter,
    set: nativeSetter,
  });
  Object.defineProperty(proto, 'strokeStyle', {
    configurable: true,
    enumerable: true,
    get: nativeGetter,
    set: nativeSetter,
  });
  Object.defineProperty(proto, 'shadowColor', {
    configurable: true,
    enumerable: true,
    get: nativeGetter,
    set: nativeSetter,
  });
  Object.defineProperty(proto, 'globalCompositeOperation', {
    configurable: true,
    enumerable: true,
    get() { return 'source-over'; },
    set() {},
  });
  proto.createLinearGradient = function () { return {}; };
  proto.createRadialGradient = function () { return {}; };

  let msgHandler = null;
  const ctx = vm.createContext({
    location: { origin: 'http://localhost:4600' },
    document: {
      cookie: 'ob_theme=dark',
      documentElement: { setAttribute() {}, getAttribute: () => 'dark' },
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener(type, fn) { if (type === 'message') msgHandler = fn; },
    dispatchEvent() {},
    Event: function (t) { this.type = t; },
    CanvasRenderingContext2D: { prototype: proto },
    CanvasGradient: { prototype: { addColorStop() {} } },
    Map, Math, Object, Array, String, Number, RegExp, parseInt,
  });
  ctx.window = ctx;
  ctx.window.parent = ctx;
  vm.runInContext(themeScript, ctx);

  // In dark mode, native setter must remain untouched (zero interceptor overhead)
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'fillStyle').set, nativeSetter);

  // Switching to light mode installs the color-remapping setter
  msgHandler({ origin: 'http://localhost:4600', data: { t: 'ob-theme', theme: 'light' } });
  assert.notEqual(Object.getOwnPropertyDescriptor(proto, 'fillStyle').set, nativeSetter);

  // Switching back to dark mode restores the native setter
  msgHandler({ origin: 'http://localhost:4600', data: { t: 'ob-theme', theme: 'dark' } });
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'fillStyle').set, nativeSetter);
});

test('theme defaults to browser preference with no initial cookie and writes ob_theme cookie only on modification', () => {
  const vm = require('node:vm');
  const { getOrderBlockCssBundle, getOrderBlockLightCss, getOrderBlockTestScripts } = require('../src/client/orderblock');
  const navRailSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'public', 'nav-rail.js'), 'utf8');
  const [themeScript] = getOrderBlockTestScripts();

  // 1) CSS checks: Top Bar, Side Rail, Inspector + ichart have Light Mode styling without blocking !important overrides
  const darkCss = getOrderBlockCssBundle();
  const lightCss = getOrderBlockLightCss();
  assert.ok(darkCss.includes(':root[data-theme=light] .ob-side-rail .rt-btn.on'));
  assert.ok(darkCss.includes(':root[data-theme=light] .obc-pills'));
  assert.ok(darkCss.includes(':root[data-theme=light] .obc-group select'));
  assert.ok(darkCss.includes(':root[data-theme=light] #obFindHost #obFind .obf-f'));
  assert.ok(darkCss.includes(':root[data-theme=light] .ob-live-status'));
  assert.ok(!/^\s*#inspector\s*\{[^}]*background:\s*rgba\(10,\s*16,\s*26[^;]*!important/m.test(darkCss));
  assert.ok(lightCss.includes(':root[data-theme=light] #inspector .ichart'));
  assert.ok(lightCss.includes(':root[data-theme=light] #inspector .h .t'));
  assert.ok(lightCss.includes(':root[data-theme=light] #inspector .row.px .lp'));

  // 2) OrderBlock theme module: browser Light preference -> initializes light with NO cookie written
  const makeCookieJar = () => {
    const store = new Map();
    return {
      store,
      get() {
        return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      },
      set(raw) {
        const str = String(raw || '');
        const [pair, ...attrs] = str.split(';').map(s => s.trim());
        const eq = pair.indexOf('=');
        if (eq < 0) return;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        const maxAgeZero = attrs.some(a => /^max-age=0$/i.test(a));
        if (maxAgeZero || !v) store.delete(k);
        else store.set(k, v);
      },
    };
  };

  let sysIsLight = true;
  const mqListeners = [];
  const jar1 = makeCookieJar();
  const meta1 = { content: 'light dark' };
  const attrs1 = new Map();
  const ctx1 = vm.createContext({
    location: { origin: 'http://localhost:4600' },
    document: {
      get cookie() { return jar1.get(); },
      set cookie(v) { jar1.set(v); },
      documentElement: {
        style: {},
        setAttribute: (k, v) => attrs1.set(k, v),
        getAttribute: k => attrs1.get(k) || null,
      },
      querySelector: sel => (sel === 'meta[name="color-scheme"]' ? meta1 : null),
      querySelectorAll: () => [],
    },
    matchMedia: q => ({
      get matches() { return q.includes('light') ? sysIsLight : !sysIsLight; },
      addEventListener: (_t, fn) => mqListeners.push(fn),
    }),
    addEventListener() {},
    dispatchEvent() {},
    Event: function (t) { this.type = t; },
    CanvasRenderingContext2D: { prototype: {} },
    CanvasGradient: { prototype: { addColorStop() {} } },
    Map, Math, Object, Array, String, Number, RegExp, parseInt,
  });
  ctx1.window = ctx1;
  ctx1.window.parent = ctx1;
  vm.runInContext(themeScript, ctx1);

  assert.equal(attrs1.get('data-theme'), 'light');
  assert.equal(jar1.store.has('ob_theme'), false, 'initial load must not write ob_theme cookie');
  assert.equal(meta1.content, 'light dark');

  // OS switches to dark while no cookie override is present -> follows browser automatically
  sysIsLight = false;
  mqListeners.forEach(fn => fn());
  assert.equal(attrs1.get('data-theme'), 'dark');
  assert.equal(jar1.store.has('ob_theme'), false);

  // 3) NavRail module: follows browser light default, cookies only on modification, clears when reverted
  let railLight = true;
  const jar2 = makeCookieJar();
  const meta2 = { content: 'light dark' };
  const attrs2 = new Map();
  const railBtns = [
    {
      dataset: { themeSet: 'light' },
      classes: new Set(),
      attrs: new Map(),
      listeners: new Map(),
      getAttribute: k => (k === 'data-theme-set' ? 'light' : null),
      setAttribute(k, v) { this.attrs.set(k, v); },
      classList: { toggle(c, f) { if (f) railBtns[0].classes.add(c); else railBtns[0].classes.delete(c); } },
      addEventListener(t, fn) { this.listeners.set(t, fn); },
    },
    {
      dataset: { themeSet: 'dark' },
      classes: new Set(),
      attrs: new Map(),
      listeners: new Map(),
      getAttribute: k => (k === 'data-theme-set' ? 'dark' : null),
      setAttribute(k, v) { this.attrs.set(k, v); },
      classList: { toggle(c, f) { if (f) railBtns[1].classes.add(c); else railBtns[1].classes.delete(c); } },
      addEventListener(t, fn) { this.listeners.set(t, fn); },
    },
  ];
  const makeAside = () => ({
    className: '',
    id: '',
    offsetWidth: 54,
    setAttribute() {},
    querySelectorAll: sel => (sel === '.rt-btn' ? railBtns : []),
  });
  let asideEl = null;
  const ctx2 = vm.createContext({
    location: { pathname: '/app/settings' },
    document: {
      readyState: 'complete',
      get cookie() { return jar2.get(); },
      set cookie(v) { jar2.set(v); },
      documentElement: {
        style: { setProperty() {} },
        setAttribute: (k, v) => attrs2.set(k, v),
        getAttribute: k => attrs2.get(k) || null,
      },
      body: {
        firstChild: null,
        classList: { contains: c => c === 'has-ob-rail', toggle() { return false; } },
        insertBefore(el) { asideEl = el; },
      },
      createElement: () => makeAside(),
      getElementById: () => null,
      querySelector: sel => (sel === 'meta[name="color-scheme"]' ? meta2 : null),
      querySelectorAll: sel => (sel === '#obSideRail .rt-btn' ? railBtns : []),
      addEventListener() {},
    },
    localStorage: { removeItem() {} },
    matchMedia: q => ({
      matches: q.includes('light') ? railLight : !railLight,
      addEventListener() {},
    }),
    requestAnimationFrame() {},
  });
  ctx2.window = ctx2;
  vm.runInContext(navRailSrc, ctx2);

  assert.ok(asideEl);
  assert.equal(attrs2.get('data-theme'), 'light', 'Settings defaults to browser light preference');
  assert.equal(jar2.store.has('ob_theme'), false, 'no cookie written before modification');

  // Click Light (already matches browser) -> still no cookie
  railBtns[0].listeners.get('click')();
  assert.equal(jar2.store.has('ob_theme'), false);

  // Click Dark (modified from browser Light default) -> writes ob_theme=dark cookie
  railBtns[1].listeners.get('click')();
  assert.equal(attrs2.get('data-theme'), 'dark');
  assert.equal(jar2.store.get('ob_theme'), 'dark');
  assert.equal(meta2.content, 'dark');

  // Click back to Light (matches browser default again) -> removes override cookie
  railBtns[0].listeners.get('click')();
  assert.equal(attrs2.get('data-theme'), 'light');
  assert.equal(jar2.store.has('ob_theme'), false);
  assert.equal(meta2.content, 'light dark');
});

test('NSE market status countdown and Settings Play/Pause FX controls work accurately', async () => {
  const vm = require('node:vm');
  const { getMarketStatus } = require('../src/market/hours');
  const marketHoursSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'market', 'hours.js'), 'utf8');
  const settingsCtrlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'settings', 'settings-controller.js'), 'utf8');

  // 1) Weekday evening (2026-11-16 19:50:09 IST) -> Closed · opens 13h 25m
  const monEvening = getMarketStatus(new Date('2026-11-16T19:50:09+05:30'));
  assert.equal(monEvening.open, false);
  assert.equal(monEvening.phase, 'AFTER_CLOSE');
  assert.equal(monEvening.shortText, 'Closed · opens 13h 25m');
  assert.equal(monEvening.targetTimeText, 'Tue 09:15 IST');

  // 2) Trading hours (2026-11-17 13:15:00 IST) -> Open · closes 2h 15m
  const tueMidday = getMarketStatus(new Date('2026-11-17T13:15:00+05:30'));
  assert.equal(tueMidday.open, true);
  assert.equal(tueMidday.phase, 'LIVE');
  assert.equal(tueMidday.shortText, 'Open · closes 2h 15m');
  assert.equal(tueMidday.targetTimeText, 'Today 15:30 IST');

  // 3) Final minute before close (2026-11-17 15:29:15 IST) -> Open · closes 45s
  const tueClosing = getMarketStatus(new Date('2026-11-17T15:29:15+05:30'));
  assert.equal(tueClosing.open, true);
  assert.equal(tueClosing.shortText, 'Open · closes 45s');

  // 4) Weekend skip: Friday evening (2026-11-20 16:00:00 IST) -> skips Sat/Sun to Mon 09:15 IST
  const friEvening = getMarketStatus(new Date('2026-11-20T16:00:00+05:30'));
  assert.equal(friEvening.open, false);
  assert.equal(friEvening.shortText, 'Closed · opens 2d 17h 15m');
  assert.equal(friEvening.targetTimeText, 'Mon 09:15 IST');

  // 5) NSE holiday skip: Monday 2026-11-23 16:00:00 IST skips 2026-11-24 (Gurunanak Jayanti) -> Wed 09:15 IST
  const beforeHoliday = getMarketStatus(new Date('2026-11-23T16:00:00+05:30'));
  assert.equal(beforeHoliday.open, false);
  assert.equal(beforeHoliday.targetTimeText, 'Wed 09:15 IST');
  assert.equal(beforeHoliday.shortText, 'Closed · opens 1d 17h 15m');

  // 6) Settings page Play FX / Pause FX controls + Market Status pill
  const storage = new Map([['ob_fx_paused', '0']]);
  const elements = new Map();
  const mkNode = id => {
    const attrs = new Map();
    const listeners = new Map();
    const cls = new Set();
    const node = {
      id,
      className: '',
      textContent: '',
      title: '',
      classList: {
        add: (...a) => a.forEach(x => cls.add(x)),
        remove: (...a) => a.forEach(x => cls.delete(x)),
        toggle: (c, f) => (f === undefined ? (cls.has(c) ? (cls.delete(c), false) : (cls.add(c), true)) : (f ? cls.add(c) : cls.delete(c), f)),
        contains: c => cls.has(c),
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
      addEventListener: (t, fn) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t).push(fn);
      },
      click: async () => {
        for (const fn of listeners.get('click') || []) await fn();
      },
    };
    elements.set(id, node);
    return node;
  };
  const toggleBtn = mkNode('fxToggleBtn');
  const toggleLabel = mkNode('fxToggleLabel');
  const fxBadge = mkNode('fxStatusBadge');
  const fxMsg = mkNode('fxStatusMsg');
  const mktPill = mkNode('settingsMarketPill');

  const RealDate = Date;
  const fixedNow = new RealDate('2026-11-16T19:50:09+05:30');
  const MockDate = function (...a) {
    return a.length ? new RealDate(...a) : new RealDate(fixedNow.getTime());
  };
  MockDate.now = () => fixedNow.getTime();
  MockDate.UTC = RealDate.UTC;

  const ctx = vm.createContext({
    document: {
      body: { append() {} },
      createElement: () => mkNode(''),
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    CSS: { supports: () => true },
    Intl, Date: MockDate, WeakMap, WeakSet, Map, Set, URL, JSON, Number, String, Boolean, Math, Array, Object,
    navigator: {},
    window: { addEventListener() {} },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    setTimeout,
    clearTimeout,
    setInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ upstox: {}, config: {} }) }),
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInContext(marketHoursSrc, ctx);
  vm.runInContext(settingsCtrlSrc, ctx);
  await new Promise(r => setImmediate(r));

  assert.equal(mktPill.textContent, 'NSE Closed · opens 13h 25m');
  assert.equal(toggleBtn.getAttribute('aria-checked'), 'true');
  assert.equal(toggleLabel.textContent, 'Play FX');
  assert.equal(fxBadge.textContent, 'FX Playing');

  // Toggle FX switch button -> pauses FX (ob_fx_paused=1)
  await toggleBtn.click();
  assert.equal(storage.get('ob_fx_paused'), '1');
  assert.equal(toggleBtn.getAttribute('aria-checked'), 'false');
  assert.equal(toggleBtn.classList.contains('is-paused'), true);
  assert.equal(toggleLabel.textContent, 'Pause FX');
  assert.equal(fxBadge.textContent, 'FX Paused');
  assert.ok(fxMsg.textContent.toLowerCase().includes('paused'));

  // Toggle again -> resumes Play FX (ob_fx_paused=0)
  await toggleBtn.click();
  assert.equal(storage.get('ob_fx_paused'), '0');
  assert.equal(toggleBtn.getAttribute('aria-checked'), 'true');
  assert.equal(toggleBtn.classList.contains('is-on'), true);
  assert.equal(toggleLabel.textContent, 'Play FX');
  assert.equal(fxBadge.textContent, 'FX Playing');

  // Main screen HTML/component no longer render obMotionBtn; market pill shares 7px curve with live timer
  const obHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'public', 'orderblock.html'), 'utf8');
  const obTopBarJsx = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OrderBlockTopBar.jsx'), 'utf8');
  const shellCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'client', 'orderblock', 'css', '03-shell-ui.css'), 'utf8');
  assert.equal(obHtml.includes('id="obMotionBtn"'), false);
  assert.equal(obTopBarJsx.includes('id="obMotionBtn"'), false);
  assert.match(shellCss, /\.ob-market-pill\s*\{[^}]*border-radius:\s*7px;/);
});










