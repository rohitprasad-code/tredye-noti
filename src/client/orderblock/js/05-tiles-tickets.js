/* ================= C: order-block tiles ================= */
const COLDIM = { c4: .74, c3: .82, c2: .90, c1: 1 };
/* per-column look: out-of-OB bar alpha, depth-bed strength, extras */
const TILE_LOOK = {
  c4: { aOut: .60, bed: .050, t0: .15, notch: 1, vwap: 0 },
  c3: { aOut: .62, bed: .055, t0: .15, notch: 1, vwap: 0 },
  c2: { aOut: .66, bed: .060, t0: .17, notch: 1, vwap: 1 },
  c1: { aOut: .78, bed: .085, t0: .21, notch: 1, vwap: 1 }
};
let TILE_MCTX = null;
function tileMeasure(txt, font) { if (!TILE_MCTX) TILE_MCTX = document.createElement('canvas').getContext('2d'); TILE_MCTX.font = font; return TILE_MCTX.measureText(txt).width; }

/* price window: the OB band + LTP are pulled to the vertical middle of the free area (below the label plate);
   untraded levels above/below are filled by resting liquidity (pools + noise). Event tiles keep the day range. */
function tileWindow(s, rows, pitch, headPx) {
  const dayRg = (s.dayH - s.dayL) || s.l * 0.01;
  if (!s.L || s.event) return { hi: s.dayH, lo: s.dayL, ppr: dayRg / rows };
  const bLo = Math.min(s.L.obLo, s.l), bHi = Math.max(s.L.obHi, s.l), bRg = Math.max(bHi - bLo, s.l * 1e-4);
  const topR = clamp(headPx / pitch + 0.6, 0, rows * 0.6);
  const botR = rows - 0.8;
  const free = Math.max(3, botR - topR);
  const nat = bRg / (dayRg / rows);
  const nb = clamp(nat, Math.max(3, free * 0.36), Math.max(3.4, free * 0.52));
  const ppr = bRg / nb;
  const cRow = topR + free * 0.5;
  const hi = (bLo + bHi) / 2 + cRow * ppr;
  return { hi, lo: hi - rows * ppr, ppr };
}
function tileRows(s, w, h, headPx = 0, key = 'c3') {
  const pitch = h >= 30 ? 5 : 3, bar = h >= 30 ? 3 : 2; const rows = Math.max(3, Math.floor((h - 2) / pitch));
  const off = Math.floor((h - rows * pitch) / 2) + (pitch - bar) / 2;
  const win = tileWindow(s, rows, pitch, headPx);
  const hi = win.hi, lo = win.lo, rg = (hi - lo) || 1;
  const rowOf = p => clamp(Math.floor((hi - p) / rg * rows), 0, rows - 1);
  const ltpRow = rowOf(s.l);
  const nz = valueNoise1D(fnv1a(s.s + ':tile'), rows, 2);
  const nz2 = valueNoise1D(fnv1a(s.s + ':rest'), rows, 3);
  const jr = rng(s.s, 'tilejit');
  const vap = s.vap18 ? s.vap18.bins : null;
  const side = s.side;
  const bias = 0.5 + 0.45 * Math.tanh(s.c / 2);
  let obR0 = -1, obR1 = -1, poolC = -1;
  if (s.L && !s.event) { obR0 = rowOf(s.L.obHi); obR1 = rowOf(s.L.obLo); poolC = (obR0 + obR1) / 2; }
  const obSig = Math.max(1.2, (obR1 - obR0 + 1) / 2.4);
  const offerC = side > 0 ? ltpRow - 3 : ltpRow + 3;
  // seeded resting walls outside the OB band
  const walls = []; const wr = rng(s.s, 'walls'); const nW = rows >= 30 ? 3 : rows >= 16 ? 2 : 1;
  for (let i = 0; i < nW; i++) { let c = wr() * rows; if (obR0 >= 0 && c >= obR0 - 2 && c <= obR1 + 2) c = (c + rows * 0.5) % rows; walls.push([c, 0.22 + 0.26 * wr(), 0.7 + 0.8 * wr()]); }
  const dL = s.dayL, dH = s.dayH, dRg = (dH - dL) || 1;
  const L = [];
  for (let k = 0; k < rows; k++) {
    const p = hi - (k + 0.5) / rows * rg;
    let v = 0, inDay = p <= dH && p >= dL;
    if (vap && inDay) { const fb = clamp((p - dL) / dRg * 18 - 0.5, 0, 17); const b0 = Math.floor(fb), b1 = Math.min(17, b0 + 1); v = vap[b0] * (1 - (fb - b0)) + vap[b1] * (fb - b0); }
    // resting (untraded) levels still carry book depth
    const edge = inDay ? 0 : clamp(Math.min(Math.abs(p - dH), Math.abs(p - dL)) / (dRg * 0.25 + 1e-9), 0, 1);
    const rest = inDay ? 0.10 : 0.16 + 0.18 * (1 - edge * 0.5);
    let pools = 0;
    if (poolC >= 0) pools += 0.6 * Math.exp(-((k - poolC) ** 2) / (2 * obSig * obSig));
    pools += 0.3 * Math.exp(-((k - offerC) ** 2) / (2 * 1.5 * 1.5));
    walls.forEach(([c, a, sg]) => { pools += a * Math.exp(-((k - c) ** 2) / (2 * sg * sg)); });
    const n01 = (nz[k] + 1) / 2, n2 = (nz2[k] + 1) / 2;
    const jit = (jr() - 0.5) * 0.22; // row-to-row raggedness of a real book
    L.push(0.25 + 0.75 * clamp(0.50 * v + 0.26 * n01 + 0.12 * n2 + rest + pools + jit, 0, 1));
  }
  // per-tile normalisation: every row visible, the deepest row reaches the full length
  let Lmin = Infinity, Lmax = -Infinity; L.forEach(x => { Lmin = Math.min(Lmin, x); Lmax = Math.max(Lmax, x); });
  const Ln = L.map(x => 0.30 + 0.70 * (x - Lmin) / ((Lmax - Lmin) || 1));
  const sorted = Ln.slice().sort((a, b) => b - a); const nHot = rows >= 12 ? Math.max(1, Math.round(rows * 0.08)) : 0;
  const hotThr = nHot ? sorted[nHot - 1] : 9;
  const R = [];
  let mx = 0;
  for (let k = 0; k < rows; k++) {
    // resting book: bids below price, offers above; the minority side keeps a floor so both sides of the book read
    const bid = Ln[k] * (k > ltpRow ? Math.max(bias, .15) : bias * .55);
    const ask = Ln[k] * (k < ltpRow ? Math.max(1 - bias, .15) : (1 - bias) * .55);
    mx = Math.max(mx, bid + ask);
    R.push({ bid, ask, Ln: Ln[k] });
  }
  // rescale so the longest row reaches ~90% of the width (both sides together)
  const sc = 0.90 * (w - 2) / (mx || 1);
  const or = rng(s.s, 'orders');
  const Lsort = Ln.slice().sort((a, b) => a - b); const L92 = hotThr, Lmn = Lsort[0];
  R.forEach((r, k) => {
    r.bid *= sc; r.ask *= sc;
    if (r.bid + r.ask > w - 4) { const f = (w - 4) / (r.bid + r.ask); r.bid *= f; r.ask *= f; }
    r.hot = r.Ln >= hotThr;
    const t0 = (TILE_LOOK[key] || TILE_LOOK.c3).t0; r.t = r.hot ? 0.80 + 0.20 * (r.Ln - L92) / ((1 - L92) || 1) : t0 + 0.40 * (r.Ln - Lmn) / ((L92 - Lmn) || 1);
    r.inOB = obR0 >= 0 && k >= obR0 && k <= obR1;
    r.y = off + k * pitch;
    // resting orders queued at the level: 1px seams between orders (from the anchored edge)
    const nb = [], na = []; let x = 0; while (x < w) { x += 5 + Math.round(or() * or() * 22); nb.push(x); } x = 0; while (x < w) { x += 5 + Math.round(or() * or() * 22); na.push(x); }
    r.nb = nb; r.na = na;
  });
  const vwRow = s.vwapEnd && s.vwapEnd <= hi && s.vwapEnd >= lo ? rowOf(s.vwapEnd) : -1;
  return { rows, pitch, bar, ltpRow, R, obR0, obR1, bias, rowOf, hi, lo, vwRow };
}
function drawTileCanvas(T, ms, fast) {
  const { ctx } = T; const s = T.s, w = T.w, h = T.h, side = s.side; const D = T.rd;
  if (!ctx || !D) return;
  ctx.clearRect(0, 0, w, h);
  const ev = !!s.event, look = TILE_LOOK[T.key] || TILE_LOOK.c3, pick = !!T.pick;
  const rgb = SC[side], hot = side > 0 ? COL.bullHot : COL.bearHot;
  const grow = k => ms >= 1e8 ? 1 : 1 - Math.pow(1 - clamp((ms - 6 * k) / 220, 0, 1), 3);
  // depth bed: faint Bookmap heat behind every row, so no level reads as dead black
  if (!ev) {
    for (let k = 0; k < D.rows; k++) {
      const r = D.R[k]; const f = grow(k); if (f <= 0) continue;
      const a = (look.bed * (0.35 + 0.65 * r.Ln) + (r.inOB ? 0.035 : 0)) * f;
      ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`; ctx.fillRect(1, r.y - 1, w - 2, D.bar + 2);
    }
  }
  // bars: bid anchored left (bull ramp), ask anchored right (bear ramp)
  for (let k = 0; k < D.rows; k++) {
    const r = D.R[k]; const f = grow(k);
    if (f <= 0) continue;
    const mul = T.mul ? T.mul[k] : 1;
    const a = ev ? .5 : r.inOB ? 1 : look.aOut;
    let cb = RAMP_C[1](r.t), ca = RAMP_C[-1](r.t);
    if (ev) { const g1 = (cb[0] + cb[1] + cb[2]) / 3, g2 = (ca[0] + ca[1] + ca[2]) / 3; cb = mixRgb(cb, [g1, g1, g1], .75); ca = mixRgb(ca, [g2, g2, g2], .75); }
    const bl = Math.max(0, r.bid * f * mul), al = Math.max(0, r.ask * f * mul);
    const glow = !fast && r.hot && !ev && (pick || T.key === 'c2');
    if (glow) { ctx.save(); ctx.shadowBlur = pick ? 7 : 4; ctx.shadowColor = `rgba(${rgb},.85)`; }
    // the minority side of the book is drawn a touch quieter so the dominant flow reads first
    ctx.fillStyle = rgbStr(cb, a * (side > 0 || ev ? 1 : .74)); ctx.fillRect(1, r.y, bl, D.bar);
    ctx.fillStyle = rgbStr(ca, a * (side < 0 || ev ? 1 : .74)); ctx.fillRect(w - 1 - al, r.y, al, D.bar);
    if (glow) ctx.restore();
    if (ev || D.bar < 3) continue;
    // order seams
    if (look.notch) {
      ctx.fillStyle = r.hot ? 'rgba(4,6,10,.38)' : 'rgba(4,6,10,.58)';
      for (let i = 0; i < r.nb.length; i++) { const x = r.nb[i]; if (x > bl - 4) break; ctx.fillRect(1 + x, r.y, 1, D.bar); }
      for (let i = 0; i < r.na.length; i++) { const x = r.na[i]; if (x > al - 4) break; ctx.fillRect(w - 2 - x, r.y, 1, D.bar); }
    }
    // hot tip on the dominant side's leading edge
    if (r.Ln > .5) {
      const dom = side > 0 ? bl : al; if (dom > 6) {
        const tc = side > 0 ? RAMP_C[1](Math.min(1, r.t + .35)) : RAMP_C[-1](Math.min(1, r.t + .35));
        ctx.fillStyle = rgbStr(tc, (r.inOB ? .95 : .7) * (a < 1 ? .9 : 1));
        if (side > 0) ctx.fillRect(1 + dom - 1.5, r.y, 1.5, D.bar); else ctx.fillRect(w - 1 - dom, r.y, 1.5, D.bar);
      }
    }
  }
  if (ev) return;
  // OB zone (SMC box extends right)
  if (D.obR0 >= 0 && ms > 120) {
    const y0 = D.R[D.obR0].y - 1, y1 = D.R[D.obR1].y + D.bar + 1; const x0 = Math.round(0.16 * w);
    if (!T.pick) { ctx.fillStyle = `rgba(${rgb},.13)`; ctx.fillRect(x0, y0, w - x0, y1 - y0); }
    if (T.pick && !fast) { ctx.save(); ctx.shadowBlur = 6; ctx.shadowColor = `rgba(${rgb},.9)`; }
    ctx.fillStyle = `rgba(${rgb},.9)`; ctx.fillRect(x0, side > 0 ? y0 : y1 - 1, w - x0, 1);
    if (T.pick && !fast) ctx.restore();
    ctx.fillStyle = `rgba(${rgb},.35)`; ctx.fillRect(x0, side > 0 ? y1 - 1 : y0, w - x0, 1);
    ctx.fillStyle = rgba(hot, .85); ctx.fillRect(x0, y0, 3, y1 - y0);
    // FVG
    if (h >= 80 && S.tier3) {
      const fk = side > 0 ? D.obR0 - 2 : D.obR1 + 1;
      if (fk >= 0 && fk + 1 < D.rows && (side > 0 ? fk > D.ltpRow : fk + 1 < D.ltpRow)) {
        const fy0 = D.R[fk].y - 1, fy1 = D.R[fk + 1].y + D.bar + 1;
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 4, fy0, w - x0 - 6, fy1 - fy0); ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = x0 - 20; x < w + 20; x += 4) { ctx.moveTo(x, fy1); ctx.lineTo(x + (fy1 - fy0), fy0); } ctx.stroke(); ctx.restore();
      }
    }
  }
  // VWAP (structure = blue), wide tiles only
  if (look.vwap && D.vwRow >= 0 && Math.abs(D.vwRow - D.ltpRow) > 1 && ms > 140) {
    const vy = Math.round(D.R[D.vwRow].y + D.bar / 2) + .5;
    ctx.strokeStyle = 'rgba(111,163,255,.55)'; ctx.setLineDash([1, 2]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(0.16 * w), vy); ctx.lineTo(w - 8, vy); ctx.stroke(); ctx.setLineDash([]);
  }
  // LTP marker: dashed line, notch, boxed price chip
  if (ms > 160) {
    const ly = Math.round(D.R[D.ltpRow].y + D.bar / 2) + .5;
    ctx.strokeStyle = 'rgba(244,247,255,.75)'; ctx.setLineDash([3, 2]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w - 5, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#F4F7FF'; ctx.beginPath(); ctx.moveTo(w, ly - 3.5); ctx.lineTo(w - 5, ly); ctx.lineTo(w, ly + 3.5); ctx.closePath(); ctx.fill();
    if (w >= 130) {
      const txt = inr(s.l); const fs = S.stacked ? 10 : Math.max(9 * S.tx, 9 / (S.s || 1)); ctx.font = `600 ${fs}px ${FONT_NUM}`;
      const cw = T.ltpCw && T.ltpTxt === txt && T.ltpFs === fs ? T.ltpCw : (T.ltpTxt = txt, T.ltpFs = fs, T.ltpCw = Math.ceil(ctx.measureText(txt).width) + 8);
      const ch = Math.round(fs + 4);
      const bx = w - 7 - cw;
      let cy = ly;
      const pb = T.plateBox; // keep the chip clear of the label plate
      if (pb && bx < pb.r + 2 && cy - ch / 2 < pb.b + 2) cy = pb.b + 3 + ch / 2;
      const rb = T.rkBox; // and clear of the rank badge on the right edge
      if (rb && bx + cw > rb.l - 2 && cy - ch / 2 < rb.b + 2 && cy + ch / 2 > rb.t - 2) cy = rb.b + 3 + ch / 2;
      cy = clamp(cy, ch / 2 + 2, h - ch / 2 - 5);
      if (Math.abs(cy - ly) > 3) { ctx.fillStyle = 'rgba(244,247,255,.5)'; ctx.fillRect(w - 6, Math.min(ly, cy), 1, Math.abs(cy - ly)); }
      if (!fast) { ctx.save(); ctx.shadowBlur = 6; ctx.shadowColor = 'rgba(0,0,0,.6)'; }
      ctx.fillStyle = 'rgba(236,242,250,.94)'; roundRect(ctx, bx, Math.round(cy - ch / 2), cw, ch, 2); ctx.fill();
      if (!fast) ctx.restore();
      ctx.fillStyle = '#05070B'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(txt, bx + 4, Math.round(cy - ch / 2) + ch / 2 + .5);
      T.ltpBox = { x0: bx, x1: bx + cw, y0: cy - ch / 2, y1: cy + ch / 2 };  // lets the hover chain step around the chip
    }
  }
  // delta meter (spine-facing edge)
  const dmax = T.dmax || Math.abs(s.delta); const len = (w / 2 - 6) * clamp(Math.abs(s.delta) / dmax, 0.12, 1);
  const dy = side > 0 ? h - 4 : 1; ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(4, dy, w - 8, 3);
  const g = ctx.createLinearGradient(w / 2, 0, w / 2 - side * len, 0); g.addColorStop(0, `rgba(${rgb},.5)`); g.addColorStop(1, `rgba(${rgb},1)`);
  ctx.fillStyle = g; if (side > 0) ctx.fillRect(w / 2 - len, dy, len, 3); else ctx.fillRect(w / 2, dy, len, 3);
  ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(w / 2 - .5, dy - 1, 1, 5);
}

/* ---- label plate ---- */
function tilePlateSpec(T) {
  const w = T.w, pick = !!T.pick, tx = S.tx || 1;
  const tk0 = (pick ? 20 : clamp(w / 7, 11, 18)) * tx;
  const inv = 1 / (S.s || 1);
  const pc0 = Math.max((pick ? 15 : clamp(w / 11, 10, 14)) * tx, 9.5 * inv);
  const micro = Math.max(7.5 * tx, 8.5 * inv);   // build-up / SEC CAP chips: never below ~8.5px real
  const small = T.key === 'c3' || T.key === 'c4';
  const rkFs = small ? Math.max(9 * tx, 8.5 * inv) : Math.max(9.5 * tx, 9 * inv);
  const floor = Math.max(10, 9 / (S.s || 1));
  const mgW = pick ? Math.round(26 * Math.min(tx, 1.2)) : 0;
  const tkAvail = w - 3 - 9 - 3 - (pick ? mgW + 6 : 0);
  return { tk0, pc0, floor, mgW, tkAvail, micro, rkFs };
}
function tickerFit(sym, fs0, avail, floor) {
  const n = sym.length; const w100 = tileMeasure(sym, `600 100px ${FONT_TK}`);
  const W = (fs, ls) => w100 * fs / 100 + ls * fs * n;
  let fs = fs0, ls = 0.01;
  if (W(fs, ls) > avail) ls = -0.01;
  if (W(fs, ls) > avail) fs = Math.max(floor, Math.floor(avail / (w100 / 100 + ls * n) * 4) / 4);
  const sx = W(fs, ls) > avail ? avail / W(fs, ls) : 1;
  return { fs, ls, sx, width: W(fs, ls) * sx };
}
function applyTicker(tk, f) {
  tk.style.fontSize = f.fs + 'px'; tk.style.letterSpacing = f.ls + 'em';
  if (f.sx < 1) { tk.style.transform = `scaleX(${f.sx.toFixed(3)})`; tk.style.transformOrigin = '0 50%'; tk.style.marginRight = (-(1 - f.sx) * f.width / f.sx).toFixed(1) + 'px'; }
  else { tk.style.transform = ''; tk.style.marginRight = ''; }
}
function buildTile(M, T, parent, mode, defer) {
  const s = T.s, side = s.side; const pick = !!T.pick; const ev = !!s.event;
  const d = el('div', `tile ${T.key}${pick ? ' pk' : ''}${ev ? ' ev' : ''} ${side > 0 ? 'bu' : 'be'}`, parent);
  d.dataset.k = s.s; if (!s._anchor) d.title = `${s.s} · Click to copy code · ⌘+Click to open Upstox`;
  d.style.setProperty('--sc', ev ? '255,176,32' : SC[side]); d.style.setProperty('--hi', ev ? '255,176,32' : SCHI[side]);
  if (mode !== 'stack') css(d, { left: T.x, top: T.y, width: T.w, height: T.h });
  else css(d, { position: 'relative', width: '100%', height: T.h });
  const strength = Math.abs(2 * s.p - 1);
  d.style.setProperty('--ba', ev ? .5 : (0.25 + 0.35 * clamp((strength - .8) / .2, 0, 1)).toFixed(2));
  T.el = d; T.pick = pick; T.mode = mode;
  const w = T.w, h = T.h;
  const { cv, ctx } = localCanvas(d, w, h, (mode === 'stack' ? 1 : S.s) * S.dpr, '');
  T.cv = cv; T.ctx = ctx;
  if (!ev) cv.style.opacity = mode === 'stack' ? 1 : (COLDIM[T.key] || 1);
  T.dmax = Math.max(...M.selected.filter(x => !x.event).map(x => Math.abs(x.delta)));
  if (ev) {
    el('div', 'haz', d);
    const tx = el('div', 'evtxt', d); tx.innerHTML = `<b>${s.s}</b><span>${pctStr(s.c)}</span>`;
    el('div', 'rk', d, '⊘');
    el('div', 'bd', d);
    fitEventTile(T);
    T.rd = tileRows(s, w, h, 0, T.key); tileArrays(T);
    drawTileCanvas(T, 1e9);
    return d;
  }
  el('div', 'bd', d);
  // plate
  const pl = el('div', 'plate', d); T.plate = pl;
  const sp = tilePlateSpec(T); T.sp = sp;
  const tkr = `<div class="tkr">${s.s}</div>`;
  const pc = `<div class="pc" style="font-size:${sp.pc0.toFixed(2)}px">${pctStr(s.c)}</div>`;
  if (pick) pl.innerHTML = `<div class="row1"><div class="mg" style="width:${sp.mgW}px;height:${sp.mgW}px;font-size:${(sp.mgW / 2).toFixed(1)}px;background:linear-gradient(135deg,rgba(${SC[side]},.34),rgba(10,15,23,.92) 85%);border:1px solid rgba(${SC[side]},.5)">${monogram(s)}</div><div class="tw">${tkr}${pc}</div></div>`;
  else pl.innerHTML = tkr + pc;
  if (T.key === 'c1' || T.key === 'c2') {
    const sub = el('div', 'sub', pl);
    const bu = el('span', 'buc', sub, s.bu);
    // chip must sit inside the plate: condense, then shrink to ~8px real, else hide it (never the ticker)
    let ls = 0.08; const avail = T.w - 3 - 9 - 3, cw = fs => tileMeasure(s.bu, `700 ${fs}px ${FONT_UI}`) + ls * fs * s.bu.length + 8;
    let bfs = sp.micro; if (cw(bfs) > avail) ls = 0.03;
    if (cw(bfs) > avail) bfs = Math.max(8 / (S.s || 1), Math.floor((avail - 8) / (tileMeasure(s.bu, `700 100px ${FONT_UI}`) / 100 + ls * s.bu.length) * 4) / 4);
    bu.style.fontSize = bfs.toFixed(2) + 'px'; bu.style.letterSpacing = ls + 'em'; if (cw(bfs) > avail + .5) bu.style.display = 'none';
    if (pick) { const pp = el('span', 'pips', sub); pp.innerHTML = s.pips.map(x => `<i class="${x ? 'on' : ''}"></i>`).join(''); }
  }
  if (s.secCap) { const sub2 = pl.querySelector('.sub') || el('div', 'sub', pl); el('span', 'seccap', sub2, 'SEC CAP').style.fontSize = sp.micro.toFixed(2) + 'px'; }
  T.tkEl = pl.querySelector('.tkr'); T.pcEl = pl.querySelector('.pc');
  T.tkFit = tickerFit(s.s, sp.tk0, sp.tkAvail, sp.floor); applyTicker(T.tkEl, T.tkFit);
  const rk = el('div', 'rk', d, String(s.rank).padStart(2, '0')); T.rkEl = rk;
  rk.style.fontSize = sp.rkFs.toFixed(2) + 'px';
  ['tl', 'tr', 'bl', 'brr'].forEach(c => el('div', 'br ' + c, d));
  if (pick) {
    el('div', 'latch', d);
    if (mode !== 'stack') { const ret = el('div', 'ret', parent, '<i></i><i></i><i></i><i></i>'); css(ret, { left: T.x - 5, top: T.y - 5, width: T.w + 10, height: T.h + 10 }); T.ret = ret; }
  }
  if (!defer) { readTilePlate(T); finishTile(T); }
  return d;
}
function tileArrays(T) {
  const n = T.rd.rows;
  T.mul = new Float32Array(n).fill(1); T.mulT = new Float32Array(n).fill(1); T.mul0 = new Float32Array(n).fill(1); T.tw = new Float32Array(n).fill(-1);
}
/* read the plate geometry (tile-local px). Batched by buildTiles so the stage lays out once. */
function tileOffset(e, root) { let x = 0, y = 0; while (e && e !== root) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; } return { x, y }; }
function readTilePlate(T) {
  const pl = T.plate; if (!pl) return;
  // hide the sub-line (build-up / pips) before the plate may crowd the ladder
  const sub = pl.querySelector('.sub');
  if (sub) {
    const tall = () => pl.offsetTop + pl.offsetHeight > T.h * 0.62;
    const hide = sel => { const e = sub.querySelector(sel); if (e && e.style.display !== 'none' && tall()) e.style.display = 'none'; };
    hide('.pips'); hide('.buc');
    if (!sub.querySelector('.seccap') && tall()) sub.style.display = 'none';
  }
  let b = pl.offsetTop + pl.offsetHeight, r = pl.offsetLeft + pl.offsetWidth;
  if (!pl.offsetHeight) { b = 6 + (T.tkFit ? T.tkFit.fs : 14) + T.sp.pc0 * 1.1 + (T.key === 'c1' || T.key === 'c2' ? 16 : 0); r = T.w * .7; }
  T.plateBox = { b, r };
  const pc = T.pcEl;
  if (pc && pc.offsetHeight) { const o = tileOffset(pc, T.el); T.pcMid = o.y + pc.offsetHeight / 2; T.pcLeft = o.x; T.pcW = pc.offsetWidth; }
  else { T.pcMid = null; }
  T.tkOffset = T.tkFit && T.tkEl ? tileOffset(T.tkEl, T.el) : null;
  T.rkW = T.rkEl && T.rkEl.offsetWidth || 20; T.rkH = T.rkEl && T.rkEl.offsetHeight || 13;
}
function finishTile(T) {
  const s = T.s, w = T.w, h = T.h, d = T.el;
  // rank badge: right edge, vertically centred on the % line (keeps the ticker row full width)
  if (T.rkEl && T.pcMid != null) {
    const rt = Math.round(T.pcMid - T.rkH / 2); T.rkEl.style.top = rt + 'px';
    T.rkBox = { l: w - 4 - T.rkW, t: rt, b: rt + T.rkH };
    // % must never run under the badge
    const room = w - 4 - T.rkW - 6 - T.pcLeft;
    if (T.pcW > room && T.pcEl) {
      const fs0 = parseFloat(T.pcEl.style.fontSize), fl = T.mode === 'stack' ? 10 : 9.5 / (S.s || 1);
      const fs = Math.max(Math.min(fs0, fl), fs0 * room / T.pcW); T.pcEl.style.fontSize = fs.toFixed(2) + 'px';
      // still no room at the floor: lift the badge to the ticker row's right end
      const tko = T.tkOffset;
      if (fs0 * room / T.pcW < fl && tko && tko.x + T.tkFit.width < w - 4 - T.rkW - 4) { const tkTop = tko.y; T.rkEl.style.top = Math.round(tkTop + (T.tkFit.fs - T.rkH) / 2) + 'px'; T.rkBox = { l: w - 4 - T.rkW, t: parseFloat(T.rkEl.style.top), b: parseFloat(T.rkEl.style.top) + T.rkH }; }
    }
  }
  T.rd = tileRows(s, w, h, T.plateBox ? T.plateBox.b + 2 : 0, T.key); tileArrays(T);
  // OB pulse overlay for picks
  const old = d.querySelector('.obpulse'); if (old) old.remove();
  if (T.pick && T.rd.obR0 >= 0) {
    const y0 = T.rd.R[T.rd.obR0].y - 1, y1 = T.rd.R[T.rd.obR1].y + T.rd.bar + 1, x0 = Math.round(0.16 * w);
    const ob = el('div', 'obpulse'); d.insertBefore(ob, T.plate); css(ob, { left: x0, top: y0, height: y1 - y0 }); ob.style.right = '0';
  }
  drawTileCanvas(T, 1e9);
}
function fitEventTile(T) {
  const d = T.el; const b = d.querySelector('.evtxt b'), sp = d.querySelector('.evtxt span'); if (!b || !sp) return;
  const tx = S.tx || 1, floor = S.stacked ? 10 : Math.max(9.5, 9 / (S.s || 1));
  let f1 = 15 * tx, f2 = 12 * tx;
  const avail = T.w - 8 - 26 - 8 - 10 - 10; // left pad, ⊘ badge, gap, two chip paddings
  const w1 = tileMeasure(T.s.s, `700 100px ${FONT_TK}`) / 100 * 1.03, w2 = tileMeasure(pctStr(T.s.c), `700 100px ${FONT_NUM}`) / 100;
  const need = f1 * w1 + f2 * w2; if (need > avail) { const k = avail / need; f1 = Math.max(floor, f1 * k); f2 = Math.max(floor, f2 * k); }
  b.style.fontSize = f1.toFixed(2) + 'px'; sp.style.fontSize = f2.toFixed(2) + 'px';
}
function fitTilePlate(T) {
  const d = T.el; if (!d) return;
  if (T.s.event) { fitEventTile(T); return; }
  if (!T.tkEl) return;
  // re-fit (fonts may have arrived / container may have resized) and re-lay the ladder under the plate
  const sp = tilePlateSpec(T); T.sp = sp; T.tkFit = tickerFit(T.s.s, sp.tk0, sp.tkAvail, sp.floor); applyTicker(T.tkEl, T.tkFit);
  readTilePlate(T); finishTile(T);
}
function buildTiles(M, G, root) {
  root.innerHTML = '';
  G.tiles.forEach(T => buildTile(M, T, root, 'stage', true));
  // one ticker size per column (the longest symbol sets it) so every column reads as one typeset table
  const byCol = {}; G.tiles.forEach(T => { if (T.tkFit) (byCol[T.key] = byCol[T.key] || []).push(T); });
  Object.values(byCol).forEach(list => {
    const fs = Math.min(...list.map(T => T.tkFit.fs));
    list.forEach(T => { T.tkFit = tickerFit(T.s.s, fs, T.sp.tkAvail, T.sp.floor); applyTicker(T.tkEl, T.tkFit); });
  });
  G.tiles.forEach(T => { if (T.plate) readTilePlate(T); });
  G.tiles.forEach(T => { if (T.plate) finishTile(T); });
}

/* ================= D: trade tickets (the prize) =================
   Every level and price printed here is exact model output (§3.6). The 5-minute candles are derived in this module
   from the model's 1-minute path plus a deterministic, per-symbol micro-structure: consolidation, the order-block
   base candle (range == the OB zone exactly), a displacement that leaves a fair-value gap, and a pullback that wicks
   into the block and is rejected, closing exactly on the LTP. */
const C5N = 75;                               // 09:15 -> 15:30 in 5-minute candles
const TK_PITCH = 3.7;                         // design px per candle (3px body + gap)
const TKF = { val: 11, lab: 8, hard: 9.4 };   // real-px floors: decision values, labels, last resort

function computeStockOhlc(s, needArrays) {
  const P = s.P; if (!P) return;
  const r = rng(s.s, 'ohlc');
  let sd = 0; for (let t = 1; t <= NT; t++) sd += (P[t] - P[t - 1]) ** 2; sd = Math.sqrt(sd / NT) || s.l * 0.0005;
  let sp = 0; for (let t = 1; t <= NT; t++) sp += (s.pct[t] - s.pct[t - 1]) ** 2; sp = Math.sqrt(sp / NT) || 0.01;
  let dayH = -1e18, dayL = 1e18, pv = 0, vv = 0;
  const O = needArrays ? new Float64Array(NT + 1) : null;
  const H = needArrays ? new Float64Array(NT + 1) : null;
  const Lo = needArrays ? new Float64Array(NT + 1) : null;
  const C = needArrays ? new Float64Array(NT + 1) : null;
  const V = needArrays ? new Float64Array(NT + 1) : null;
  const vwap = needArrays ? new Float64Array(NT + 1) : null;
  const inOB = t => s.L && t > 15 * s.kOB && t <= 15 * s.kOB + 15;
  for (let t = 1; t <= NT; t++) {
    const o = P[t - 1], c = P[t];
    let h = Math.max(o, c) + Math.abs(gauss(r)) * 0.25 * sd, l = Math.min(o, c) - Math.abs(gauss(r)) * 0.25 * sd;
    if (inOB(t)) { h = Math.min(h, s.L.obHi); l = Math.max(l, s.L.obLo); }
    const u = t / NT; const U = 1.8 - 3.2 * u + 3.0 * u * u;
    const v = s.w * U * (1 + 3 * Math.abs(s.pct[t] - s.pct[t - 1]) / sp) * (0.8 + 0.4 * r());
    pv += (h + l + c) / 3 * v; vv += v;
    dayH = Math.max(dayH, h); dayL = Math.min(dayL, l);
    if (needArrays) { O[t] = o; H[t] = h; Lo[t] = l; C[t] = c; V[t] = v; vwap[t] = pv / vv; }
  }
  if (needArrays) {
    vwap[0] = P[0];
    s.O = O; s.H = H; s.Lo = Lo; s.C = C; s.V = V; s.vwap = vwap;
    s._hasOhlc = true;
  } else {
    s._hasOhlc = false;
  }
  s.dayH = dayH; s.dayL = dayL;
  s.vwapEnd = pv / (vv || 1); s.volTot = vv;
  if (s.x && typeof obRealTape === 'function') obRealTape(s);
  s.vwapHold = s.side > 0 ? s.l > s.vwapEnd : s.l < s.vwapEnd;
}
function ensureStockOhlc(s) {
  if (!s || s._hasOhlc || s.x) return;
  computeStockOhlc(s, true);
}
function candles5(s) {
  if (s._c5) return s._c5;
  if (s.x && s.x.k) return (s._c5 = obCandles(s));
  ensureStockOhlc(s);
  const L = s.L, side = s.side, A = s.ATR, N = C5N, r = rng(s.s, 'c5');
  const zl = L.obLo, zh = L.obHi, zr = zh - zl;
  // side units: 0 = far edge of the block, 1 = near edge, larger = further in the trade direction
  const V = p => side > 0 ? (p - zl) / zr : (zh - p) / zr;
  const U = v => side > 0 ? zl + v * zr : zh - v * zr;
  const kB = 3 * s.kOB + 2;                                   // OB base: last opposite candle before the displacement
  const kub = clamp(Math.floor(s.ub * NT / 5), 4, kB - 14);   // morning breakout candle
  const vL = V(s.l);
  const c = new Float64Array(N), o = new Float64Array(N), hv = new Float64Array(N), lv = new Float64Array(N);
  for (let k = 0; k < N; k++) c[k] = V(s.C[5 * k + 5]);
  // micro-structure: a momentum random walk (swings, runs, pullbacks), bridged back onto the model path at the
  // segment ends so the day's structure and every anchor stay exact; plus a little candle-to-candle chop
  const sg = 0.078 * A / zr, e = new Float64Array(N); let m = 0;
  for (let k = 0; k < N; k++) { m = 0.28 * m + gauss(r) * sg; e[k] = m; }
  const bridgeSeg = (a, b, amp) => { if (b - a < 3) return; let w = 0; const W = []; for (let k = a; k <= b; k++) { w += e[k]; W.push(w); } for (let k = a; k <= b; k++) { const f = (k - a) / (b - a); c[k] += amp(k) * (W[k - a] - (f * W[b - a])); } };
  const soft = k => (k === kub || k === kub + 1) ? .45 : 1;
  bridgeSeg(0, kB - 3, soft); bridgeSeg(kB + 3, N - 1, k => k <= kB + 5 ? .5 : 1);
  for (let k = 1; k < N - 1; k++) if (k < kB - 3 || k > kB + 3) c[k] += gauss(r) * 0.03 * A / zr;
  // base: tight consolidation inside the zone, then the OB candle spanning it exactly
  c[kB - 3] = clamp(c[kB - 3], 0.62, 1.3);
  c[kB - 2] = 0.58 + 0.14 * r(); c[kB - 1] = 0.76 + 0.08 * r(); c[kB] = 0.22 + 0.08 * r();
  // displacement away from the block (leaves a fair-value gap above it)
  c[kB + 1] = 1.30 + 0.08 * r(); c[kB + 2] = 1.70 + 0.08 * r();
  c[kB + 3] = Math.max(c[kB + 3], 1.92 + 0.06 * r()); c[kB + 4] = Math.max(c[kB + 4], 2.02 + 0.08 * r());
  // retest: the pullback wicks into the top of the block and is rejected; close == LTP
  const kd = N - 1 - (2 + Math.floor(r() * 3));
  const ka = Math.max(kB + 5, kd - 4), vd = 1.38 + 0.1 * r();
  for (let k = kB + 3; k < ka; k++) c[k] = Math.max(c[k], 1.55 + 0.1 * r());
  for (let k = ka + 1; k <= kd; k++) c[k] = lerp(c[ka], vd, (k - ka) / (kd - ka)) + (k < kd ? (r() - .5) * .1 : 0);
  for (let k = kd + 1; k < N; k++) c[k] = Math.max(1.32, lerp(vd, vL, (k - kd) / (N - 1 - kd)) + (k < N - 1 ? (r() - .5) * .08 : 0));
  c[N - 1] = vL;
  o[0] = V(s.O[1]); for (let k = 1; k < N; k++) o[k] = c[k - 1];
  const sw = 0.06 * A / zr;
  for (let k = 0; k < N; k++) {
    const b = Math.abs(c[k] - o[k]);
    let up = Math.abs(gauss(r)) * sw * (0.45 + r()) + b * 0.18 * r(), dn = Math.abs(gauss(r)) * sw * (0.45 + r()) + b * 0.18 * r();
    if (r() < .08) up *= 2.4; if (r() < .08) dn *= 2.4;
    hv[k] = Math.max(o[k], c[k]) + up; lv[k] = Math.min(o[k], c[k]) - dn;
  }
  for (let k = Math.max(0, kB - 6); k < kB; k++) lv[k] = Math.max(lv[k], 0.05 + 0.05 * r());   // the block low is the sweep
  hv[kB - 2] = Math.min(hv[kB - 2], 0.96); hv[kB - 1] = Math.min(hv[kB - 1], 0.99);
  hv[kB] = 1; lv[kB] = 0;
  lv[kB + 1] = clamp(lv[kB + 1], 0.08, o[kB + 1]);
  lv[kB + 2] = clamp(lv[kB + 2], 1.13 + 0.05 * r(), Math.min(o[kB + 2], c[kB + 2]));      // fair-value gap = [1, lv(kB+2)]
  for (let k = kB + 3; k < N; k++) if (k !== kd) lv[k] = Math.max(lv[k], k < kd ? 1.24 : 1.2);
  lv[kd] = 0.9 + 0.07 * r();                                                                // tags the block
  const out = { o: [], h: [], l: [], c: [], vol: [], kB, kub, kd, kO: -1 };
  for (let k = 0; k < N; k++) {
    out.o.push(U(o[k])); out.c.push(U(c[k]));
    if (side > 0) { out.h.push(U(hv[k])); out.l.push(U(lv[k])); } else { out.h.push(U(lv[k])); out.l.push(U(hv[k])); }
    let v = 0; for (let t = 5 * k + 1; t <= 5 * k + 5; t++) v += s.V[t];
    out.vol.push(v * (1 + 2.2 * Math.abs(c[k] - o[k]) * zr / A));
  }
  out.c[N - 1] = s.l; out.h[kB] = zh; out.l[kB] = zl;
  out.fvg = [U(1), U(lv[kB + 2])].sort((a, b) => a - b);
  for (let k = kub; k >= Math.max(0, kub - 8); k--) if (c[k] < o[k]) { out.kO = k; break; }
  s._c5 = out;
  return out;
}
/* chip column spec: all four chips share one width so the column reads as a price axis.
   Decision values: >= 12px design and >= 11.2px real; keys >= 9px design and >= 9px real, full opacity.
   The four chips (plus 1px gaps) must always fit inside the chart: if the chart is short, the chips shrink
   to fit rather than spill below it. */
function chipSpec(s, T, compact, chartH) {
  const L = s.L, inv = 1 / (S.s || 1);
  let fs = Math.max(compact ? 11.5 : 12, 11.2 * inv), pfs = Math.max(9, 9 * inv);
  let h = Math.ceil(fs + 4);
  const hMax = chartH ? Math.floor((chartH - 5) / 4) : h;
  if (h > hMax) { h = hMax; fs = Math.min(fs, h - 3); }
  pfs = Math.min(pfs, fs * 0.8);
  const mx = Math.max(...[L.T2, L.T1, L.E, L.SL].map(p => inr(p).length));
  const pw = Math.ceil(pfs * 1.5);
  return { fs, pfs, pw, w: Math.ceil(10 + pw + 3 + mx * 0.6 * fs * 0.98), h };
}
function chartGeom(s, cw, ch, opt) {
  const L = s.L, C = candles5(s);
  const vpW = opt.vp ? (opt.vpW || 20) : 0, x0 = vpW ? vpW + 4 : 3;
  const gutX = cw - opt.gutW, nowX = Math.round(gutX - opt.projW), area = nowX - 3 - x0;
  const nFit = clamp(Math.floor(area / TK_PITCH), 36, C5N);
  let k0 = C5N - nFit;
  // never open the chart on the breakout candle: show a proper consolidation first, or start after it
  if (C.kub + 2 >= k0 && C.kub - k0 < 6) { const alt = Math.max(0, C.kub - 6); k0 = area / (C5N - alt) >= 3.4 ? alt : Math.min(C.kub + 3, C5N - 36); }
  if (C.real) k0 = C.off;
  const n = C5N - k0, pitch = area / (C.real ? Math.max(n, 24) : n), xs = C.real ? x0 + area - n * pitch : x0;
  let lo = Math.min(L.SL, L.T2), hi = Math.max(L.SL, L.T2);
  for (let k = k0; k < C5N; k++) { lo = Math.min(lo, C.l[k]); hi = Math.max(hi, C.h[k]); }
  const rg = hi - lo, pmin = lo - rg * 0.02, pmax = hi + rg * 0.02;
  const cp = opt.chip ? opt.chip.h / 2 + 1 : 3;
  const yT = Math.max(opt.padT || 3, cp), yB = ch - Math.max(opt.padB || 3, cp);
  const y = p => yT + (pmax - p) / (pmax - pmin) * (yB - yT);
  const xl = k => xs + (k - k0) * pitch;
  return { cw, ch, vpW, x0, gutX, nowX, projW: opt.projW, k0, n, pitch, pmin, pmax, yT, yB, y, xl, xc: k => xl(k) + pitch / 2, xt: t => xs + (t / 5 - k0) * pitch, C };
}
function drawChartCanvas(ctx, s, g, opt) {
  const L = s.L, side = s.side, rgb = SC[side], hot = SCHOT[side], C = g.C, K = opt.k || 1, T = opt.T || 1;
  const { cw, ch, y, x0, nowX, gutX, k0, pitch } = g;
  const sn = v => Math.round(v * K) / K, px = 1 / K, hair = Math.max(1, Math.round(K)) / K;
  ctx.clearRect(0, 0, cw, ch);
  // grid
  ctx.fillStyle = 'rgba(255,255,255,.035)';
  for (let i = 1; i < 5; i++) ctx.fillRect(x0, sn(g.yT + (g.yB - g.yT) * i / 5), gutX - x0, hair);
  for (let m = 45; m < 375; m += 60) {
    const k = C.real ? C.off + m / C.iv : m / 5; if (k <= k0) continue; const X = sn(g.xl(k)); if (X > nowX - 6) continue;
    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(X, 0, hair, ch);
    if (opt.timeAxis && X - x0 > 14 && nowX - X > 16 && (!C.real || ((m - 45) / 60) % Math.max(1, Math.ceil((opt.stack ? 38 : 28) / (60 / C.iv * pitch))) === 0)) { ctx.font = `500 ${opt.stack ? 10 : 7.5 * T}px ${FONT_NUM}`; ctx.fillStyle = 'rgba(122,138,160,.75)'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(C.real ? fmtMin(obOpenMin() + m) : hhmm(m), X, ch - 1); }
  }
  // projection tint
  const pg = ctx.createLinearGradient(nowX, 0, gutX, 0); pg.addColorStop(0, `rgba(${rgb},.07)`); pg.addColorStop(1, `rgba(${rgb},.015)`);
  ctx.fillStyle = pg; ctx.fillRect(nowX, 0, cw - nowX, ch);
  // visible-range volume profile (hero)
  if (g.vpW) {
    const nb = clamp(Math.round((g.yB - g.yT) / 5.4), 16, 32), bins = new Float64Array(nb);
    const bi = p => (g.pmax - p) / (g.pmax - g.pmin) * nb;
    for (let k = k0; k < C5N; k++) {
      const a = bi(C.h[k]), b = bi(C.l[k]), span = Math.max(b - a, 1e-6);
      for (let j = Math.max(0, Math.floor(a)); j <= Math.min(nb - 1, Math.floor(b)); j++) { const ov = Math.min(b, j + 1) - Math.max(a, j); if (ov > 0) bins[j] += C.vol[k] * ov / span; }
    }
    let mx = 0, poc = 0, tot = 0; for (let j = 0; j < nb; j++) { tot += bins[j]; if (bins[j] > mx) { mx = bins[j]; poc = j; } }
    const va = new Set([poc]); let acc = bins[poc], lo = poc, hi = poc;
    while (acc < 0.7 * tot && (lo > 0 || hi < nb - 1)) { const a = lo > 0 ? bins[lo - 1] : -1, b = hi < nb - 1 ? bins[hi + 1] : -1; if (a >= b) { lo--; va.add(lo); acc += a; } else { hi++; va.add(hi); acc += b; } }
    const bh = (g.yB - g.yT) / nb;
    for (let j = 0; j < nb; j++) {
      if (!bins[j]) continue; const yy = sn(g.yT + j * bh + .5), hh = Math.max(px, sn(bh - 1.2)), len = Math.max(1, bins[j] / mx * (g.vpW - 1));
      if (j === poc) {
        ctx.save(); ctx.shadowColor = `rgba(${rgb},.9)`; ctx.shadowBlur = 5 * K; ctx.fillStyle = `rgba(${hot},.92)`; ctx.fillRect(0, yy, len, hh); ctx.restore();
        ctx.fillStyle = `rgba(${hot},.16)`; ctx.fillRect(x0, sn(yy + hh / 2), nowX - x0, hair);          // naked POC line
      }
      else { ctx.fillStyle = `rgba(${rgb},${va.has(j) ? .5 : .2})`; ctx.fillRect(0, yy, len, hh); }
    }
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(sn(g.vpW + 1.5), g.yT, hair, g.yB - g.yT);
  }
  // origin OB (older, dim): the base of the morning breakout
  if (C.kO >= k0) {
    const xa = sn(g.xl(C.kO)), ya = sn(y(C.h[C.kO])), yb = sn(y(C.l[C.kO]));
    ctx.fillStyle = `rgba(${rgb},.06)`; ctx.fillRect(xa, ya, nowX - xa, Math.max(2, yb - ya));
    ctx.setLineDash([3, 3]); ctx.strokeStyle = `rgba(${rgb},.32)`; ctx.lineWidth = px; ctx.strokeRect(xa + px / 2, ya + px / 2, nowX - xa - px, Math.max(2, yb - ya) - px); ctx.setLineDash([]);
  }
  // opposing zone (explains T2), faint, in the projection
  { const ya = y(Math.max(L.oppLo, L.oppHi)), yb = y(Math.min(L.oppLo, L.oppHi)); ctx.fillStyle = `rgba(${SC[-side]},.06)`; ctx.fillRect(nowX, ya, gutX - nowX, yb - ya); }
  // fair-value gap left by the displacement, open until the retest fills it
  { const xa = sn(g.xl(C.kF >= 0 ? C.kF : C.kB + 1)), xb = sn(g.xl(C.kd) + pitch / 2), ya = sn(y(C.fvg[1])), yb = sn(y(C.fvg[0]));
    if (yb - ya >= 1) { ctx.fillStyle = 'rgba(111,163,255,.11)'; ctx.fillRect(xa, ya, xb - xa, yb - ya); ctx.setLineDash([1, 2]); ctx.strokeStyle = 'rgba(111,163,255,.6)'; ctx.lineWidth = px; ctx.strokeRect(xa + px / 2, ya + px / 2, xb - xa - px, yb - ya - px); ctx.setLineDash([]); } }
  // faint level guides across the candle area
  const guide = (p, col, dash) => { const Y = sn(y(p)) + px / 2; ctx.strokeStyle = col; ctx.setLineDash(dash); ctx.lineWidth = px; ctx.beginPath(); ctx.moveTo(x0, Y); ctx.lineTo(nowX, Y); ctx.stroke(); ctx.setLineDash([]); };
  if (C.hist) obHistory(ctx, s, g, K);
  else { guide(L.T2, `rgba(${rgb},.16)`, [2, 4]); guide(L.T1, `rgba(${rgb},.11)`, [1, 4]); guide(L.SL, 'rgba(255,176,32,.16)', [4, 3]); }
  // VWAP (clipped to the price area so it never runs through the time axis)
  ctx.save(); ctx.beginPath(); ctx.rect(x0, g.yT, nowX - x0, g.yB - g.yT); ctx.clip();
  ctx.strokeStyle = 'rgba(111,163,255,.72)'; ctx.setLineDash([3, 2]); ctx.lineWidth = Math.max(px, 1); ctx.beginPath();
  let first = true; for (let t = 5 * k0 + 1; t <= NT; t += 2) { const X = g.xt(t), Y = y(s.vwap[t]); first ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y); first = false; }
  ctx.lineTo(nowX - 2, y(s.vwap[NT])); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
  if (opt.vwapTag) {
    // label the VWAP line where it is clear of candles, the block, the legend and the time axis
    const vfs = opt.stack ? 10 : 7.5 * T; ctx.font = `600 ${vfs}px ${FONT_NUM}`; const txt = 'VWAP ' + inr(s.vwap[NT]), tw = ctx.measureText(txt).width, th = vfs;
    const obA = y(L.obHi), obB = y(L.obLo), xOB = g.xl(C.kB), lgW = opt.legendW || 0, lgH = 27 * T;
    const hit = (xa, xb, ya, yb) => {
      if (ya < 1 || yb > g.yB - 1) return true;
      if (xb > xOB - 2 && ya < obB + 2 && yb > obA - 2) return true;
      if (lgW && xa < x0 + 3 + lgW + 4 && (side > 0 ? ya < 3 + lgH + 3 : yb > g.yB - lgH - 3)) return true;
      if (g.labs && g.labs.some(r => xa < r.x + r.w + 2 && xb > r.x - 2 && ya < r.y + r.h + 1 && yb > r.y - 1)) return true;
      for (let k = Math.max(k0, Math.floor(k0 + (xa - g.xl(k0)) / pitch) - 1); k < C5N && g.xl(k) < xb + 1; k++) if (y(C.h[k]) < yb + 2 && y(C.l[k]) > ya - 2) return true;
      return false;
    };
    let spot = null;
    for (let xr = nowX - 4; xr > x0 + tw + 6 && !spot; xr -= 5) {
      const t = clamp(Math.round((xr - tw / 2 - g.xl(k0)) / pitch * 5 + 5 * k0), 1, NT), Y = y(s.vwap[t]);
      for (const up of side > 0 ? [false, true] : [true, false]) { const ya = up ? Y - 3 - th : Y + 3; if (!hit(xr - tw, xr, ya, ya + th)) { spot = [xr, ya]; break; } }
    }
    if (spot) { ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(4,7,11,.55)'; ctx.fillRect(spot[0] - tw - 2, spot[1] - 1, tw + 4, th + 2); ctx.fillStyle = 'rgba(111,163,255,.95)'; ctx.fillText(txt, spot[0], spot[1]); }
  }
  // depth under the tape: soft side-tinted area below (BUY) / above (SELL) the closes
  { ctx.save(); ctx.beginPath(); const base = side > 0 ? g.yB : g.yT;
    for (let k = k0; k < C5N; k++) { const X = g.xc(k), Y = y(C.c[k]); k === k0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y); }
    ctx.lineTo(nowX, y(s.l)); ctx.lineTo(nowX, base); ctx.lineTo(g.xc(k0), base); ctx.closePath();
    const ga = ctx.createLinearGradient(0, side > 0 ? g.yT : g.yB, 0, base); ga.addColorStop(0, `rgba(${rgb},.20)`); ga.addColorStop(1, `rgba(${rgb},.02)`);
    ctx.fillStyle = ga; ctx.fill(); ctx.restore(); }
  // candles: monochrome (trend = side colour, counter-trend = slate)
  const bw = Math.min(pitch - 0.5, Math.max(3, pitch * 0.78));
  for (let k = k0; k < C5N; k++) {
    const o = C.o[k], c = C.c[k], up = c >= o, trend = side > 0 ? up : !up;
    const xL = g.xl(k) + (pitch - bw) / 2;
    const bx0 = sn(xL), bx1 = Math.max(bx0 + px, sn(xL + bw)), wx = sn(xL + bw / 2 - hair / 2);
    ctx.fillStyle = trend ? `rgba(${rgb},.8)` : 'rgba(118,130,154,.85)';
    const yh = y(C.h[k]), yl = y(C.l[k]); ctx.fillRect(wx, yh, hair, Math.max(px, yl - yh));
    const yt = sn(y(Math.max(o, c))), yb = Math.max(yt + px, sn(y(Math.min(o, c))));
    ctx.fillStyle = trend ? `rgb(${rgb})` : '#56627A'; ctx.fillRect(bx0, yt, bx1 - bx0, yb - yt);
    if (k === C.kB) { ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = px; ctx.strokeRect(bx0 - 1.5 + px / 2, sn(yh) - 1.5 + px / 2, bx1 - bx0 + 3 - px, sn(yl) - sn(yh) + 3 - px); }
  }
  // price-axis hairline at the chip column
  ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(sn(gutX - 1), 2, hair, ch - 4);
  // NOW
  ctx.strokeStyle = 'rgba(255,255,255,.42)'; ctx.lineWidth = px; ctx.setLineDash([1, 2]); ctx.beginPath(); ctx.moveTo(nowX + px / 2, 0); ctx.lineTo(nowX + px / 2, ch); ctx.stroke(); ctx.setLineDash([]);
}
function buildChart(parent, s, cw, ch, opt) {
  const L = s.L, side = s.side, rgb = SC[side], T = opt.T || 1, cs = opt.chip;
  const box = el('div', 'chart', parent); css(box, { left: opt.x, top: opt.y, width: cw, height: ch });
  if (candles5(s).hist) opt = Object.assign({}, opt, { gutW: 2 });   // levels are labelled where they were marked, not stacked at the end
  const g = chartGeom(s, cw, ch, opt), C = g.C, y = g.y;
  opt.legendW = Math.min(g.nowX - 8 - g.x0, (8 + `OI +00.0% · Δ ${lakh(s.delta)}`.length * 0.6 * 9.5 * T));
  if (C.hist) { g.labs = obPlaceLabels(s, g, opt); if (opt.mids) obPlaceMids(s, g, opt); }   // popups: the levels in between too
  const { cv, ctx } = localCanvas(box, cw, ch, opt.k, ''); drawChartCanvas(ctx, s, g, opt);
  cv.className = 'cc';
  // active OB: sits on the base candle, extends right through NOW to the chart edge
  const xa = Math.round(g.xl(C.kB) + (g.pitch - Math.min(g.pitch - 0.5, Math.max(3, g.pitch * 0.78))) / 2) - 2;
  const obT = y(L.obHi), obH = Math.max(3, y(L.obLo) - obT);
  const ob = el('div', 'ov ob', box); css(ob, { left: xa, top: obT, width: cw - xa, height: obH });
  const tg = el('div', 't', ob, 'OB'); const tgX = Math.round(g.xl(C.kB + 2) - xa + 2), tfs = Math.min((opt.stack || S.stacked) ? 10 : 7.5 * T, obH - 2.5);
  if (tfs >= ((opt.stack || S.stacked) ? 10 : Math.max(6.5, 7.5 * T * 0.9))) css(tg, { left: tgX, top: Math.max(0.5, (obH - tfs) / 2 - 0.5), fontSize: tfs + 'px' });
  else css(tg, side > 0 ? { left: tgX, top: obH + 2 } : { left: tgX, top: -7.5 * T - 2 });
  // resting liquidity (Bookmap) inside the block, anchored at the chip column
  // resting liquidity still sitting in the block (Bookmap lines), ending at NOW
  const rr = rng(s.s, 'rest'), nRest = clamp(Math.floor(obH / 3.4), 2, 5), span = g.nowX - g.xl(C.kB + 2);
  for (let i = 0; i < nRest; i++) {
    const b = el('div', 'ov rl', box); const yy = obT + obH * (i + 0.5) / nRest;
    css(b, { top: Math.round(yy - 1), right: cw - g.nowX + 1, width: Math.round((0.3 + 0.6 * rr()) * span) });
    b.style.animationDuration = (700 + rr() * 700) + 'ms'; b.style.setProperty('--hot', SCHOT[side]);
  }
  // position tool (hero): reward box E -> T2, risk box E -> SL (amber)
  const pX = g.nowX + 3, pW = g.gutX - 3 - pX;
  if (opt.pos && pW >= 12) {
    const rw = el('div', 'ov pos', box); const ya = y(Math.max(L.E, L.T2)), yb = y(Math.min(L.E, L.T2));
    css(rw, { left: pX, top: ya, width: pW, height: yb - ya, background: `rgba(${rgb},.15)`, borderColor: `rgba(${rgb},.6)` });
    const lfs = (opt.stack || S.stacked) ? 10 : Math.max(9, 9 / S.s), rtxt = L.rr.toFixed(1) + 'R';
    if (rtxt.length * 0.6 * lfs <= pW - 2 && yb - ya >= lfs + 6) { const lab = el('div', 'rtag', rw, rtxt); css(lab, { fontSize: lfs + 'px', top: side > 0 ? 3 : 'auto', bottom: side > 0 ? 'auto' : 3 }); }
    const rk = el('div', 'ov pos', box); const ra = y(Math.max(L.E, L.SL)), rb = y(Math.min(L.E, L.SL));
    css(rk, { left: pX, top: ra, width: pW, height: rb - ra, background: 'rgba(255,176,32,.13)', borderColor: 'rgba(255,176,32,.55)' });
  }
  // chips: dodged >= 14px apart in a fixed right column; leaders where displaced
  const CH = cs.h, SP = CH + (4 * CH + 7 <= ch ? 2 : 1);
  const items = [['T2', L.T2], ['T1', L.T1], ['E', L.E], ['SL', L.SL]].map(([k, p]) => ({ k, p, ty: y(p), y: y(p) })).sort((a, b) => a.ty - b.ty);
  for (let it = 0; it < 60; it++) for (let i = 1; i < items.length; i++) { const d = items[i].y - items[i - 1].y; if (d < SP) { const p = (SP - d) / 2; items[i - 1].y -= p; items[i].y += p; } }
  const minY = CH / 2 + 1, maxY = ch - CH / 2 - 1;
  items.forEach(o => o.y = clamp(o.y, minY, maxY));
  for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + SP);
  items[3].y = Math.min(items[3].y, maxY); for (let i = 2; i >= 0; i--) items[i].y = Math.min(items[i].y, items[i + 1].y - SP);
  items[0].y = Math.max(items[0].y, minY); for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + SP);
  // never spill: if the stack still runs past the chart bottom, lift the whole stack
  const over = items[3].y - maxY; if (over > 0) items.forEach(o => o.y -= over);
  items.forEach(o => o.y = C.hist ? o.ty : Math.round(o.y));
  // level lines + entry band + leaders (one svg, revealed with the levels)
  const X0 = g.nowX, X1 = g.gutX - 2, cL = g.gutX + 1, st = { T2: `stroke="rgb(${rgb})"`, T1: `stroke="rgba(${SCHI[side]},.9)" stroke-dasharray="1 2"`, SL: 'stroke="rgba(255,176,32,.95)" stroke-dasharray="4 3"', E: 'stroke="rgba(255,255,255,.7)"' };
  const yA = Math.round(y(L.eHi)), yB = Math.round(y(L.eLo));
  let sv = `<svg width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}"><rect x="${X0}" y="${yA}" width="${X1 - X0}" height="${Math.max(1, yB - yA)}" fill="rgba(255,255,255,.10)"/>` +
    `<path d="M${X0} ${yA + .5}H${X1}M${X0} ${yB - .5}H${X1}" stroke="rgba(255,255,255,.55)" stroke-width="1" fill="none"/>`;
  items.forEach(o => {
    const Y = Math.round(o.ty) + .5, moved = Math.abs(o.y - o.ty) > 1.5, xe = moved ? X1 - 5 : cL;
    if (o.k !== 'E') sv += `<path d="M${X0} ${Y}H${xe}" ${st[o.k]} stroke-width="1" fill="none"/>`;
    if (moved) sv += `<path d="M${o.k === 'E' ? X1 - 9 : xe} ${Y}${o.k === 'E' ? 'H' + (X1 - 5) : ''}L${cL} ${o.y + .5}" stroke="${o.k === 'SL' ? 'rgba(255,176,32,.8)' : o.k === 'E' ? 'rgba(255,255,255,.7)' : `rgba(${SCHI[side]},.75)`}" stroke-width="1" fill="none"/>`;
  });
  if (g.labs) sv += obLeaders(g, side);
  const lv = el('div', 'ov lvl lvs', box, sv + '</svg>'); css(lv, { left: 0, top: 0, width: cw, height: ch });
  const chipEls = [];
  if (g.labs) obLabels(box, g);
  (C.hist ? [] : items).forEach(o => {
    const c = el('div', `chip2 ov k-${o.k}`, box, `<b style="font-size:${cs.pfs}px;width:${cs.pw}px">${obLv(o.k, side)}</b><span>${inr(o.p)}</span>`);
    css(c, { top: o.y - CH / 2, height: CH, width: cs.w, right: 1, fontSize: cs.fs + 'px', lineHeight: (CH - 2) + 'px' });
    chipEls.push(c);
  });
  // last price
  const lp = el('div', 'ov lp', box); css(lp, { left: g.nowX, top: y(s.l) }); lp.style.setProperty('--hot', SCHOT[side]);
  // legend: build-up chip over OI / delta, in the empty left corner (top for BUY, bottom for SELL)
  if (opt.legend) {
    const lg = el('div', 'ovl lg2', box, opt.legend); const lx = g.x0 + 3;
    css(lg, { left: lx, maxWidth: g.nowX - 5 - lx, top: side > 0 ? 3 : 'auto', bottom: side > 0 ? 'auto' : (opt.padB || 3) });
    const lOver = () => lg.scrollWidth > lg.clientWidth + 0.5; let gd = 30;
    while (lOver() && gd--) { let ch = false; lg.querySelectorAll('.buc,.oi').forEach(e => { const f = parseFloat(e.style.fontSize); const mn = 9 / (opt.stack ? 1 : S.s); if (f > mn) { e.style.fontSize = Math.max(mn, f - 0.25) + 'px'; ch = true; } }); if (!ch) break; }
    if (lOver()) { const dl = lg.querySelector('.dl'); if (dl) dl.style.display = 'none'; }   // never clip: drop the Δ part first
  }
  return { box, cv, ob, g, chipEls };
}
function ringSVG(size, stroke, val, rgb) {
  const r = (size - stroke) / 2, C = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="${stroke}"/><circle class="fg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgb(${rgb})" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - val / 100)).toFixed(2)}" data-c="${C.toFixed(2)}" data-v="${val}"/></svg>`;
}
function drawRail(ctx, s, w, h, g, ch0, ch1) {
  const rgb = SC[s.side]; const r = rng(s.s, 'rail');
  const bias = 0.5 + 0.45 * Math.tanh(s.c / 2); const n = clamp(Math.round((h - 12) / 12), 8, 20); const pitch = (h - 12) / n;
  const pOf = yy => g.pmax - (yy - ch0 - g.yT) / (g.yB - g.yT) * (g.pmax - g.pmin);
  for (let k = 0; k < n; k++) {
    const yy = 6 + k * pitch + pitch / 2; const p = pOf(yy), pr = (g.pmax - g.pmin) / (g.yB - g.yT) * pitch * .5;
    const inOB = p >= s.L.obLo - pr && p <= s.L.obHi + pr;
    const a = inOB ? 1 : .38; const L = 0.35 + 0.65 * r();
    const bid = (w - 2) * L * bias, ask = (w - 2) * L * (1 - bias);
    ctx.fillStyle = `rgba(25,229,140,${a})`; ctx.fillRect(0, yy - 1.5, bid, 3);
    ctx.fillStyle = `rgba(255,59,92,${a})`; ctx.fillRect(w - ask, yy - 1.5, ask, 3);
    if (inOB) { ctx.fillStyle = `rgba(${rgb},.18)`; ctx.fillRect(0, yy - pitch / 2, w, pitch); }
  }
}
/* entry range: always both full prices (a price never loses its leading digits) */
function tkRange(a, b) { return inr(a) + '–' + inr(b); }
const tkNP = t => t.replace(/([,.])/g, '<i class="np">$1</i>');
function stripHTML(s, o) {
  const L = s.L, V = t => o.np ? tkNP(t) : t;
  const g = (cls, k, v) => `<span class="g ${cls}">${k ? `<span class="k">${k}</span>` : ''}<span class="v">${V(v)}</span></span>`;
  const parts = [g('en', o.ek || 'ZONE', tkRange(L.eLo, L.eHi)), g('sl', obLv('SL', s.side), inr(L.SL)), g('t1', obLv('T1', s.side), inr(L.T1)), g('t2', obLv('T2', s.side), inr(L.T2)), g('rr', 'R:R', '1:' + L.rr.toFixed(1))];
  if (o.two) return `<div class="lr">${parts[0]}${parts[1]}</div><div class="lr">${parts[2]}${parts[3]}${parts[4]}</div>`;
  return parts.join(o.sep ? '<span class="sp">·</span>' : '');
}
function planHTML(s, o) {
  const L = s.L, V = t => o.np ? tkNP(t) : t;
  const cell = (cls, k, v) => `<div class="pcell ${cls}"><div class="k">${k}</div><div class="v">${V(v)}</div></div>`;
  const K = [obLv('SL', s.side, !o.sk), 'ZONE', obLv('T1', s.side, !o.sk), obLv('T2', s.side, !o.sk)];
  return cell('sl', K[0], inr(L.SL)) + cell('en', K[1], tkRange(L.eLo, L.eHi)) + cell('t1', K[2], inr(L.T1)) + cell('t2', K[3], inr(L.T2)) +
    cell('rr' + (o.sk ? ' kabs' : ''), 'RISK ' + L.risk.toFixed(2) + '%', '1:' + L.rr.toFixed(1));
}
/* one-line level strip (#2/#3): values shrink to the real-px floor, then the ENTRY key shortens to E, the
   separators go, punctuation tightens; if it still does not fit it becomes two rows (ENTRY + SL / T1 + T2 + R:R).
   A price is never elided and the R:R key is never dropped. Returns the chosen mode. */
