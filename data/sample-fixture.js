'use strict';

/**
 * Generates a realistic NSE Order Flow + 3-minute shard candles fixture
 * matching Tredye's exact `/api/orderflow` and `/api/orderflow/p{sh}` schemas.
 *
 * Used for:
 *  - Unit tests (`npm test`)
 *  - Dry-run verification (`npm run dry-run`)
 *  - Interactive demo replay in the dashboard when Tredye credentials aren't set yet
 */

function buildBullishOBCandles(basePrice, obBot, obTop, finalLtp, baseTimeSec = 1762403100) {
  // 20 3-minute candles: [t, o, h, l, c, v, delta, cvd]
  // Index 6 will be the last down candle [obTop, obBot] before a strong 2-candle up impulse
  // that breaks the prior 7-candle high and moves > 1.8x average range.
  const step = (obTop - obBot) || basePrice * 0.0025;
  const candles = [];
  let cvd = 10000;

  const pattern = [
    // 0..5: mild consolidation above obBot (up/flat candles so candle 6 is the sole down OB candle)
    [obTop + step * 0.1, obTop + step * 0.5, obTop + step * 0.0, obTop + step * 0.3, 45000, 4200],
    [obTop + step * 0.3, obTop + step * 0.6, obTop + step * 0.2, obTop + step * 0.4, 48000, 5100],
    [obTop + step * 0.4, obTop + step * 0.7, obTop + step * 0.3, obTop + step * 0.5, 41000, 2100],
    [obTop + step * 0.5, obTop + step * 0.8, obTop + step * 0.4, obTop + step * 0.6, 52000, 6300],
    [obTop + step * 0.6, obTop + step * 0.9, obTop + step * 0.5, obTop + step * 0.75, 49000, 3100],
    [obTop + step * 0.75, obTop + step * 1.0, obTop + step * 0.65, obTop + step * 0.85, 47000, 1800],
    // 6: THE BULLISH ORDER BLOCK CANDLE (down candle: close < open, high = obTop, low = obBot)
    [obTop - step * 0.05, obTop, obBot, obBot + step * 0.1, 95000, -8500],
    // 7..8: Strong impulsive breakout candles breaking > obTop + step * 1.15 with move > 2.6 * step
    [obBot + step * 0.15, obTop + step * 1.6, obBot + step * 0.1, obTop + step * 1.5, 165000, 42000],
    [obTop + step * 1.5, obTop + step * 2.9, obTop + step * 1.3, obTop + step * 2.7, 185000, 54000],
    // 9..17: Mild consolidation above obTop leading cleanly to finalLtp without creating a second impulse OB
    [obTop + step * 2.5, obTop + step * 2.8, obTop + step * 2.4, obTop + step * 2.6, 82000, 18000],
    [obTop + step * 2.3, obTop + step * 2.6, obTop + step * 2.2, obTop + step * 2.4, 76000, 12000],
    [obTop + step * 2.0, obTop + step * 2.3, obTop + step * 1.9, obTop + step * 2.1, 68000, 9500],
    [obTop + step * 1.7, obTop + step * 2.0, obTop + step * 1.6, obTop + step * 1.8, 64000, 8200],
    [obTop + step * 1.4, obTop + step * 1.7, obTop + step * 1.3, obTop + step * 1.5, 61000, 7400],
    [obTop + step * 1.1, obTop + step * 1.4, obTop + step * 1.05, obTop + step * 1.2, 59000, 6800],
    [obTop + step * 0.9, obTop + step * 1.2, obTop + step * 0.85, obTop + step * 1.0, 62000, 9100],
    [Math.max(obTop + step * 0.4, finalLtp - step * 0.15), Math.max(obTop + step * 0.6, finalLtp + step * 0.15), Math.min(finalLtp, obTop + step * 0.35), finalLtp, 71000, 14000],
    [
      finalLtp - step * 0.1,
      finalLtp + step * 0.15,
      Math.min(finalLtp - step * 0.1, finalLtp),
      finalLtp,
      98000,
      24000,
    ],
  ];

  pattern.forEach((p, idx) => {
    cvd += p[5];
    candles.push([
      baseTimeSec + idx * 180,
      Number(p[0].toFixed(2)),
      Number(p[1].toFixed(2)),
      Number(p[2].toFixed(2)),
      Number(p[3].toFixed(2)),
      p[4],
      p[5],
      cvd,
    ]);
  });

  return candles;
}

