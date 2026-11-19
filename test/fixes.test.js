'use strict';

/**
 * Tests for the analytical-integrity fixes:
 *   1. buy_pct is trade-side (aggressor), never the resting-book ratio that duplicates imb
 *   2. neutral bands — ties / missing data no longer count as bearish
 *   3. order-block detection has no lookahead (trailing ATR)
 *   4. strength score is normalized by universe percentiles / the stock's own ATR
 *   5. alert outcome tracking + edge report
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateConfluence, scoreAndRankUniverse, trailingRangePct } = require('../src/engine/flow');
const { detectOrderBlocks } = require('../src/engine/orderblocks');
const { getDirectionalFlowMetrics } = require('../src/engine/orderblock-ranking');
const { AggressorTracker } = require('../src/engine/aggressor');
const { createOutcomeSeed, advanceOutcome, buildEdgeReport } = require('../src/engine/outcomes');
const { FlowStore } = require('../src/store/db');
const { TredyeFlowService } = require('../src/index');
const { createSampleDataset } = require('../data/sample-fixture');

// ---------------------------------------------------------------- Fix 1
test('fix1: AggressorTracker classifies traded volume by prevailing quote, then tick rule', () => {
  const t = new AggressorTracker({ minSamples: 3 });
  const ts = Date.parse('2026-11-19T10:00:00+05:30');
  t.update('X', { ltp: 100, vtt: 1000, bid: 99.95, ask: 100.05, ts }); // seed, nothing classified
  assert.equal(t.get('X').samples, 0);

  t.update('X', { ltp: 100.05, vtt: 1300, bid: 100.0, ask: 100.1, ts });  // at prior ask → BUY 300
  t.update('X', { ltp: 100.0, vtt: 1400, bid: 99.95, ask: 100.05, ts });  // at prior bid → SELL 100
  t.update('X', { ltp: 100.03, vtt: 1500, ts });                          // above prior mid → BUY 100
  const st = t.get('X');
  assert.equal(st.buyVol, 400);
  assert.equal(st.sellVol, 100);
  assert.equal(st.buyPct, 80);
  assert.equal(st.reliable, true);

  // Tick rule when no quote is known
  const u = new AggressorTracker({ minSamples: 1 });
  u.update('Y', { ltp: 50, vtt: 10, ts });
  u.update('Y', { ltp: 49.9, vtt: 30, ts }); // downtick → SELL 20
  u.update('Y', { ltp: 49.9, vtt: 35, ts }); // zero tick → previous direction (SELL)
  assert.equal(u.get('Y').sellVol, 25);
  assert.equal(u.get('Y').buyVol, 0);

  // New session resets
  u.update('Y', { ltp: 49.9, vtt: 5, ts: ts + 86400000 });
  assert.equal(u.get('Y').sellVol, 0);
  assert.equal(u.get('Y').samples, 0);
});

test('fix1: Upstox book ratio never overwrites buy_pct; reliable aggressor % does', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tredye-fix1-'));
  const svc = new TredyeFlowService({ demo: true, dryRun: true, dbPath: path.join(tmp, 'f.db') });
  try {
    svc.state.stocksBySymbol.set('ABC', { symbol: 'ABC', ltp: 100, buy_pct: 58 });
    // Book says 90% bids, aggressor tracker has no data yet → keep Tredye's trade-based 58
    svc.mergeUpstoxTicks({ ABC: { ltp: 101, book_buy_pct: 90, imb: 80, tbq: 9000, tsq: 1000 } });
    const s = svc.state.stocksBySymbol.get('ABC');
    assert.equal(s.buy_pct, 58);
    assert.equal(s.buy_pct_src, 'TREDYE');
    assert.equal(s.book_buy_pct, 90);
    assert.equal(s.imb, 80);

    // Once the tracker is reliable, the aggressor share is used
    const ts = Date.now();
    const tr = svc.upstox.aggressor;
    tr.minSamples = 2;
    tr.update('ABC', { ltp: 100, vtt: 100, bid: 99.9, ask: 100.1, ts });
    tr.update('ABC', { ltp: 99.9, vtt: 400, bid: 99.8, ask: 100.0, ts }); // SELL 300
    tr.update('ABC', { ltp: 100.0, vtt: 500, bid: 99.9, ask: 100.1, ts }); // at prior ask → BUY 100
    svc.mergeUpstoxTicks({ ABC: { ltp: 100, book_buy_pct: 90, imb: 80 } });
    assert.equal(s.buy_pct, 25);
    assert.equal(s.buy_pct_src, 'UPSTOX_AGGRESSOR');

    // buy_pct (25 → bear) and imb (80 → bull) are now independent inputs
    const conf = evaluateConfluence({ ...s, vwap: 100, poc: 100, cvd: 0 });
    assert.equal(conf.checks.find(c => c.key === 'buy_pct').state, 'BEAR');
    assert.equal(conf.checks.find(c => c.key === 'imb').state, 'BULL');
  } finally {
    svc.store.close();
  }
});

test('fix1: Upstox client source has no book-derived buy_pct', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/upstox/client.js'), 'utf8');
  assert.equal(/buy_pct:\s*buyPct/.test(src), false);
  assert.match(src, /book_buy_pct/);
});

// ---------------------------------------------------------------- Fix 2
test('fix2: ties and missing inputs no longer count as bearish', () => {
  const flat = evaluateConfluence({ ltp: 100, vwap: 100, poc: 100, buy_pct: 50, cvd: 0, imb: 0 });
  assert.equal(flat.bull, 0);
  assert.equal(flat.bear, 0);
  assert.equal(flat.neutral, 5);
  assert.equal(flat.side, 'FLAT');
  assert.equal(flat.n, 5);

  // Inside the 0.03% band = neutral; outside = directional
  const nearVwap = evaluateConfluence({ ltp: 100.02, vwap: 100, poc: 99, buy_pct: 60, cvd: 10, imb: 20 });
  assert.equal(nearVwap.checks.find(c => c.key === 'vwap').state, 'NEUTRAL');
  assert.equal(nearVwap.agree, 4);
  assert.equal(nearVwap.n, 5);

  // Missing VWAP/POC: dropped instead of scored BEAR
  const missing = evaluateConfluence({ ltp: 100, buy_pct: 60, cvd: 10, imb: 20 });
  assert.equal(missing.n, 3);
  assert.equal(missing.bear, 0);
  assert.equal(missing.side, 'BULL');
  assert.equal(missing.agree, 3);

  // Neutral checks don't count toward either side in directional metrics
  const m = getDirectionalFlowMetrics({ side: 'FLAT', checks: flat.checks }, false);
  assert.equal(m.agreeInDir, 0);
});

// ---------------------------------------------------------------- Fix 3
test('fix3: order blocks found early in the session do not change as later candles print', () => {
  const sample = createSampleDataset();
  let checked = 0;
  for (const shard of Object.values(sample.shards)) {
    for (const st of shard.stocks) {
      const c = st.candles;
      // a block at index i is confirmed once candles up to i+3 exist
      const early = detectOrderBlocks(c.slice(0, 12), { maxBlocks: 50 }).filter(o => o.i < 9);
      const later = detectOrderBlocks(c, { maxBlocks: 50 }).filter(o => o.i < 9);
      const key = o => `${o.i}|${o.side}|${o.str}`;
      assert.deepEqual(early.map(key).sort(), later.map(key).sort(), st.symbol);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('fix3: a huge later candle no longer suppresses an earlier valid block', () => {
  // 10 quiet candles, a down OB candle, a strong 2-candle impulse, then one enormous candle
  const c = [];
  let t = 1763523900;
  for (let i = 0; i < 10; i++) c.push([t += 180, 100, 100.2, 99.9, 100.1, 1000]);
  c.push([t += 180, 100.1, 100.15, 99.85, 99.9, 1500]);   // OB candle (down)
  c.push([t += 180, 99.9, 100.6, 99.9, 100.55, 3000]);    // impulse
  c.push([t += 180, 100.55, 101.0, 100.5, 100.95, 3000]); // impulse
  const before = detectOrderBlocks(c).filter(o => o.bull);
  assert.equal(before.length, 1);
  for (let i = 0; i < 3; i++) c.push([t += 180, 100.95, 101.05, 100.85, 100.95, 1000]); // drift (outside impulse window)
  c.push([t += 180, 100.95, 109, 100.9, 108, 50000]);     // news spike much later
  for (let i = 0; i < 3; i++) c.push([t += 180, 108, 108.2, 107.9, 108.1, 1000]);
  const after = detectOrderBlocks(c).filter(o => o.i === 10 && o.bull);
  assert.equal(after.length, 1, 'block must survive later volatility');
  assert.equal(after[0].str, before[0].str);
});

// ---------------------------------------------------------------- Fix 4
test('fix4: VWAP points use the stock\'s own volatility, not a fixed 1.25%', () => {
  const base = { poc: 1, buy_pct: 60, cvd: 1000, imb: 20 };
  // Same distance in ATR units (2 × own range), very different raw %
  const calm = { ...base, symbol: 'CALM', ltp: 100.4, vwap: 100 };   // +0.4%, range 0.2%
  // cvd scaled so rupee CVD (cvd × ltp) is identical — isolates the VWAP component
  const wild = { ...base, symbol: 'WILD', ltp: 104, vwap: 100, cvd: (1000 * 100.4) / 104 }; // +4%, range 2%
  const filler = Array.from({ length: 8 }, (_, i) => ({ ...base, symbol: `F${i}`, ltp: 100 + i * 0.1, vwap: 100 }));
  const vol = { CALM: 0.2, WILD: 2 };
  for (let i = 0; i < 8; i++) vol[`F${i}`] = 1;
  const r = scoreAndRankUniverse([calm, wild, ...filler], { volPctBySymbol: vol });
  assert.equal(r.bySymbol.CALM.strengthScore, r.bySymbol.WILD.strengthScore);
});

test('fix4: buy edge scaled by universe P90, with a floor on a dead tape', () => {
  const mk = (sym, bp) => ({ symbol: sym, ltp: 101, vwap: 100, poc: 100, buy_pct: bp, cvd: 100, imb: 10 });
  // Dead tape: every edge tiny → floor of 5 pts stops 52% from earning full credit
  const dead = scoreAndRankUniverse(Array.from({ length: 10 }, (_, i) => mk(`D${i}`, 52)));
  const live = scoreAndRankUniverse([mk('A', 52), ...Array.from({ length: 9 }, (_, i) => mk(`L${i}`, 70))]);
  assert.ok(dead.bySymbol.D0.strengthScore > live.bySymbol.A.strengthScore);
  assert.ok(dead.bySymbol.D0.strengthScore < live.bySymbol.L0.strengthScore);
});

test('fix4: trailingRangePct averages the last N candle ranges as % of close', () => {
  const c = [[0, 0, 101, 99, 100], [0, 0, 102, 100, 100]];
  assert.equal(trailingRangePct(c), 2);
  assert.equal(trailingRangePct([]), null);
});

// ---------------------------------------------------------------- Fix 5
const T0 = Date.parse('2026-11-19T10:00:00+05:30');
const sec = ms => Math.floor(ms / 1000);
const candle = (ms, o, h, l, c) => [sec(ms), o, h, l, c, 1000];

test('fix5: outcome seed validates levels and skips non-directional alerts', () => {
  assert.equal(createOutcomeSeed(1, { side: 'FLAT', ltp: 100 }), null);
  assert.equal(createOutcomeSeed(1, { side: 'BULL', ltp: 0 }), null);
  const seed = createOutcomeSeed(7, {
    symbol: 'X', type: 'IN_ZONE', side: 'BULL', ltp: 100, invalidation: 99, target1: 98, target2: 102, createdAt: T0,
  });
  assert.equal(seed.stop_price, 99);
  assert.equal(seed.t1_price, null, 'T1 below a long entry is meaningless and dropped');
  assert.equal(seed.t2_price, 102);
  assert.equal(seed.session_date, '2026-11-19');
});

test('fix5: long outcome — horizons, MFE/MAE, T1 before stop, finalize at close', () => {
  let row = createOutcomeSeed(1, {
    symbol: 'X', type: 'IN_ZONE', side: 'BULL', ltp: 100, invalidation: 99, target1: 101, target2: 103, createdAt: T0,
  });
  const candles = [
    candle(T0 - 180000, 99, 105, 90, 100),        // BEFORE the alert — must be ignored
    candle(T0, 100, 100.4, 99.6, 100.2),          // 10:00–10:03
    candle(T0 + 180000, 100.2, 101.2, 100.1, 101), // 10:03–10:06 hits T1
    candle(T0 + 360000, 101, 101.1, 98.8, 99),     // 10:06–10:09 hits stop (after T1)
    candle(T0 + 540000, 99, 99.5, 98.5, 99.2),
    candle(T0 + 720000, 99.2, 99.6, 99.0, 99.5),   // closes 10:15
  ];
  row = advanceOutcome(row, { candles, candleMin: 3, nowMs: T0 + 16 * 60000, lateToleranceMs: 0 });
  assert.equal(row.ret_5m, 0.2);    // last candle closed by 10:05 → 100.2
  assert.equal(row.ret_15m, -0.5);  // candle closed 10:15 → 99.5
  assert.equal(row.mfe_pct, 1.2);
  assert.equal(row.mae_pct, 1.5);   // pre-alert low of 90 ignored
  assert.equal(row.first_hit, 'T1');
  assert.equal(row.status, 'TRACKING');

  // Session closes; last candle at 15:27
  const closeCandle = candle(Date.parse('2026-11-19T15:27:00+05:30'), 99.5, 100.6, 99.4, 100.5);
  row = advanceOutcome(row, { candles: [...candles, closeCandle], nowMs: Date.parse('2026-11-19T15:40:00+05:30') });
  assert.equal(row.ret_close, 0.5);
  assert.equal(row.status, 'DONE');
  // once DONE, nothing changes
  assert.deepEqual(advanceOutcome(row, { candles: [], nowMs: Date.now() }), row);
});

test('fix5: short outcome — T1 and stop in the same candle counts STOP first', () => {
  let row = createOutcomeSeed(2, {
    symbol: 'Y', type: 'APPROACHING_OB', side: 'BEAR', ltp: 200, invalidation: 202, target1: 198, createdAt: T0,
  });
  row = advanceOutcome(row, {
    candles: [candle(T0 + 60000, 200, 202.5, 197.5, 199)],
    nowMs: T0 + 5 * 60000,
  });
  assert.equal(row.first_hit, 'STOP');
  assert.equal(row.mfe_pct, 1.25);
  assert.equal(row.mae_pct, 1.25);
});

test('fix5: live LTP fills horizons only when the poll is on time; old sessions finalize honestly', () => {
  let row = createOutcomeSeed(3, { symbol: 'Z', side: 'BULL', ltp: 100, createdAt: T0 });
  row = advanceOutcome(row, { ltp: 100.5, nowMs: T0 + 5 * 60000 + 30000, lateToleranceMs: 60000 });
  assert.equal(row.ret_5m, 0.5);
  row = advanceOutcome(row, { ltp: 101, nowMs: T0 + 40 * 60000, lateToleranceMs: 60000 });
  assert.equal(row.ret_15m, null, 'poll too late and no candles → not guessed');
  // Next day, no candles for that session, last seen at 10:40 → INCOMPLETE, no fake close
  row = advanceOutcome(row, { ltp: 150, nowMs: T0 + 86400000 });
  assert.equal(row.status, 'INCOMPLETE');
  assert.equal(row.ret_close, null);
  assert.equal(row.last_price, 101, 'next-day price must not be recorded');
});

test('fix5: DB round trip, migration of older alerts table, and edge report grouping', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tredye-fix5-'));
  const dbPath = path.join(tmp, 'old.db');
  // Simulate an older DB without sector/source_mode columns
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, type TEXT NOT NULL,
    priority TEXT NOT NULL, side TEXT NOT NULL, action TEXT, title TEXT NOT NULL, message TEXT NOT NULL, ltp REAL,
    chg_pct REAL, agree INTEGER, total_checks INTEGER, strength_score REAL, ob_bot REAL, ob_top REAL, ob_dist_pct REAL,
    ob_str REAL, ob_status TEXT, invalidation REAL, target1 REAL, target2 REAL, reviewed INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL)`);
  old.close();

  const store = new FlowStore(dbPath);
  try {
    const mk = (sym, agree, ret) => {
      const alert = {
        symbol: sym, type: 'IN_ZONE', side: 'BULL', title: 't', message: 'm', ltp: 100, agree, totalChecks: 5,
        strengthScore: 70, obStatus: 'IN_ZONE', invalidation: 99, target1: 101, createdAt: T0, sector: 'BANK', sourceMode: 'LIVE',
      };
      const id = store.insertAlert(alert);
      const seed = createOutcomeSeed(id, alert, 'LIVE');
      store.insertOutcome(seed);
      const done = advanceOutcome(seed, {
        candles: [candle(T0, 100, 100, 100, 100), candle(Date.parse('2026-11-19T15:27:00+05:30'), 100, 100 + ret, 100, 100 + ret)],
        nowMs: Date.parse('2026-11-19T16:00:00+05:30'),
      });
      store.updateOutcome(done);
    };
    mk('A', 5, 1); mk('B', 5, 0.5); mk('C', 4, -0.5);

    assert.equal(store.listTrackingOutcomes().length, 0);
    const rows = store.listOutcomeRows(0);
    assert.equal(rows.length, 3);
    const rep = buildEdgeReport(rows);
    assert.equal(rep.overall.n, 3);
    assert.equal(rep.overall.winRatePct, 66.7);
    const five = rep.byAgree.find(g => g.key === '5/5');
    assert.equal(five.n, 2);
    assert.equal(five.avgRetClose, 0.75);
    assert.equal(rep.bySector[0].key, 'BANK');
    assert.equal(rep.byTimeOfDay[0].key, '2 · Morning 10:00–11:30');
  } finally {
    store.close();
  }
});

test('fix5: service creates outcomes only for live data and exposes /api/edge-report shape', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tredye-fix5svc-'));
  const svc = new TredyeFlowService({ demo: true, dryRun: true, dbPath: path.join(tmp, 's.db') });
  try {
    const alert = { symbol: 'Q', type: 'IN_ZONE', side: 'BULL', title: 't', message: 'm', ltp: 50, createdAt: Date.now() };
    const id = svc.store.insertAlert(alert);
    svc.store.insertOutcome(createOutcomeSeed(id, alert, 'UPSTOX_LIVE'));
    svc.state.sourceMode = 'UPSTOX_LIVE';
    svc.state.stocksBySymbol.set('Q', { symbol: 'Q', ltp: 51 });
    svc.updateAlertOutcomes();
    const rep = svc.getEdgeReport({ days: 7 });
    assert.equal(rep.days, 7);
    assert.equal(rep.recent.length, 1);
    assert.ok(Array.isArray(rep.byAgree));
    assert.ok(rep.recent[0].mfe_pct >= 0);
  } finally {
    svc.store.close();
  }
});