function fitStrip(TK, ls) {
  const s = TK.s, stack = !!TK.stack, sc = stack ? 1 : S.s;
  const over = e => e.scrollWidth > e.clientWidth + 0.5;
  const shrink = (e, prop, min) => { let v = parseFloat(e.style.getPropertyValue(prop)); let g = 80; while (over(e) && v > min + 1e-3 && g--) { v = Math.max(min, v - 0.25); e.style.setProperty(prop, v + 'px'); } };
  const v0 = +ls.dataset.vfs, l0 = +ls.dataset.lfs, fl = Math.min(v0, Math.max(TK.pick && ls.closest('.compact') ? 11.5 : 12, TKF.val / sc));
  const o = { sep: true, np: false, two: false, ek: 'ZONE' };
  ls.classList.remove('two', 'nosep'); ls.style.setProperty('--vfs', v0 + 'px'); ls.style.setProperty('--lfs', l0 + 'px');
  const render = () => { ls.innerHTML = stripHTML(s, o); ls.classList.toggle('nosep', !o.sep); ls.classList.toggle('two', o.two); };
  render(); shrink(ls, '--vfs', fl);
  for (const [k, v] of [['ek', 'Z'], ['sep', false], ['np', true]]) { if (!over(ls)) break; o[k] = v; render(); shrink(ls, '--vfs', fl); }
  if (over(ls)) {
    Object.assign(o, { two: true, sep: false, np: false, ek: 'ZONE' }); ls.style.setProperty('--vfs', v0 + 'px'); render(); shrink(ls, '--vfs', fl);
    if (over(ls)) { o.ek = 'E'; render(); shrink(ls, '--vfs', fl); }
    if (over(ls)) { o.np = true; render(); shrink(ls, '--vfs', fl); }
  }
  if (over(ls)) { shrink(ls, '--lfs', Math.min(l0, 9 / sc)); shrink(ls, '--vfs', Math.min(v0, TKF.hard / sc)); }
  ls.classList.toggle('tight', over(ls));
  ls.dataset.fit = o.two ? 'two' : 'one';
  return o;
}
function fitLevels(TK) {
  const d = TK.el, s = TK.s, stack = !!TK.stack, sc = stack ? 1 : S.s;
  const over = e => e.scrollWidth > e.clientWidth + 0.5;
  const shrink = (e, prop, min) => { let v = parseFloat(e.style.getPropertyValue(prop)); let g = 80; while (over(e) && v > min + 1e-3 && g--) { v = Math.max(min, v - 0.25); e.style.setProperty(prop, v + 'px'); } };
  const ls = d.querySelector('.lvlstrip');
  if (ls && !ls.dataset.fit) fitStrip(TK, ls);
  const pl = d.querySelector('.plan .cells');
  if (pl) {
    const o = { np: false };
    const v0 = +pl.parentNode.dataset.vfs, fl = Math.min(v0, Math.max(12, TKF.val / sc));
    pl.style.setProperty('--vfs', v0 + 'px');
    const render = () => { pl.innerHTML = planHTML(s, o); };
    render(); shrink(pl, '--vfs', fl);
    if (over(pl)) { o.sk = true; render(); shrink(pl, '--vfs', fl); }   // short keys (SL / ENTRY / T1 / T2) before any value shrinks
    if (over(pl)) { o.np = true; render(); shrink(pl, '--vfs', fl); }
    if (over(pl)) shrink(pl, '--vfs', Math.min(v0, TKF.hard / sc));
  }
}
function buildTicket(M, TK, parent, mode) {
  const s = TK.s, side = s.side, rgb = SC[side], L = s.L;
  const stack = mode === 'stack'; TK.stack = stack;
  const big = TK.pick === 1; const w = TK.w; let h = TK.h;
  const compact = !stack && !big && h < 118;
  const T = stack ? 1 : S.tx;
  const kk = (stack ? 1 : S.s) * S.dpr;
  const d = el('div', `ticket ${side > 0 ? 'buy' : 'sell'} p${TK.pick}${big ? ' hero' : compact ? ' compact' : ' std'}`, parent);
  d.dataset.k = s.s; if (!s._anchor) d.title = `${s.s} · Click to copy code · ⌘+Click to open Upstox`;
  const demoPick = M.buyPicks[0] || M.sellPicks[0];
  if (!stack && demoPick && s.s === demoPick.s) d.setAttribute('data-hover-demo', '1');
  d.style.setProperty('--sc', rgb); d.style.setProperty('--hi', SCHI[side]); d.style.setProperty('--hot', SCHOT[side]);
  TK.el = d;
  el('div', 'gb', d);
  if (big) { el('div', 'sheen', d); el('div', 'spec', d); }
  const acc = el('div', 'acc', d); TK.acc = acc;
  const pad = big ? 12 : compact ? 8 : 10;
  const inv = stack ? 1 : 1 / (S.s || 1);
  const labFs = (stack || S.stacked) ? Math.max(10, (big ? 9.5 : 9) * T) : Math.max((big ? 9.5 : 9) * T, 9 * inv), valFs = Math.max((big ? 13.5 : compact ? 11.5 : 12) * T, (compact ? 10.8 : 11.2) * inv);
  const botIn = big ? 11 : compact ? 7 : 8;
  // #2/#3: the level strip is laid out (and fitted: one row or two) first; the chart takes what is left
  let ls = null, stripH;
  if (!big) {
    ls = el('div', 'lvlstrip', d); css(ls, { left: stack ? 30 : 32, width: stack ? w - 42 : w - 44 });
    ls.dataset.vfs = valFs; ls.dataset.lfs = labFs;
    fitStrip(TK, ls); stripH = Math.ceil(ls.offsetHeight) || Math.ceil(valFs * 1.3);
  } else stripH = Math.ceil(labFs + 5 + valFs + 8 + 6);
  let infoX, infoY, infoW, infoH, chartX, chartY, chartW, chartH, stripTop;
  if (!stack) {
    infoX = 32; infoW = big ? 164 : 166; chartX = big ? 202 : 206; chartW = w - 10 - chartX;
    stripTop = h - botIn - stripH;
    chartY = big ? pad : pad - 1; chartH = stripTop - (big ? 9 : 5) - chartY;
    infoY = pad - 1; infoH = chartH + 1;
    css(d, { left: TK.x, top: TK.y, width: w, height: h });
  } else {
    infoX = 30; infoW = w - 42; infoY = pad; infoH = big ? 140 : 90;
    chartX = 30; chartW = w - 42; chartY = infoY + infoH + 8; chartH = big ? 156 : 100;
    stripTop = chartY + chartH + 10;
    css(d, { position: 'relative', width: '100%', height: stripTop + 40 });
  }
  if (ls) css(ls, { top: stripTop });
  const mgS = big ? 32 : compact ? 22 : 26;
  const info = el('div', 'ab info', d); css(info, { left: infoX, top: infoY, width: infoW, height: infoH });
  const mg = `<div class="mg" style="width:${mgS}px;height:${mgS}px;font-size:${big ? 14 : compact ? 11 : 12}px;background:linear-gradient(135deg,${sideCol(side, 'Deep')},#0A0F17)">${monogram(s)}</div>`;
  // the verb is the loudest control on the card: 14px (hero) / 13px, never under 12px real
  const pillFs = Math.max(big ? 14 : 13, 12 * inv), pillH = Math.round(Math.max(pillFs * 1.62, big ? 30 : 26));
  const pill = `<div class="pill" style="height:${pillH}px;font-size:${pillFs.toFixed(2)}px">${side > 0 ? 'BULLISH' : 'BEARISH'}</div>`;
  const ringS = big ? 36 : compact ? 24 : 28;
  // conviction ring + confluence pips are one group (pips stacked beside the ring), identical in every mode
  const ring = `<div class="cgrp"><div class="cring" style="width:${ringS}px;height:${ringS}px">${ringSVG(ringS, big ? 3 : 2.5, s.conv, rgb)}<div class="rv" style="font-size:${Math.min(ringS * 0.5, Math.max((big ? 12 : compact ? 9.5 : 10.5) * Math.min(T, 1.25), 9 * inv)).toFixed(2)}px">${s.conv}</div></div><div class="pips v">${s.pips.map(x => `<i class="${x ? 'on' : ''}"></i>`).join('')}</div></div>`;
  const pips = '';
  const legend = `<span class="buc" style="font-size:${Math.max(8.5 * T, 9 * inv).toFixed(2)}px">${s.bu}</span><span class="oi" style="font-size:${Math.max(9.5 * T, 9.5 * inv).toFixed(2)}px">OI ${sgnStr(s.oi)}${Math.abs(s.oi).toFixed(1)}%<span class="dl"> · Δ ${lakh(s.delta)}</span></span>`;
  let html = '';
  if (big) {
    html += `<div class="rowa">${mg}<div class="idc"><div class="tkr" style="font-size:26px">${s.s}</div><div class="nm" style="font-size:${Math.max(10 * T, 9.5 * inv).toFixed(2)}px"><span class="nmn">${s.n}</span><span class="nms"> · ${s.sec}</span></div></div></div>`;
    html += `<div class="rowb">${pill}${ring}${pips}</div>`;
    html += `<div class="rowc"><div class="pc hero-pc" data-v="${s.c}" style="font-size:${stack ? 44 : 48}px">${pctStr(s.c)}</div></div>`;
    html += `<div class="rowd"><span class="ltp" style="font-size:${13 * T}px">₹${inr(s.l)}</span><span class="pts" style="font-size:${12 * T}px">${ptsStr(s.pts)}</span><span class="pctl" style="font-size:${((stack || S.stacked) ? 10 : Math.max(8.5 * T, 9 * inv)).toFixed(2)}px">P${(s.p * 100).toFixed(1)}</span></div>`;
  } else if (!compact) {
    html += `<div class="rowa">${mg}<div class="tkr" style="font-size:22px">${s.s}</div></div>`;
    html += `<div class="rowb">${pill}${ring}${pips}</div>`;
    html += `<div class="rowc"><div class="pc" data-v="${s.c}" style="font-size:26px">${pctStr(s.c)}</div><div class="lp2"><div class="ltp" style="font-size:${12.5 * T}px">₹${inr(s.l)}</div><div class="pts" style="font-size:${11 * T}px">${ptsStr(s.pts)}</div></div></div>`;
  } else {
    html += `<div class="rowa">${mg}<div class="tkr" style="font-size:20px">${s.s}</div>${ring}</div>`;
    html += `<div class="rowb">${pill}<div class="pc" data-v="${s.c}" style="font-size:22px">${pctStr(s.c)}</div></div>`;
    html += `<div class="rowc"><span class="ltp" style="font-size:${11.5 * T}px">₹${inr(s.l)}</span><span class="pts" style="font-size:${11 * T}px">${ptsStr(s.pts)}</span></div>`;
  }
  info.innerHTML = html;
  // chart
  const chip = chipSpec(s, T, compact, chartH);
  const chart = buildChart(d, s, chartW, chartH, {
    x: chartX, y: chartY, vp: big, vpW: 20, pos: big, gutW: chip.w + 2, projW: big ? 30 : 24, chip, compact, k: kk, T,
    padT: 3, padB: big ? 3 + (stack ? 11 : Math.max(9 * T, 9 * inv)) : 3, timeAxis: big && (stack || S.s >= 0.8), vwapTag: big, legend, stack
  });
  TK.chart = chart;
  // level plan (hero) / level strip (#2, #3, already fitted)
  if (big) {
    const pl = el('div', 'plan' + (stack ? ' wrap' : ''), d); css(pl, { left: 32, top: stripTop, width: w - 44 });
    if (stack) css(pl, { left: 30, width: w - 42 });
    pl.dataset.vfs = valFs; pl.style.setProperty('--vfs', valFs + 'px'); pl.style.setProperty('--lfs', labFs + 'px');
    pl.innerHTML = `<div class="cells">${planHTML(s, {})}</div><div class="rrbar"></div>`;
    const bar = pl.querySelector('.rrbar');
    const a = L.SL, b = L.T2; const pos = p => (p - a) / (b - a) * 100;
    const seg = (p0, p1, bg, cls) => { const l = Math.min(pos(p0), pos(p1)), r = Math.max(pos(p0), pos(p1)); return `<i class="${cls || ''}" style="left:${l}%;width:${r - l}%;background:${bg}"></i>`; };
    const eNear = side > 0 ? L.eLo : L.eHi, eFar = side > 0 ? L.eHi : L.eLo;
    bar.innerHTML = seg(L.SL, eNear, 'linear-gradient(90deg,rgba(255,176,32,.85),rgba(255,176,32,.55))', 'r0') + seg(L.eLo, L.eHi, 'rgba(255,255,255,.55)') + seg(eFar, L.T2, `linear-gradient(90deg,rgba(${rgb},.35),rgb(${rgb}))`, 'r1') +
      `<i class="tk" style="left:calc(${pos(L.E)}% - 1px);width:2px;top:-3px;bottom:-3px;background:#fff;box-shadow:0 0 6px #fff"></i><i class="tk" style="left:${pos(L.T1)}%;width:1px;top:-2px;bottom:-2px;background:rgba(255,255,255,.85)"></i>`;
  }
  fitLevels(TK);
  if (stack) { const bl = d.querySelector('.plan, .lvlstrip'); h = stripTop + bl.offsetHeight + 14; TK.h = h; d.style.height = h + 'px'; }
  // depth rail
  const { cv: rc, ctx: rx } = localCanvas(d, 20, h, kk, 'rail'); css(rc, { position: 'absolute', left: 3, top: 0 });
  drawRail(rx, s, 20, h, chart.g, chartY, chartY + chartH);
  el('div', 'railsep', d);
  return d;
}
function fitTicket(TK) {
  const d = TK.el; if (!d) return;
  const info = d.querySelector('.info'); if (!info) return;
  const sc = TK.stack ? 1 : S.s;
  const over = row => row.scrollWidth > row.clientWidth + 0.5;
  const fs = e => parseFloat(getComputedStyle(e).fontSize);
  const shrink = (row, els, min) => { let g = 90; while (over(row) && g--) { let ch = false; els.forEach(e => { if (!e) return; const f = fs(e); if (f > min + 1e-3) { e.style.fontSize = Math.max(min, f - 0.5) + 'px'; ch = true; } }); if (!ch) break; } };
  const q = (row, sel) => [...row.querySelectorAll(sel)];
  const hide = (row, sel) => { if (over(row)) q(row, sel).forEach(e => e.style.display = 'none'); };
  info.querySelectorAll('.rowa,.rowb,.rowc,.rowd').forEach(row => {
    const nm0 = row.querySelector('.nm');
    if (!over(row) && !(nm0 && nm0.scrollWidth > nm0.clientWidth + 0.5)) return;
    if (row.classList.contains('rowa')) {
      const nm = row.querySelector('.nm');
      if (nm) { const nOver = () => nm.scrollWidth > nm.clientWidth + 0.5; let g = 20; while (nOver() && fs(nm) > 9 / sc && g--) nm.style.fontSize = Math.max(9 / sc, fs(nm) - 0.5) + 'px'; if (nOver()) nm.querySelector('.nms').style.display = 'none'; }
      shrink(row, q(row, '.tkr'), 16);
    } else if (row.classList.contains('rowb')) {
      row.style.gap = '6px'; shrink(row, q(row, '.pc'), 16);   // the ring + pips group is never hidden
      if (over(row)) { const p = row.querySelector('.pill'); if (p) p.textContent = p.textContent.startsWith('BULL') ? 'BULL' : 'BEAR'; }
    } else if (row.classList.contains('rowc')) {
      if (d.classList.contains('hero')) shrink(row, q(row, '.pc'), 36);
      shrink(row, q(row, '.ltp,.pts'), TKF.val / sc); shrink(row, q(row, '.pc'), 20); shrink(row, q(row, '.ltp,.pts'), TKF.hard / sc); shrink(row, q(row, '.pc'), 16);
    } else {
      shrink(row, q(row, '.ltp,.pts'), TKF.val / sc); hide(row, '.pctl'); shrink(row, q(row, '.ltp,.pts'), TKF.hard / sc);
    }
  });
  fitLevels(TK);
}
function buildAnomaly(M, TK, parent, mode) {
  const s = TK.s; const stack = mode === 'stack'; const a = el('div', 'anom', parent); a.dataset.k = s.s;
  if (!s._anchor) a.title = `${s.s} · Click to copy code · ⌘+Click to open Upstox`;
  if (!stack) css(a, { left: TK.x, top: TK.y, width: TK.w, height: TK.h }); else css(a, { position: 'relative', width: '100%', height: 54 });
  a.innerHTML = `<div class="hz"><span>⊘</span></div><div class="anin"><div class="aid"><span class="tk">${s.s}</span><span class="sub">${s.n.toUpperCase()} · ${s.sec}</span></div>` +
    `<div class="apx"><span class="pc">${pctStr(s.c)}</span><span class="lt">₹${inr(s.l)}</span></div><span class="spk"></span>` +
    `<span class="tags"><span class="ch er">EVENT RISK</span><span class="ch nt">⊘ NO TRADE</span></span></div>`;
  const sp = a.querySelector('.spk'); const sw = stack ? 64 : 112, sh = 26;
  const { cv, ctx } = localCanvas(sp, sw, sh, (stack ? 1 : S.s) * S.dpr, '');
  cv.style.display = 'block';
  let mn = 1e9, mx = -1e9; for (let t = 0; t <= NT; t++) { mn = Math.min(mn, s.pct[t]); mx = Math.max(mx, s.pct[t]); }
  const X = t => t / NT * (sw - 4) + 1, Y = v => 2 + (mx - v) / (mx - mn) * (sh - 4);
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, Math.round(Y(0)), sw, 1);
  const xc = X(126); ctx.fillStyle = 'rgba(255,176,32,.22)'; ctx.fillRect(xc - 1.5, 0, 3, sh);
  const gr = ctx.createLinearGradient(0, 0, sw, 0); gr.addColorStop(0, COL.amber); gr.addColorStop(.33, COL.amber); gr.addColorStop(.37, COL.crash); gr.addColorStop(1, COL.crash);
  ctx.strokeStyle = gr; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.beginPath();
  for (let t = 0; t <= NT; t += 2) { t ? ctx.lineTo(X(t), Y(s.pct[t])) : ctx.moveTo(X(t), Y(s.pct[t])); } ctx.lineTo(X(NT), Y(s.pct[NT])); ctx.stroke();
  ctx.fillStyle = COL.crash; ctx.beginPath(); ctx.arc(X(NT), Y(s.pct[NT]), 2, 0, Math.PI * 2); ctx.fill();
  TK.el = a;
  if (stack) fitAnom(a);
  return a;
}
function fitAnom(a) {
  const an = a.querySelector('.anin'); if (!an) return;
  const over = () => an.scrollWidth > an.clientWidth + .5;
  for (const h of ['.spk', '.sub']) { if (!over()) break; const e = an.querySelector(h); if (e) e.style.display = 'none'; }
  if (over()) { const e = an.querySelector('.lt'); if (e) e.style.display = 'none'; }
}
function buildTickets(M, G, root) {
  root.innerHTML = '';
  G.tickets.forEach(TK => { if (TK.event) buildAnomaly(M, TK, root, 'stage'); else buildTicket(M, TK, root, 'stage'); });
  G.tickets.forEach(TK => TK.event ? fitAnom(TK.el) : fitTicket(TK));
}