function buildBearishOBCandles(basePrice, obBot, obTop, finalLtp, baseTimeSec = 1762403100) {
  const step = (obTop - obBot) || basePrice * 0.0025;
  const candles = [];
  let cvd = -10000;

  const pattern = [
    // 0..5: consolidation below obBot (down/flat candles so candle 6 is the sole up OB candle)
    [obBot - step * 0.1, obBot - step * 0.0, obBot - step * 0.5, obBot - step * 0.3, 44000, -4100],
    [obBot - step * 0.3, obBot - step * 0.2, obBot - step * 0.6, obBot - step * 0.4, 46000, -5200],
    [obBot - step * 0.4, obBot - step * 0.3, obBot - step * 0.7, obBot - step * 0.5, 42000, -1900],
    [obBot - step * 0.5, obBot - step * 0.4, obBot - step * 0.8, obBot - step * 0.6, 50000, -6100],
    [obBot - step * 0.6, obBot - step * 0.5, obBot - step * 0.9, obBot - step * 0.75, 47000, -3400],
    [obBot - step * 0.75, obBot - step * 0.65, obBot - step * 1.0, obBot - step * 0.85, 45000, -1500],
    // 6: THE BEARISH ORDER BLOCK CANDLE (up candle: close > open, high = obTop, low = obBot)
    [obBot + step * 0.05, obTop, obBot, obTop - step * 0.1, 92000, 8200],
    // 7..8: Strong impulsive breakdown candles breaking < obBot - step * 1.15
    [obTop - step * 0.15, obTop - step * 0.1, obBot - step * 1.6, obBot - step * 1.5, 162000, -41000],
    [obBot - step * 1.5, obBot - step * 1.3, obBot - step * 2.9, obBot - step * 2.7, 180000, -52000],
    // 9..17: Mild consolidation below obBot leading cleanly to finalLtp without creating a second impulse OB
    [obBot - step * 2.5, obBot - step * 2.4, obBot - step * 2.8, obBot - step * 2.6, 80000, -17000],
    [obBot - step * 2.3, obBot - step * 2.2, obBot - step * 2.6, obBot - step * 2.4, 74000, -11000],
    [obBot - step * 2.0, obBot - step * 1.9, obBot - step * 2.3, obBot - step * 2.1, 66000, -9200],
    [obBot - step * 1.7, obBot - step * 1.6, obBot - step * 2.0, obBot - step * 1.8, 62000, -8000],
    [obBot - step * 1.4, obBot - step * 1.3, obBot - step * 1.7, obBot - step * 1.5, 58000, -7100],
    [obBot - step * 1.1, obBot - step * 1.05, obBot - step * 1.4, obBot - step * 1.2, 57000, -6400],
    [obBot - step * 0.9, obBot - step * 0.85, obBot - step * 1.2, obBot - step * 1.0, 60000, -8900],
    [Math.min(obBot - step * 0.4, finalLtp + step * 0.15), Math.max(finalLtp, obBot - step * 0.35), Math.min(obBot - step * 0.6, finalLtp - step * 0.15), finalLtp, 69000, -13500],
    [
      finalLtp + step * 0.1,
      Math.max(finalLtp + step * 0.1, finalLtp),
      finalLtp - step * 0.15,
      finalLtp,
      94000,
      -23000,
    ],
  ];

  pattern.forEach((p, idx) => {
    cvd += p[5];
    candles.push([
      baseTimeSec + idx * 180,
      Number(p[0].toFixed(2)),
      Number(p[1].toFixed(2)),
      Number(p[2].toFixed(2)),
      Number(p[3].toFixed(2)),
      p[4],
      p[5],
      cvd,
    ]);
  });

  return candles;
}

function buildProfile(lo, hi, steps = 14, bullBias = true) {
  const step = Number(((hi - lo) / steps).toFixed(2)) || 1;
  const buy = [];
  const sell = [];
  for (let i = 0; i < steps; i++) {
    const midFactor = 1 - Math.abs(i - steps / 2) / (steps / 2);
    const b = Math.round((40000 + midFactor * 90000) * (bullBias ? 1.35 : 0.75));
    const s = Math.round((40000 + midFactor * 90000) * (bullBias ? 0.75 : 1.35));
    buy.push(b);
    sell.push(s);
  }
  return { lo: Number(lo.toFixed(2)), step, buy, sell };
}

