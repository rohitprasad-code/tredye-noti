'use strict';

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

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
    return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
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
 * Computes flow confluence and strength specifically in the requested direction (`isBull`).
 * Prevents counter-flow stocks (e.g., green price with BEAR flow) from earning opposing flow credit.
 */
function getDirectionalFlowMetrics(c, isBull) {
  const wantSide = isBull ? 'BULL' : 'BEAR';
  const aligned = !c.side || c.side === wantSide;
  const total = Number(c.checks?.length || c.totalChecks || 5);
  let agreeInDir;
  if (Array.isArray(c.checks) && c.checks.length > 0) {
    // Neutral checks count for neither side. Legacy check objects without `state`
    // fall back to the boolean `bull` flag.
    const want = isBull ? 'BULL' : 'BEAR';
    agreeInDir = c.checks.filter(ch =>
      ch.state ? ch.state === want : isBull ? ch.bull : !ch.bull
    ).length;
  } else if (c.side === wantSide) {
    agreeInDir = Number(c.agree || 0);
  } else if (c.side && c.side !== 'FLAT') {
    agreeInDir = Math.max(0, total - Number(c.agree || 0));
  } else {
    agreeInDir = Math.min(total, Number(c.agree || 0));
  }
  const strengthInDir = aligned ? Math.max(0, Math.min(100, Number(c.strengthScore || 0))) : 0;
  return { aligned, agreeInDir, strengthInDir, total };
}

/**
 * Computes a 0–100 Setup Score combining aligned flow strength (60%),
 * directional % momentum (20%), and aligned Order Block proximity/status (20%).
 */
function computeSetupScore(c, isBull) {
  const { strengthInDir } = getDirectionalFlowMetrics(c, isBull);
  const flowPts = strengthInDir * 0.6;
  const absChg = Math.abs(Number(c.chgPct || 0));
  const momPts = Math.min(1, absChg / 5) * 20;

  const alignedOB = isBull
    ? (c.bestBullOB || (c.primaryOB?.bull ? c.primaryOB : null))
    : (c.bestBearOB || (c.primaryOB && !c.primaryOB.bull ? c.primaryOB : null));

  let obPts = 0;
  if (alignedOB && !alignedOB.invalidated && alignedOB.status !== 'MITIGATED') {
    const dist = alignedOB.distPct;
    if (alignedOB.status === 'IN_ZONE' || dist === 0) obPts = 20;
    else if (alignedOB.status === 'RETESTED_HELD') {
      if (dist !== null && dist <= 0.5) obPts = 17;
      else if (dist !== null && dist <= 1.5) obPts = 9;
      else obPts = 4;
    } else if (dist !== null && dist <= 0.5) obPts = 15;
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
  const dirA = getDirectionalFlowMetrics(a, isBull);
  const dirB = getDirectionalFlowMetrics(b, isBull);

  if (sort === 'SETUP_SCORE') {
    return (
      Number(dirB.aligned) - Number(dirA.aligned) ||
      computeSetupScore(b, isBull) - computeSetupScore(a, isBull) ||
      dirB.agreeInDir - dirA.agreeInDir ||
      dirB.strengthInDir - dirA.strengthInDir ||
      flowB - flowA ||
      absChgB - absChgA
    );
  }

  if (sort === 'FLOW_SCORE') {
    return (
      Number(dirB.aligned) - Number(dirA.aligned) ||
      dirB.agreeInDir - dirA.agreeInDir ||
      dirB.strengthInDir - dirA.strengthInDir ||
      flowB - flowA ||
      absChgB - absChgA
    );
  }

  // MAX_GAINS — rank strictly by % move first, then aligned strength and directional flow
  return (
    absChgB - absChgA ||
    Number(dirB.aligned) - Number(dirA.aligned) ||
    dirB.strengthInDir - dirA.strengthInDir ||
    flowB - flowA
  );
}

module.exports = {
  buildOrderBlockRealData,
  getDirectionalFlowMetrics,
  computeSetupScore,
  compareOrderBlockCandidates,
};