function createSampleDataset() {
  const stocks = [
    {
      symbol: 'RELIANCE',
      name: 'Reliance Industries Ltd',
      sector: 'Energy',
      sh: 0,
      ltp: 2928.4,
      prev: 2884.0,
      chg_pct: 1.54,
      vwap: 2911.2,
      poc: 2908.5,
      val: 2896.0,
      vah: 2934.0,
      buy_pct: 66.4,
      cvd: 485000,
      tv: 4120000,
      imb: 28.5,
      depth: {
        tbq: 382400,
        tsq: 212800,
        imb: 28.5,
        bids: [[2928.2, 4200], [2928.0, 8900], [2927.6, 6400], [2927.2, 5100], [2927.0, 12500]],
        asks: [[2928.6, 2800], [2929.0, 4100], [2929.4, 3900], [2929.8, 5200], [2930.0, 7400]],
      },
      ob: { bull: 2, bear: 0, str: 3.4, near: 0.18 },
      levels: [
        { label: 'S1', price: 2918.0, kind: 's' },
        { label: 'S2', price: 2902.0, kind: 's' },
        { label: 'R1', price: 2948.0, kind: 'r' },
        { label: 'R2', price: 2965.0, kind: 'r' },
        { label: 'VAH', price: 2934.0, kind: 'vah' },
        { label: 'VAL', price: 2896.0, kind: 'val' },
        { label: 'POC', price: 2908.5, kind: 'poc' },
        { label: 'Bid Wall', price: 2920.0, qty: 85000, kind: 'wall_bid' },
      ],
      _obConfig: { bull: true, bot: 2915.0, top: 2923.0 }, // 0.18% away from 2928.4 -> APPROACHING_OB
    },
    {
      symbol: 'ICICIBANK',
      name: 'ICICI Bank Ltd',
      sector: 'Banking',
      sh: 0,
      ltp: 1284.5,
      prev: 1261.2,
      chg_pct: 1.85,
      vwap: 1276.8,
      poc: 1274.0,
      val: 1268.0,
      vah: 1289.0,
      buy_pct: 68.2,
      cvd: 920000,
      tv: 6850000,
      imb: 34.1,
      depth: {
        tbq: 540000,
        tsq: 265000,
        imb: 34.1,
        bids: [[1284.4, 9500], [1284.2, 14200], [1284.0, 22000], [1283.8, 8400], [1283.5, 11000]],
        asks: [[1284.6, 4100], [1284.8, 5300], [1285.0, 9200], [1285.2, 6100], [1285.5, 7800]],
      },
      ob: { bull: 2, bear: 0, str: 3.8, near: 0 },
      levels: [
        { label: 'S1', price: 1278.0, kind: 's' },
        { label: 'S2', price: 1270.0, kind: 's' },
        { label: 'R1', price: 1296.0, kind: 'r' },
        { label: 'R2', price: 1308.0, kind: 'r' },
        { label: 'VAH', price: 1289.0, kind: 'vah' },
        { label: 'VAL', price: 1268.0, kind: 'val' },
        { label: 'POC', price: 1274.0, kind: 'poc' },
        { label: 'Bid Wall', price: 1282.0, qty: 140000, kind: 'wall_bid' },
      ],
      _obConfig: { bull: true, bot: 1281.0, top: 1286.0 }, // LTP 1284.5 is INSIDE [1281, 1286] -> IN_ZONE!
    },
    {
      symbol: 'BHARTIARTL',
      name: 'Bharti Airtel Ltd',
      sector: 'Telecom',
      sh: 0,
      ltp: 1642.0,
      prev: 1614.5,
      chg_pct: 1.70,
      vwap: 1631.4,
      poc: 1629.0,
      val: 1620.0,
      vah: 1646.0,
      buy_pct: 63.8,
      cvd: 540000,
      tv: 3900000,
      imb: 22.4,
      depth: {
        tbq: 290000,
        tsq: 184000,
        imb: 22.4,
        bids: [[1641.8, 3800], [1641.5, 6200], [1641.0, 9400], [1640.5, 4500], [1640.0, 8100]],
        asks: [[1642.2, 2900], [1642.5, 4100], [1643.0, 5600], [1643.5, 3800], [1644.0, 6200]],
      },
      ob: { bull: 1, bear: 0, str: 3.1, near: 0.37 },
      levels: [
        { label: 'S1', price: 1632.0, kind: 's' },
        { label: 'S2', price: 1622.0, kind: 's' },
        { label: 'R1', price: 1655.0, kind: 'r' },
        { label: 'R2', price: 1668.0, kind: 'r' },
        { label: 'VAH', price: 1646.0, kind: 'vah' },
        { label: 'VAL', price: 1620.0, kind: 'val' },
        { label: 'POC', price: 1629.0, kind: 'poc' },
      ],
      _obConfig: { bull: true, bot: 1630.0, top: 1636.0 }, // 0.37% away -> APPROACHING_OB
    },
    {
      symbol: 'LT',
      name: 'Larsen & Toubro Ltd',
      sector: 'Infra',
      sh: 1,
      ltp: 3618.0,
      prev: 3572.0,
      chg_pct: 1.29,
      vwap: 3598.5,
      poc: 3594.0,
      val: 3580.0,
      vah: 3624.0,
      buy_pct: 61.2,
      cvd: 310000,
      tv: 2450000,
      imb: 18.0,
      depth: {
        tbq: 195000,
        tsq: 135000,
        imb: 18.0,
        bids: [[3617.5, 2100], [3617.0, 4800], [3616.5, 3200], [3616.0, 6100], [3615.0, 7500]],
        asks: [[3618.5, 1900], [3619.0, 3400], [3619.5, 2800], [3620.0, 5200], [3621.0, 4900]],
      },
      ob: { bull: 1, bear: 0, str: 2.9, near: 0.72 },
      levels: [
        { label: 'S1', price: 3590.0, kind: 's' },
        { label: 'S2', price: 3575.0, kind: 's' },
        { label: 'R1', price: 3640.0, kind: 'r' },
        { label: 'R2', price: 3665.0, kind: 'r' },
        { label: 'VAH', price: 3624.0, kind: 'vah' },
        { label: 'VAL', price: 3580.0, kind: 'val' },
        { label: 'POC', price: 3594.0, kind: 'poc' },
      ],
      _obConfig: { bull: true, bot: 3582.0, top: 3592.0 },
    },
    {
      symbol: 'SUNPHARMA',
      name: 'Sun Pharmaceutical Industries',
      sector: 'Pharma',
      sh: 1,
      ltp: 1892.0,
      prev: 1871.0,
      chg_pct: 1.12,
      vwap: 1882.5,
      poc: 1880.0,
      val: 1874.0,
      vah: 1896.0,
      buy_pct: 59.4,
      cvd: 265000,
      tv: 2100000,
      imb: 14.5,
      depth: {
        tbq: 162000,
        tsq: 121000,
        imb: 14.5,
        bids: [[1891.8, 2400], [1891.5, 3900], [1891.0, 5100], [1890.5, 3200], [1890.0, 6400]],
        asks: [[1892.2, 2100], [1892.5, 3300], [1893.0, 4200], [1893.5, 2900], [1894.0, 5100]],
      },
      ob: { bull: 1, bear: 0, str: 2.7, near: 0.63 },
      levels: [
        { label: 'S1', price: 1878.0, kind: 's' },
        { label: 'S2', price: 1868.0, kind: 's' },
        { label: 'R1', price: 1906.0, kind: 'r' },
        { label: 'R2', price: 1918.0, kind: 'r' },
        { label: 'VAH', price: 1896.0, kind: 'vah' },
        { label: 'VAL', price: 1874.0, kind: 'val' },
        { label: 'POC', price: 1880.0, kind: 'poc' },
      ],
      _obConfig: { bull: true, bot: 1874.0, top: 1880.0 },
    },
    // BEARISH TOP FLOWS (SELL SETUPS)
    {
      symbol: 'TATAMOTORS',
      name: 'Tata Motors Ltd',
      sector: 'Auto',
      sh: 1,
      ltp: 842.6,
      prev: 861.0,
      chg_pct: -2.14,
      vwap: 849.8,
      poc: 851.5,
      val: 839.0,
      vah: 856.0,
      buy_pct: 31.8,
      cvd: -1150000,
      tv: 8400000,
      imb: -36.4,
      depth: {
        tbq: 245000,
        tsq: 525000,
        imb: -36.4,
        bids: [[842.4, 4100], [842.0, 6200], [841.5, 5100], [841.0, 8300], [840.5, 7200]],
        asks: [[842.8, 11200], [843.0, 18500], [843.5, 14200], [844.0, 24000], [844.5, 16500]],
      },
      ob: { bull: 0, bear: 2, str: 3.9, near: 0 },
      levels: [
        { label: 'S1', price: 834.0, kind: 's' },
        { label: 'S2', price: 825.0, kind: 's' },
        { label: 'R1', price: 848.0, kind: 'r' },
        { label: 'R2', price: 856.0, kind: 'r' },
        { label: 'VAH', price: 856.0, kind: 'vah' },
        { label: 'VAL', price: 839.0, kind: 'val' },
        { label: 'POC', price: 851.5, kind: 'poc' },
        { label: 'Ask Wall', price: 845.0, qty: 195000, kind: 'wall_ask' },
      ],
      _obConfig: { bull: false, bot: 841.5, top: 845.0 }, // LTP 842.6 is INSIDE [841.5, 845.0] -> IN_ZONE SELL!
    },
    {
      symbol: 'INFY',
      name: 'Infosys Ltd',
      sector: 'IT',
      sh: 1,
      ltp: 1764.2,
      prev: 1794.0,
      chg_pct: -1.66,
      vwap: 1776.5,
      poc: 1779.0,
      val: 1760.0,
      vah: 1788.0,
      buy_pct: 34.5,
      cvd: -690000,
      tv: 5200000,
      imb: -29.2,
      depth: {
        tbq: 198000,
        tsq: 362000,
        imb: -29.2,
        bids: [[1764.0, 3200], [1763.5, 4800], [1763.0, 6100], [1762.5, 4400], [1762.0, 7100]],
        asks: [[1764.5, 8400], [1765.0, 12600], [1765.5, 9800], [1766.0, 15400], [1767.0, 11200]],
      },
      ob: { bull: 0, bear: 2, str: 3.5, near: 0.22 },
      levels: [
        { label: 'S1', price: 1750.0, kind: 's' },
        { label: 'S2', price: 1738.0, kind: 's' },
        { label: 'R1', price: 1774.0, kind: 'r' },
        { label: 'R2', price: 1785.0, kind: 'r' },
        { label: 'VAH', price: 1788.0, kind: 'vah' },
        { label: 'VAL', price: 1760.0, kind: 'val' },
        { label: 'POC', price: 1779.0, kind: 'poc' },
        { label: 'Ask Wall', price: 1770.0, qty: 112000, kind: 'wall_ask' },
      ],
      _obConfig: { bull: false, bot: 1768.0, top: 1773.5 }, // 0.22% below Bearish OB -> APPROACHING_OB SELL!
    },
    {
      symbol: 'TCS',
      name: 'Tata Consultancy Services',
      sector: 'IT',
      sh: 1,
      ltp: 4012.0,
      prev: 4068.0,
      chg_pct: -1.38,
      vwap: 4034.0,
      poc: 4038.0,
      val: 4004.0,
      vah: 4055.0,
      buy_pct: 37.2,
      cvd: -320000,
      tv: 2600000,
      imb: -24.0,
      depth: {
        tbq: 118000,
        tsq: 192000,
        imb: -24.0,
        bids: [[4011.5, 1800], [4011.0, 2900], [4010.0, 4200], [4009.0, 3100], [4008.0, 5100]],
        asks: [[4012.5, 4200], [4013.0, 6800], [4014.0, 5900], [4015.0, 8400], [4016.0, 7200]],
      },
      ob: { bull: 0, bear: 1, str: 3.1, near: 0.35 },
      levels: [
        { label: 'S1', price: 3988.0, kind: 's' },
        { label: 'S2', price: 3965.0, kind: 's' },
        { label: 'R1', price: 4032.0, kind: 'r' },
        { label: 'R2', price: 4052.0, kind: 'r' },
        { label: 'VAH', price: 4055.0, kind: 'vah' },
        { label: 'VAL', price: 4004.0, kind: 'val' },
        { label: 'POC', price: 4038.0, kind: 'poc' },
      ],
      _obConfig: { bull: false, bot: 4026.0, top: 4036.0 }, // 0.35% away -> APPROACHING_OB SELL!
    },
    {
      symbol: 'BAJFINANCE',
      name: 'Bajaj Finance Ltd',
      sector: 'Finance',
      sh: 0,
      ltp: 6845.0,
      prev: 6930.0,
      chg_pct: -1.23,
      vwap: 6882.0,
      poc: 6890.0,
      val: 6835.0,
      vah: 6915.0,
      buy_pct: 38.9,
      cvd: -185000,
      tv: 1750000,
      imb: -19.5,
      depth: {
        tbq: 84000,
        tsq: 125000,
        imb: -19.5,
        bids: [[6844.0, 900], [6843.0, 1500], [6842.0, 2100], [6840.0, 3200], [6838.0, 2800]],
        asks: [[6846.0, 2100], [6848.0, 3400], [6850.0, 4200], [6852.0, 2900], [6855.0, 3800]],
      },
      ob: { bull: 0, bear: 1, str: 2.8, near: 0.58 },
      levels: [
        { label: 'S1', price: 6805.0, kind: 's' },
        { label: 'S2', price: 6765.0, kind: 's' },
        { label: 'R1', price: 6890.0, kind: 'r' },
        { label: 'R2', price: 6925.0, kind: 'r' },
        { label: 'VAH', price: 6915.0, kind: 'vah' },
        { label: 'VAL', price: 6835.0, kind: 'val' },
        { label: 'POC', price: 6890.0, kind: 'poc' },
      ],
      _obConfig: { bull: false, bot: 6885.0, top: 6902.0 },
    },
    {
      symbol: 'AXISBANK',
      name: 'Axis Bank Ltd',
      sector: 'Banking',
      sh: 0,
      ltp: 1142.0,
      prev: 1154.0,
      chg_pct: -1.04,
      vwap: 1147.5,
      poc: 1149.0,
      val: 1139.0,
      vah: 1153.0,
      buy_pct: 40.2,
      cvd: -420000,
      tv: 3600000,
      imb: -16.8,
      depth: {
        tbq: 175000,
        tsq: 245000,
        imb: -16.8,
        bids: [[1141.8, 3100], [1141.5, 4800], [1141.0, 6200], [1140.5, 4100], [1140.0, 7500]],
        asks: [[1142.2, 5400], [1142.5, 7900], [1143.0, 9200], [1143.5, 6800], [1144.0, 8400]],
      },
      ob: { bull: 0, bear: 1, str: 2.6, near: 0.61 },
      levels: [
        { label: 'S1', price: 1132.0, kind: 's' },
        { label: 'S2', price: 1122.0, kind: 's' },
        { label: 'R1', price: 1150.0, kind: 'r' },
        { label: 'R2', price: 1158.0, kind: 'r' },
        { label: 'VAH', price: 1153.0, kind: 'vah' },
        { label: 'VAL', price: 1139.0, kind: 'val' },
        { label: 'POC', price: 1149.0, kind: 'poc' },
      ],
      _obConfig: { bull: false, bot: 1149.0, top: 1152.5 },
    },
  ];

  const shards = { 0: { candle_min: 3, stocks: [] }, 1: { candle_min: 3, stocks: [] } };

  for (const s of stocks) {
    const cfg = s._obConfig;
    const candles = cfg.bull
      ? buildBullishOBCandles(s.ltp, cfg.bot, cfg.top, s.ltp)
      : buildBearishOBCandles(s.ltp, cfg.bot, cfg.top, s.ltp);

    const lo = Math.min(...candles.map(c => c[3]));
    const hi = Math.max(...candles.map(c => c[2]));
    const detail = {
      ...s,
      candles,
      profile: buildProfile(lo, hi, 14, cfg.bull),
    };
    delete detail._obConfig;
    shards[s.sh].stocks.push(detail);
  }

  const cleanStocks = stocks.map(s => {
    const copy = { ...s };
    delete copy._obConfig;
    return copy;
  });

  return {
    orderflow: {
      open: true,
      asof: Math.floor(Date.now() / 1000),
      sources: ['NSE real-time feed (sample replay)'],
      stocks: cleanStocks,
    },
    shards,
  };
}

module.exports = {
  createSampleDataset,
  buildBullishOBCandles,
  buildBearishOBCandles,
};
