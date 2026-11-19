/* ================= util ================= */
function fnv1a(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rng(sym, salt) { return mulberry32(fnv1a(sym + ':' + salt)); }
function gauss(r) { let u = 0; while (u === 0) u = r(); const v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
const tick = x => Math.round(x / 0.05) * 0.05;
const MINUS = '−';
function sgnStr(v) { return v > 0 ? '+' : v < 0 ? MINUS : ''; }
/* Indian digit grouping */
function inr(v, dp = 2) {
  const neg = v < 0; v = Math.abs(v);
  let [ip, fp] = v.toFixed(dp).split('.');
  let out = '';
  if (ip.length > 3) {
    const last3 = ip.slice(-3); let rest = ip.slice(0, -3);
    rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    out = rest + ',' + last3;
  } else out = ip;
  return (neg ? MINUS : '') + out + (fp ? '.' + fp : '');
}
function pctStr(v, dp = 2) { return sgnStr(v) + Math.abs(v).toFixed(dp) + '%'; }
function ptsStr(v, dp = 2) { return sgnStr(v) + inr(Math.abs(v), dp); }
function lakh(v) {
  const a = Math.abs(v), s = sgnStr(v);
  if (a >= 1e5) return s + (a / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
  return s + a.toFixed(0);
}
function valueNoise1D(seed, n, octaves = 2) {
  const r = mulberry32(seed); const out = new Float32Array(n);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const k = 4 * Math.pow(2, o) + 1; const pts = []; for (let i = 0; i <= k; i++) pts.push(r() * 2 - 1);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * k; const i0 = Math.floor(x), f = x - i0; const a = pts[Math.min(i0, k)], b = pts[Math.min(i0 + 1, k)]; const s = f * f * (3 - 2 * f); out[i] += amp * (a + (b - a) * s); }
    norm += amp; amp *= 0.5;
  }
  for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}
/* Brownian bridge 0..n (0 at both ends); sigmaTotal=1 -> std .5 at the middle */
function bridge(r, n, sigmaTotal, smooth = 0) {
  const w = new Float64Array(n + 1); let s = 0; const st = sigmaTotal / Math.sqrt(n);
  for (let i = 1; i <= n; i++) { s += gauss(r) * st; w[i] = s; }
  for (let i = 0; i <= n; i++) w[i] -= w[n] * i / n;
  if (smooth > 0) {
    const o = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) { let a = 0, c = 0; for (let j = -smooth; j <= smooth; j++) { const k = i + j; if (k >= 0 && k <= n) { a += w[k]; c++; } } o[i] = a / c; }
    for (let i = 0; i <= n; i++) o[i] -= (o[0] * (1 - i / n) + o[n] * i / n);
    return o;
  }
  return w;
}
/* monotone cubic (Fritsch-Carlson) */
function monotoneCubic(xs, ys) {
  const n = xs.length, d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
function hexRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function rgba(h, a) { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; }
function ramp(stops) { // stops: [[t, '#hex'], ...]
  const S = stops.map(([t, h]) => [t, hexRgb(h)]);
  return t => {
    t = clamp(t, 0, 1); let i = 0; while (i < S.length - 2 && t > S[i + 1][0]) i++;
    const [t0, a] = S[i], [t1, b] = S[i + 1]; const f = (t - t0) / (t1 - t0 || 1);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
}
function mixRgb(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
function rgbStr(c, a = 1) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }
function monogram(st) {
  const h = ((window.OBF_LOGOS || {}).m || {})[st.s];
  return monoText(st) + (h && /^[0-9a-f]{16}$/.test(h) ? `<img class="lg" src="/media/logos/${h}.png" alt="" draggable="false">` : '');
}
function monoText(st) {
  const words = st.n.replace(/\(.*?\)/g, '').split(/[\s&-]+/).filter(w => /[A-Za-z]/.test(w));
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return st.s.slice(0, 2).toUpperCase();
}
function fmtMin(m) { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function obMeta() { return (M && M.D && M.D.meta) || {}; }
function obOpenMin() { const o = obMeta().open || '09:15'; return +o.slice(0, 2) * 60 + +o.slice(3, 5); }
function obEl() { const e = obMeta().el; return e > 0 ? Math.min(e, NT) : NT; }
function obClock() { return obMeta().clock || '15:30:00'; }
function obState() { return obMeta().status === 'live' ? 'LIVE' : 'CLOSE'; }
function obEndLabel() { return fmtMin(obOpenMin() + obEl()); }
function obAxisLabels() {
  const o = obOpenMin(), e = obEl(), out = [[0, fmtMin(o)]];
  for (let h = Math.ceil((o + 1) / 60) * 60; h < o + e - 25; h += 60) { const t = (h - o) / e * NT; if (t > 20) out.push([t, fmtMin(h)]); }
  return out;
}
function hhmm(t) { return fmtMin(obOpenMin() + t * obEl() / NT); }
/* SEBI wording: levels are named as chart analysis (zone / support / resistance), never as a
   trade plan (entry / stop-loss / target). Keys stay E, SL, T1, T2; only the shown words change.
   Bullish card: support S1 below, resistances R1/R2 above. Bearish card: the mirror. */
function obLv(k, side, long) {
  const up = side > 0, W = {
    E: ['ZONE', 'Z'],
    SL: up ? ['SUPPORT 1', 'S1'] : ['RESISTANCE 1', 'R1'],
    T1: up ? ['RESISTANCE 1', 'R1'] : ['SUPPORT 1', 'S1'],
    T2: up ? ['RESISTANCE 2', 'R2'] : ['SUPPORT 2', 'S2'],
  };
  return W[k][long ? 0 : 1];
}
/* real order-block setups: detected on the server from the live 5-minute candles (x = levels for every
   contender, x.k = the candle tape for the six picks). Without x a stock keeps the page's own model. */
function obLevels(x) {
  const op = x.op || [x.t[1], x.t[1]];
  const L = { obLo: x.z[0], obHi: x.z[1], eLo: x.e[0], eHi: x.e[1], E: x.e[2], SL: x.sl, T1: x.t[0], T2: x.t[1], oppLo: op[0], oppHi: op[1] };
  L.R = Math.abs(L.E - L.SL); L.risk = L.R / L.E * 100; L.rr = Math.abs(L.T2 - L.E) / (L.R || 1);
  return L;
}
// the tape arrives packed in paise: open = previous close + q0, wicks q1 / q2, close = open + q3; VWAP = close + w.
// k.h is the level history, 10 values per change (each a delta from the previous change): the candle it applies
// from, the block's base candle (-1: before the tape), zone low / high, band low / high, zone mid, then the
// levels behind the S1 / R1 / R2 (or R1 / S1 / S2) chips
function obTape(k) {
  if (k.o) return k;
  const n = k.v.length, o = [], h = [], l = [], c = [], w = []; let prev = k.p;
  for (let i = 0; i < n; i++) {
    const q = 4 * i, O = prev + k.q[q], C = O + k.q[q + 3];
    o.push(O / 100); c.push(C / 100); h.push((Math.max(O, C) + k.q[q + 1]) / 100); l.push((Math.min(O, C) - k.q[q + 2]) / 100); w.push((C + k.w[i]) / 100); prev = C;
  }
  const hist = [], v = [0, 0].concat(new Array(8).fill(k.p)), H = k.h || [];
  for (let i = 0; i + 10 <= H.length; i += 10) {
    for (let j = 0; j < 10; j++) v[j] += H[i + j];
    hist.push({ s: v[0], b: v[1], zl: v[2] / 100, zh: v[3] / 100, el: v[4] / 100, eh: v[5] / 100, E: v[6] / 100, SL: v[7] / 100, T1: v[8] / 100, T2: v[9] / 100 });
  }
  return Object.assign({}, k, { o, h, l, c, w, hist });
}
// the real tape sits right-aligned in the chart's C5N slots: slot = candle + off
function obCandles(s) {
  const k = s.x.k, n = Math.min(k.c.length, C5N), off = C5N - n, pad = a => new Array(off).fill(NaN).concat(a.slice(-n));
  const at = i => i >= 0 ? i + off : -99, f = k.f && k.f.length === 4 ? k.f : null;
  const hist = k.hist && k.hist.length ? k.hist.map(e => Object.assign({}, e, { s: e.s + off, b: at(e.b) })) : null;
  return { o: pad(k.o), h: pad(k.h), l: pad(k.l), c: pad(k.c), vol: pad(k.v), real: true, n, off, iv: k.iv || 5, hist,
    kB: at(k.b), kO: at(k.g), kub: at(k.u), fvg: f ? [f[0], f[1]] : [0, 0], kF: f ? at(f[2]) : -99, kd: f && f[3] >= 0 ? at(f[3]) : C5N - 1 };
}
/* levels through the session (user request: never all marked, or crowded, at the end of the chart). Each setup the
   live market marked (a block becoming the active one) keeps its levels where it stood in the session: its block box,
   zone band and S / R lines from the moment it was marked until the next setup replaced it, at the values it was last
   updated to. Only the current setup is labelled (user request: text on the earlier setups read as noise, their
   lines stay); it runs on through NOW into the projection. Styles match the old chip column: R2/S2 solid, R1/S1
   dotted, the level behind the block amber dashed, the zone white. */
function obRuns(C) {
  const R = [];
  C.hist.forEach(e => { const r = R[R.length - 1]; if (r && r.b === e.b) r.v = e; else R.push({ b: e.b, s0: e.s, v: e }); });
  R.forEach((r, i) => { r.s1 = i < R.length - 1 ? R[i + 1].s0 : C5N; r.cur = i === R.length - 1; });
  return R;
}
// under the candles: each setup's block, zone and level lines over its own stretch of the session
function obHistory(ctx, s, g, K) {
  const R = g.runs || (g.runs = obRuns(g.C)), side = s.side, rgb = SC[side], y = g.y, sn = v => Math.round(v * K) / K, px = 1 / K;
  const X = k => clamp(g.xl(k), g.x0, g.nowX), cb = R[R.length - 1].b;
  ctx.save(); ctx.beginPath(); ctx.rect(g.x0, g.yT - 2, g.nowX - g.x0, g.yB - g.yT + 4); ctx.clip();
  R.forEach(r => {
    const xa = sn(X(r.s0)), xb = r.cur ? g.nowX : sn(X(r.s1)), v = r.v, a = r.cur ? 1 : .75;
    if (xb - xa < 1) return;
    // the block while it was the active one (the current block is the page's own OB box, the origin block its dashed box)
    if (!r.cur && r.b !== cb && r.b !== g.C.kO) {
      const bx = sn(r.b >= g.k0 ? Math.min(g.xl(r.b), xa) : xa), ya = sn(y(v.zh)), yb = Math.max(ya + 2 * px, sn(y(v.zl)));
      ctx.fillStyle = `rgba(${rgb},.13)`; ctx.fillRect(bx, ya, xb - bx, yb - ya);
      ctx.strokeStyle = `rgba(${rgb},.5)`; ctx.lineWidth = px; ctx.strokeRect(bx + px / 2, ya + px / 2, xb - bx - px, yb - ya - px);
      ctx.fillStyle = `rgba(${rgb},.85)`; ctx.fillRect(bx, ya, 2 * px, yb - ya);
    }
    { const ya = sn(y(v.eh)), yb = sn(y(v.el)); ctx.fillStyle = `rgba(255,255,255,${.09 * a})`; ctx.fillRect(xa, ya, xb - xa, Math.max(px, yb - ya)); }
    const line = (p, col, dash) => { const Y = sn(y(p)) + px / 2; ctx.strokeStyle = col; ctx.setLineDash(dash); ctx.lineWidth = px; ctx.beginPath(); ctx.moveTo(xa, Y); ctx.lineTo(xb, Y); ctx.stroke(); ctx.setLineDash([]); };
    line(v.T2, `rgba(${rgb},${.9 * a})`, []);
    line(v.T1, `rgba(${SCHI[side]},${.9 * a})`, [1, 2]);
    line(v.E, `rgba(255,255,255,${.65 * a})`, []);
    line(v.SL, `rgba(255,176,32,${.95 * a})`, [4, 3]);
  });
  // the levels in between: from where each formed through NOW, in the colour of the setup's own level on that side
  (g.mids || []).forEach(m => {
    const Y = sn(y(m.p)) + px / 2; ctx.strokeStyle = 'rgba(255,176,32,.62)'; ctx.setLineDash([2, 3]); ctx.lineWidth = px;
    ctx.beginPath(); ctx.moveTo(sn(X(m.k)), Y); ctx.lineTo(g.nowX, Y); ctx.stroke(); ctx.setLineDash([]);
  });
  ctx.restore();
}
function obMeasure(font, t) { const c = obMeasure.c || (obMeasure.c = document.createElement('canvas').getContext('2d')); c.font = font; return c.measureText(t).width; }
/* where the current setup's labels go: at the moment it was marked, on the free side of each line (above a resistance,
   below a support and the zone of a bullish setup, the mirror for a bearish one, so they sit off the candles), nudged
   apart where lines are close; when it was marked at the very end they sit just before NOW. A label that would cover
   the current block's OB tag or the last-price dot moves beside the tag (right, else left) or just before NOW. */
function obPlaceLabels(s, g, opt) {
  const R = g.runs || (g.runs = obRuns(g.C)), r = R[R.length - 1], side = s.side, T = opt.T || 1, inv = opt.stack ? 1 : 1 / (S.s || 1);
  const fs = (opt.stack || S.stacked) ? 10 : Math.max(8 * T, 9 * inv), kfs = (opt.stack || S.stacked) ? 10 : fs * .86, h = Math.ceil(fs * 1.25), SP = h;   // phone: 10 px floor
  const wOf = (k, p) => Math.ceil(obMeasure(`800 ${kfs}px ${FONT_UI}`, k) + 3 + obMeasure(`700 ${fs}px ${FONT_NUM}`, inr(p)) + 2);
  const ov = (a, b) => a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  // the current block's OB tag (placed as buildChart places it) and the last-price dot at NOW
  const L0 = s.L, t7 = 7.5 * T, obT = g.y(L0.obHi), obH = Math.max(3, g.y(L0.obLo) - obT), tfs = Math.min(t7, obH - 2.5), tin = tfs >= Math.max(6.5, t7 * .9);
  const tag = { x: g.xl(g.C.kB + 2) + 1, y: tin ? obT : side > 0 ? obT + obH + 1 : obT - t7 - 3, w: obMeasure(`700 ${tin ? tfs : t7}px ${FONT_NUM}`, 'OB') + 4, h: tin ? obH : t7 + 2 };
  const dot = { x: g.nowX - 6, y: g.y(s.l) - 6, w: 12, h: 12 };
  const lx = Math.round(clamp(g.xl(r.s0), g.x0, g.nowX)), minC = 1 + h / 2, maxC = g.yB + 2 - h / 2;
  const it = [['T2', r.v.T2], ['T1', r.v.T1], ['E', r.v.E], ['SL', r.v.SL]]
    .map(([k, p]) => ({ k, p, key: obLv(k, side), ly: g.y(p), up: (k[0] === 'T') === (side > 0) }))
    .filter(o => o.ly > g.yT - 3 && o.ly < g.yB + 3);
  if (!it.length) return [];
  it.forEach(o => { o.d = o.up ? o.ly - 1 - h / 2 : o.ly + 1 + h / 2; o.cy = o.d; o.w = wOf(o.key, o.p); });
  it.sort((a, b) => a.d - b.d);
  for (let n = 0; n < 40; n++) for (let i = 1; i < it.length; i++) { const d = it[i].cy - it[i - 1].cy; if (d < SP) { const q = (SP - d) / 2; it[i - 1].cy -= q; it[i].cy += q; } }
  const L = it.length - 1;
  it[L].cy = Math.min(it[L].cy, maxC); for (let i = L - 1; i >= 0; i--) it[i].cy = Math.min(it[i].cy, it[i + 1].cy - SP);
  it[0].cy = Math.max(it[0].cy, minC); for (let i = 1; i <= L; i++) it[i].cy = Math.max(it[i].cy, it[i - 1].cy + SP);
  const mw = Math.max(...it.map(o => o.w)), x = lx + 2 + mw > g.cw - 2 ? Math.floor(g.nowX - 7 - mw) : lx + 2;
  return it.map(o => {
    const rc = { x, y: Math.round(o.cy - h / 2), w: o.w, h }, ok = () => rc.x >= g.x0 && rc.x + rc.w <= g.cw - 2 && !ov(rc, tag) && !ov(rc, dot);
    for (const cx of [x, Math.ceil(tag.x + tag.w + 3), Math.floor(tag.x - 3 - o.w), Math.floor(g.nowX - 7 - o.w)]) { rc.x = cx; if (ok()) break; }
    return Object.assign(rc, { k: o.k, key: o.key, p: o.p, ly: o.ly, d: o.d, lx, fs, kfs });
  });
}
// the labels: the level's key and value in its line's colour, haloed in the panel colour so they read over candles
function obLabels(box, g) {
  g.labs.forEach(o => {
    const c = el('div', `ov lvl mlab k-${o.k}`, box, `<b style="font-size:${o.kfs}px">${o.key}</b>${inr(o.p)}`);
    css(c, { left: o.x, top: o.y, right: 'auto', height: o.h, fontSize: o.fs + 'px', lineHeight: o.h + 'px' });   // .lvl: revealed with the levels
  });
}
// a leader from the line's start to a label that is not beside it: pulled in before the line (a setup marked at the
// very end) or nudged off its line by a close neighbour
function obLeaders(g, side) {
  const st = { SL: 'rgba(255,176,32,.8)', E: 'rgba(255,255,255,.7)' };
  return g.labs.map(o => {
    const cy = o.y + o.h / 2, ly = Math.round(o.ly) + .5, re = o.x + o.w;
    let d = '';
    if (re < o.lx - 1) d = `M${o.lx} ${ly}L${re + 1} ${cy}`;
    else if (Math.abs(cy - o.d) > 2) d = o.x >= o.lx - 1 ? `M${o.lx} ${ly}L${o.x} ${cy}` : `M${o.lx + .5} ${ly}V${cy < ly ? o.y + o.h : o.y}`;
    return d ? `<path d="${d}" stroke="${st[o.k] || `rgba(${SCHI[side]},.75)`}" stroke-width="1" fill="none"/>` : '';
  }).join('');
}
/* levels in between (user request: the popup chart's empty stretch between the current setup and the far end of the
   day's range gets levels too). On the side the price came from (above a bearish setup's R1, below a bullish setup's
   S1) the day left structure the price has not closed back through: swing highs (lows) it turned at, the day's open,
   and fair-value gaps its move left unfilled (from the edge of the part still open). The nearest three, at least a
   label and a half apart, are drawn from where they formed through NOW and named on from the setup's own level
   (R2, R3, R4 on a bearish chart; S2, S3, S4 on a bullish one). */
function obMids(s, g, h) {
  const C = g.C, L = s.L, d = -s.side, n0 = Math.max(C.off, g.k0), n1 = C5N;
  // side-normalised prices: u grows away from the market on the side it came from (up on a bearish chart)
  const hu = k => d > 0 ? C.h[k] : -C.l[k], lu = k => d > 0 ? C.l[k] : -C.h[k], cu = k => d * C.c[k];
  const sep = 1.6 * h * (g.pmax - g.pmin) / (g.yB - g.yT), base = Math.max(d * L.SL, d * L.obLo, d * L.obHi, d * s.l);
  let top = -Infinity; for (let k = n0; k < n1; k++) if (hu(k) === hu(k)) top = Math.max(top, hu(k));
  const cand = [], add = (u, k, sw) => { if (u - base >= sep && top - u >= sep) cand.push({ u, k, sw }); };
  for (let k = n0 + 2; k < n1 - 2; k++) {
    const p = hu(k);
    if (!(hu(k - 1) < p && hu(k - 2) < p && hu(k + 1) <= p && hu(k + 2) <= p)) continue;
    let ok = true; for (let t = k + 1; t < n1 && ok; t++) ok = cu(t) <= p;
    if (ok) add(p, k, 1);
  }
  if (C.off >= n0 && C.o[C.off] === C.o[C.off]) add(d * C.o[C.off], C.off, 1);
  for (let k = n0 + 1; k < n1 - 1; k++) {
    const far = lu(k - 1); let near = hu(k + 1);
    if (!(far > near)) continue;
    for (let t = k + 2; t < n1; t++) near = Math.max(near, hu(t));
    if (far - near >= .15 * (s.ATR || 0)) add(near, k, 0);
  }
  // one per cluster: a swing or the open before a gap, then the farther one
  cand.sort((a, b) => a.u - b.u);
  const cl = [];
  cand.forEach(c => { const q = cl[cl.length - 1]; if (q && c.u - q.u < sep) { if (c.sw > q.sw || (c.sw === q.sw && c.u > q.u)) cl[cl.length - 1] = c; } else cl.push(c); });
  const out = []; let last = base;
  for (const c of cl) { if (out.length === 3) break; if (c.u - last >= sep) { out.push(c); last = c.u; } }
  return out.map((c, i) => ({ p: d * c.u, k: c.k, key: (d > 0 ? 'R' : 'S') + (i + 2) }));
}
// their labels: on the line, on its free side (above a resistance, below a support), slid right from where the level
// formed until clear of the candles and the other labels; else just before NOW
function obPlaceMids(s, g, opt) {
  const T = opt.T || 1, inv = opt.stack ? 1 : 1 / (S.s || 1), fs = (opt.stack || S.stacked) ? 10 : Math.max(8 * T, 9 * inv), kfs = (opt.stack || S.stacked) ? 10 : fs * .86, h = Math.ceil(fs * 1.25);
  const M = g.mids = obMids(s, g, h), labs = g.labs || (g.labs = []), C = g.C, up = s.side < 0;
  if (!M.length) return;
  const ov = (a, b) => a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const dot = { x: g.nowX - 6, y: g.y(s.l) - 6, w: 12, h: 12 };
  const onCandle = r => {
    for (let k = Math.max(g.k0, C.off); k < C5N; k++) {
      const xa = g.xl(k); if (xa > r.x + r.w) break;
      if (xa + g.pitch < r.x || !(C.h[k] === C.h[k])) continue;
      if (r.y < g.y(C.l[k]) + 1 && r.y + r.h > g.y(C.h[k]) - 1) return true;
    }
    return false;
  };
  M.forEach(m => {
    const w = Math.ceil(obMeasure(`800 ${kfs}px ${FONT_UI}`, m.key) + 3 + obMeasure(`700 ${fs}px ${FONT_NUM}`, inr(m.p)) + 2);
    const ly = g.y(m.p), x0 = Math.round(clamp(g.xl(m.k), g.x0, g.nowX)) + 2, xe = Math.floor(g.nowX - 7 - w), st = Math.max(2, g.pitch);
    const free = ok => labs.every(o => !ov(ok, o)) && !ov(ok, dot) && ok.x >= g.x0 && ok.x + ok.w <= g.cw - 2 && ok.y >= 0 && ok.y + ok.h <= g.ch;
    let rc = null;
    for (const top of [up, !up]) {
      for (let x = x0; x <= xe && !rc; x += st) { const r = { x: Math.round(x), y: Math.round(top ? ly - 1 - h : ly + 1), w, h }; if (free(r) && !onCandle(r)) rc = r; }
      if (rc) break;
    }
    rc = rc || { x: xe, y: Math.round(up ? ly - 1 - h : ly + 1), w, h };
    labs.push(Object.assign(rc, { k: 'M', key: m.key, p: m.p, ly, d: rc.y + h / 2, lx: rc.x, fs, kfs }));
  });
}
// real day range + VWAP; for a pick the VWAP (known at each candle close) is laid onto the chart's slot scale
function obRealTape(s) {
  const x = s.x; s.dayH = x.hl[0]; s.dayL = x.hl[1]; s.vwapEnd = x.vw;
  if (x.k) x.k = obTape(x.k);
  if (!x.k || !x.k.w.length) return;
  const w = x.k.w, n = Math.min(w.length, C5N), off = C5N - n, v = new Float64Array(NT + 1);
  for (let t = 0; t <= NT; t++) { const p = t / 5 - off; if (p <= 1) v[t] = w[0]; else if (p >= n) v[t] = w[n - 1]; else { const i = Math.ceil(p) - 1; v[t] = w[i - 1] + (w[i] - w[i - 1]) * (p - i); } }
  v[NT] = x.vw; s.vwap = v;
}
// a pick's sparkline from its real candles (open → each close, over the session so far)
function obRealPath(s) {
  const k = s.x.k, c = k.c, n = c.length, sc = obEl() / NT / (k.iv || 5), P = new Float64Array(NT + 1);
  for (let t = 0; t <= NT; t++) { const p = Math.min(t * sc, n), i = Math.min(Math.floor(p), n - 1), a = i ? c[i - 1] : k.o[0]; P[t] = a + (c[i] - a) * (p - i); }
  s.P = P;
}
// popup chart for a contender: the same ticket chart, drawn from the pick's tape or fetched on open.
// The box keeps its height while loading so the popup never jumps.
function obInspectorChart(parent, s, w, h, T, kk, stack) {
  if (!s.L || s.event) return;
  const side = s.side, box = el('div', 'ichart', parent);
  css(box, { width: w, height: h });
  box.style.setProperty('--sc', SC[side]); box.style.setProperty('--hi', SCHI[side]); box.style.setProperty('--hot', SCHOT[side]);
  const draw = () => {
    if (!box.isConnected || box.firstChild) return;
    const chip = chipSpec(s, T, true, h), inv = stack ? 1 : 1 / (S.s || 1);
    buildChart(box, s, w, h, { x: 0, y: 0, vp: false, gutW: chip.w + 2, projW: 20, chip, compact: true, k: kk, T,
      padT: 3, padB: 3 + (stack ? 11 : Math.max(9 * T, 9 * inv)), timeAxis: true, vwapTag: false, legend: '', stack, mids: true });
  };
  draw();
}
/* peek mode (user request: hovering a stock on the Home page opens this same popup). Home loads the page hidden with
   ?peek=1: the snapshot is modelled as usual, but there is no stage, no build show and no animation. The parent asks
   for a stock's popup ({t:'ob-peek', sym, face}: face = the side the popup's accent edge faces), it is drawn exactly
   as a tile's popup is, and its size goes back ({t:'ob-peek-size'}) so the parent sizes and places the frame. */
const OB_PEEK = !!window.OB_PEEK, PEEK_PAD = 24;   // room around the popup for its shadow
let PEEK = null;
function obPeekBoot() {
  const R = document.documentElement, st = $('#stage'), i = $('#inspector');
  R.classList.add('peek'); st.classList.remove('pre');
  try { M = buildModel(OBF_FEED.data); } catch (e) { console.warn('model failed', e); return; }
  S.s = 1; S.tx = 1; S.stacked = false; S.dpr = Math.min(2, window.devicePixelRatio || 1); S.k = S.dpr;
  R.style.setProperty('--tx', 1); st.style.setProperty('--tx', 1);
  css(i, { left: PEEK_PAD, top: PEEK_PAD });
  if (window.ResizeObserver) new ResizeObserver(obPeekSize).observe(i);   // late fonts can change its height
  window.addEventListener('message', e => { if (e.origin === location.origin && e.data && e.data.t === 'ob-peek') obPeek(e.data); });
  try { parent.postMessage({ t: 'ob-peek-ready' }, location.origin); } catch (e) { }
}
function obPeekSize() {
  const i = $('#inspector'), on = !!PEEK && i.classList.contains('on');
  try { parent.postMessage({ t: 'ob-peek-size', sym: PEEK && PEEK.sym, on, pad: PEEK_PAD, w: on ? i.offsetWidth + 2 * PEEK_PAD : 0, h: on ? i.offsetHeight + 2 * PEEK_PAD : 0 }, location.origin); } catch (e) { }
}
function obPeek(q) {
  const s = q && q.sym && M && M.bySym[q.sym];
  PEEK = s ? { t: 'ob-peek', sym: q.sym, face: q.face } : null;
  if (!s) { hideInspector(); obPeekSize(); return; }
  if (OBF_FEED.load && Date.now() - (OBF_FEED.at || 0) > 60000) OBF_FEED.load();   // stale: refetch, the popup redraws when it lands
  showInspector(s);
  $('#inspector').dataset.face = q.face === 'r' ? 'r' : 'l';
  obPeekSize();
}

/* ================= data model (deterministic synthetic) ================= */
const NT = 375; // 1-min steps 09:15 -> 15:30
function buildModel(D) {
  const M = { D };
  const sideMode = (D.meta && D.meta.filter && D.meta.filter.side) || (window.OBF_FEED && window.OBF_FEED.filter && window.OBF_FEED.filter.side) || "ALL";
  let rawList = D.stocks.map(s => Object.assign({}, s));
  if (sideMode === "BULL") {
    rawList = rawList.filter(s => s.g === "bull");
  } else if (sideMode === "BEAR") {
    rawList = rawList.filter(s => s.g === "bear");
  }
  const stocks = rawList;
  M.sideMode = sideMode;
  const bySym = {}; stocks.forEach(s => bySym[s.s] = s);
  const secMap = {}; D.sectors.forEach(x => secMap[x.sec] = x);
  M.bySym = bySym; M.secMap = secMap; M.stocks = stocks;

  /* ---- lanes / ranks ---- */
  const lanes = stocks.slice().sort((a, b) => b.p - a.p);
  lanes.forEach((s, k) => { s.lane = k; s.side = s.g === 'bull' ? 1 : -1; });
  M.lanes = lanes;
  const bulls = lanes.filter(s => s.side > 0);
  const bears = lanes.filter(s => s.side < 0).reverse(); // strongest (lowest p) first
  bulls.forEach((s, i) => s.rank = i + 1);
  let br = 0; bears.forEach(s => { s.event = Math.abs(s.c) > 10; if (s.event) s.rank = 0; else s.rank = ++br; });
  bulls.forEach(s => s.event = false);
  M.eventSym = (bears.find(s => s.event) || {}).s || '';
  M.nBull = bulls.length; M.nBear = bears.filter(s => !s.event).length; // 59 / 149 (+1 event)
  M.bulls = bulls; M.bears = bears;
  M.nBullAll = bulls.length; M.nBearAll = bears.length; // 59 / 150
  const sortMode = (D.meta && D.meta.filter && D.meta.filter.sort) || (window.OBF_FEED && window.OBF_FEED.filter && window.OBF_FEED.filter.sort) || "MAX_GAINS";
  stocks.forEach(s => {
    s.sel = !!s.top;
    const realScore = sortMode === "SETUP_SCORE"
      ? (typeof s.setupScore === "number" ? s.setupScore : s.strengthScore)
      : (typeof s.strengthScore === "number" ? s.strengthScore : s.setupScore);
    s.conv = typeof realScore === "number"
      ? Math.round(clamp(realScore, 0, 100))
      : (s.rank ? Math.round(97 - 1.4 * (s.rank - 1)) : 0);
  });

  /* ---- base price ---- */
  stocks.forEach(s => {
    // one reference price per stock, derived from the two mandated numbers (c, l): the previous close.
    // The feed's cp is measured from the 09:16 open while c is measured from the previous close, so
    // showing cp next to c would not reconcile (ICICIPRULI +11.80 on 452.70 is +2.61%, not +3.53%).
    // pts = l − base therefore always agrees with the printed %; the path, the first candle and the
    // plume all start from this same base, so every chart's net move equals the printed %.
    const ok = Math.sign(s.l - s.o) === Math.sign(s.c) && s.l !== s.o;
    s.derived = !ok; s.base = s.c ? s.l / (1 + s.c / 100) : s.l; s.pts = (ok && typeof s.cp === 'number') ? s.cp : s.l - s.base; // show the feed's real pts where it is consistent
  });

  /* ---- market factor: none (no index is tracked), so every stock path's shared leg is flat ---- */
  const m = new Float64Array(NT + 1);

  /* ---- sector factors ---- */
  const secF = {};
  D.sectors.forEach(x => { secF[x.sec] = bridge(rng(x.sec, 'sec'), NT, 0.25 * Math.abs(x.chg) + 0.1, 6); });

  /* ---- stock % paths ---- */
  const e = new Float64Array(NT + 1); for (let t = 0; t <= NT; t++) e[t] = 0.35 + 0.65 * smoothstep(0.15, 0.40, t / NT);
  const Mdev = new Float64Array(NT + 1); for (let t = 0; t <= NT; t++) Mdev[t] = m[t] - m[NT] * t / NT;
  // per-stock reaction lag to the market leg (−8…+22 min), bridge-corrected so it stays 0 at both ends:
  // the tape's 11:15 air-pocket reaches each name at its own moment instead of as one curtain
  const lagged = lag => {
    const o = new Float64Array(NT + 1), at = x => { x = clamp(x, 0, NT); const i = Math.floor(x), f = x - i; return i >= NT ? Mdev[NT] : Mdev[i] + (Mdev[i + 1] - Mdev[i]) * f; };
    for (let t = 0; t <= NT; t++) o[t] = at(t - lag);
    const a = o[0], b = o[NT]; for (let t = 0; t <= NT; t++) o[t] -= a * (1 - t / NT) + b * t / NT;
    return o;
  };
  stocks.forEach(s => {
    const r = rng(s.s, 'path');
    s.beta = 0.6 + 0.7 * r(); s.sig = 0.35 + 0.25 * Math.abs(s.c); s.rr = r();
    s.B = bridge(rng(s.s, 'bb'), NT, 1, 6);
    const rt = rng(s.s, 'stagger');
    s.Mlag = lagged(-8 + 30 * rt());
    if (s.sel && !s.event) {
      // breakout time: seeded, only mildly biased to strength (stronger a little earlier); spread ~10:30 → 13:00
      const frac = (s.rank - 1) / 19;
      s.ub = clamp(0.20 + 0.40 * (0.3 * frac + 0.7 * rng(s.s, 'ub')()), 0.2, 0.6);
    } else {
      // herd: each name drifts, then breaks down (or out) on its own clock, 10:15 → 13:30
      const tbLo = 0.16 + 0.11 * smoothstep(0.6, 1.5, Math.abs(s.c)); // big movers wait for the neck to close
      s.tb = tbLo + (0.68 - tbLo) * Math.pow(rt(), 0.9);
      s.tw = 0.07 + 0.09 * rt();           // 26–60 min wide — a slope, not a cliff
      s.tA = 0.30 + 0.25 * rt();           // share of the move that is steady drift
      s.rr2 = rt();
    }
  });
  const sig = x => 1 / (1 + Math.exp(-x));
  const F = (s, u) => {
    if (s.sel && !s.event) {
      const ub = s.ub, d = 0.05;
      if (u < ub) return 0.12 * smoothstep(0, ub, u);
      if (u < ub + d) { const x = (u - ub) / d; return 0.12 + 0.45 * x * x * x * (x * (6 * x - 15) + 10); } // softened impulse
      return 0.57 + 0.43 * smoothstep(ub + d, 1, u);
    }
    // drift (u^γ) + a staggered logistic leg normalised to 0 at the open and 1 at the close
    const a0 = sig(-s.tb / s.tw), a1 = sig((1 - s.tb) / s.tw);
    const leg = (sig((u - s.tb) / s.tw) - a0) / (a1 - a0);
    return s.tA * Math.pow(u, 0.7 + 0.6 * s.rr) + (1 - s.tA) * leg;
  };
  let damp = 1;
  const genPaths = () => {
    stocks.forEach(s => {
      const pct = new Float64Array(NT + 1);
      if (s.event) {
        const r = rng(s.s, 'crash'); const nz = bridge(r, NT, .6, 2);
        for (let t = 0; t <= NT; t++) {
          let v;
          if (t <= 123) v = -1.1 * smoothstep(0, 123, t) + 0.15 * Math.sin(t / 9) * (t / 123) * (1 - t / 123) * 4;
          else if (t <= 129) { const f = (t - 123) / 6; v = -1.1 + (-23 + 1.1) * (1 - Math.pow(1 - f, 2)); }
          else { const f = (t - 129) / (NT - 129); v = -23 + (s.c + 23) * Math.pow(f, 0.8) + nz[t] * (t < NT ? 1 : 0); }
          pct[t] = v;
        }
        pct[NT] = s.c; s.pct = pct; return;
      }
      const S = secF[s.sec];
      for (let t = 0; t <= NT; t++) {
        const u = t / NT;
        pct[t] = s.c * F(s, u) + (s.beta * damp * s.Mlag[t] + (S ? S[t] : 0) + 0.5 * s.sig * damp * s.B[t]) * e[t];
      }
      pct[0] = 0; pct[NT] = s.c; s.pct = pct;
    });
  };
  for (let pass = 0; pass < 4; pass++) {
    genPaths();
    const tMax = Math.floor(0.26 * NT); let ok = 0;
    stocks.forEach(s => { let mx = 0; for (let t = 0; t <= tMax; t++) mx = Math.max(mx, Math.abs(s.pct[t])); if (mx <= 0.6) ok++; });
    M.neckOk = ok / stocks.length;
    if (M.neckOk >= 0.95) break;
    damp *= 0.85;
  }

  /* ---- price paths ---- */
  stocks.forEach(s => {
    const P = new Float64Array(NT + 1);
    for (let t = 0; t <= NT; t++) P[t] = s.c ? s.base + (s.l - s.base) * s.pct[t] / s.c : s.l * (1 + s.pct[t] / 100);
    P[NT] = s.l; s.P = P;
  });

  /* ---- levels (selected) ---- */
  stocks.forEach(s => {
    if (s.event) return;
    if (s.x) { s.L = obLevels(s.x); s.ATR = s.x.a; return; }
    const l = s.l, ATR = l * (0.012 + 0.0015 * Math.min(Math.abs(s.c), 6)); s.ATR = ATR;
    const L = {};
    if (s.side > 0) {
      L.obLo = tick(l - 0.80 * ATR); L.obHi = tick(l - 0.35 * ATR);
      L.eLo = L.obHi; L.eHi = l; L.E = tick((L.eLo + L.eHi) / 2);
      L.SL = tick(L.obLo - 0.15 * ATR); L.R = L.E - L.SL; L.T1 = tick(L.E + 1.6 * L.R); L.T2 = tick(L.E + 2.8 * L.R);
      L.oppLo = L.T2 + 0.1 * ATR; L.oppHi = L.T2 + 0.45 * ATR;
    } else {
      L.obLo = tick(l + 0.35 * ATR); L.obHi = tick(l + 0.80 * ATR);
      L.eLo = l; L.eHi = L.obLo; L.E = tick((L.eLo + L.eHi) / 2);
      L.SL = tick(L.obHi + 0.15 * ATR); L.R = L.SL - L.E; L.T1 = tick(L.E - 1.6 * L.R); L.T2 = tick(L.E - 2.8 * L.R);
      L.oppHi = L.T2 - 0.1 * ATR; L.oppLo = L.T2 - 0.45 * ATR;
    }
    L.risk = L.R / L.E * 100; L.rr = Math.abs(L.T2 - L.E) / L.R;
    s.L = L;
  });

  /* ---- last-leg sculpt ---- */
  stocks.forEach(s => {
    if (s.event) return;
    if (!s.sel) { s.ub = s.tb || 0.35; s.kOB = 18; return; }
    const L = s.L, r = rng(s.s, 'sculpt');
    const ubT = (s.ub + 0.05) * NT;
    const kMin = Math.max(16, Math.ceil((ubT + 42) / 15));
    let kOB = kMin <= 20 ? kMin + Math.floor(r() * (21 - kMin)) : 20;
    kOB = clamp(kOB, 16, 20); s.kOB = kOB;
    const tK = 15 * kOB, tS = tK - 30;
    const zl = L.obLo, zh = L.obHi, zr = zh - zl;
    const openF = s.side > 0 ? 0.7 : 0.3, closeF = s.side > 0 ? 0.3 : 0.7;
    const P0 = s.P[tS];
    const ext = s.l + s.side * 0.2 * s.ATR;
    const nz = bridge(r, NT, s.ATR * 0.10, 1);
    const scr = new Float64Array(NT + 1);
    const dipF = s.side > 0 ? 0.12 : 0.88, peakF = s.side > 0 ? 0.88 : 0.12;
    for (let t = tS; t <= NT; t++) {
      let v;
      if (t < tK) { const f = smoothstep(tS, tK, t); v = lerp(P0, zl + openF * zr, f) + nz[t] * 0.6 * Math.sin(Math.PI * f); }
      else if (t <= tK + 15) {
        const f = (t - tK) / 15; let g;
        // open -> brief poke toward the far side -> dip -> close
        if (f < 0.25) g = lerp(openF, peakF * 0.5 + openF * 0.5, f / 0.25);
        else if (f < 0.7) g = lerp(peakF * 0.5 + openF * 0.5, dipF, (f - 0.25) / 0.45);
        else g = lerp(dipF, closeF, (f - 0.7) / 0.3);
        v = zl + clamp(g, 0.06, 0.94) * zr;
      }
      else if (t <= tK + 45) { const f = (t - tK - 15) / 30; const g = 1 - Math.pow(1 - f, 2.2); v = lerp(zl + closeF * zr, ext, g) + nz[t] * 0.5 * Math.sin(Math.PI * f); }
      else { const f = (t - tK - 45) / (NT - tK - 45); v = lerp(ext, s.l, smoothstep(0, 1, f)) + nz[t] * 0.8 * Math.sin(Math.PI * f); }
      scr[t] = v;
    }
    for (let t = tS; t <= NT; t++) { const w = smoothstep(tS, tS + 10, t); s.P[t] = (1 - w) * s.P[t] + w * scr[t]; }
    s.P[NT] = s.l;
    s.pctRaw = Float64Array.from(s.pct);
    for (let t = tS; t <= NT; t++) s.pct[t] = (s.P[t] - s.base) / (s.l - s.base) * s.c;
    s.pct[NT] = s.c;
    // plume path: keep only a hint of the late OB retest (the warped axis turns it into tall spikes), and
    // draw the breakout leg as a sculpted ~2-hour slope (the warped axis turns a 19-min impulse into a cliff).
    s.pctPlume = new Float64Array(NT + 1);
    const ub = s.ub, a = Math.min(0.1, ub - 0.06), b = 0.2;
    const Fs = u => {
      if (u < ub - a) return 0.12 * smoothstep(0, ub - a, u);
      if (u < ub + b) { const x = (u - ub + a) / (a + b); return 0.12 + 0.45 * x * x * (3 - 2 * x); }
      return 0.57 + 0.43 * smoothstep(ub + b, 1, u);
    };
    s.ubPlume = ub - a; s.ubPlumeEnd = ub + b;
    for (let t = 0; t <= NT; t++) { const u = t / NT; s.pctPlume[t] = s.pctRaw[t] + s.c * (Fs(u) - F(s, u)) + 0.3 * (s.pct[t] - s.pctRaw[t]); }
    s.pctPlume[0] = 0; s.pctPlume[NT] = s.c;
  });

  /* ---- OHLC / volume / VWAP / VAP ---- */
  stocks.forEach(s => computeStockOhlc(s, Boolean(s.sel || s.x)));
  // candles (15m) for selected
  stocks.forEach(s => {
    if (!s.sel) return;
    const cs = [];
    for (let k = 0; k < 25; k++) {
      let o = s.O[15 * k + 1], c = s.C[15 * k + 15], h = -1e18, l = 1e18, v = 0;
      for (let t = 15 * k + 1; t <= 15 * k + 15; t++) { h = Math.max(h, s.H[t]); l = Math.min(l, s.Lo[t]); v += s.V[t]; }
      cs.push({ o, h, l, c, v });
    }
    s.candles = cs;
    if (!s.event) {
      // origin OB = last opposite candle before the ub impulse
      const kub = Math.floor(s.ub * NT / 15);
      let ko = -1; for (let k = kub; k >= 0; k--) { const cd = cs[k]; if (s.side > 0 ? cd.c < cd.o : cd.c > cd.o) { ko = k; break; } }
      if (ko < 0) ko = Math.max(0, kub - 1);
      s.kOrigin = ko;
      // force OB candle direction/levels exactly (open 70% close 30% for BUY)
      const cd = cs[s.kOB], zr = s.L.obHi - s.L.obLo;
      cd.o = s.L.obLo + (s.side > 0 ? 0.7 : 0.3) * zr; cd.c = s.L.obLo + (s.side > 0 ? 0.3 : 0.7) * zr;
      cd.h = Math.min(cd.h, s.L.obHi); cd.l = Math.max(cd.l, s.L.obLo);
    }
  });
  // volume-at-price
  const vap = (s, nb) => {
    const bins = new Float64Array(nb); const lo = s.dayL, hi = s.dayH, rg = hi - lo || 1;
    for (let t = 1; t <= NT; t++) {
      const a = (s.Lo[t] - lo) / rg * nb, b = (s.H[t] - lo) / rg * nb; const span = Math.max(b - a, 1e-6);
      for (let k = Math.max(0, Math.floor(a)); k <= Math.min(nb - 1, Math.floor(b)); k++) {
        const ov = Math.min(b, k + 1) - Math.max(a, k); if (ov > 0) bins[k] += s.V[t] * ov / span;
      }
    }
    let mx = 0, poc = 0; for (let k = 0; k < nb; k++) if (bins[k] > mx) { mx = bins[k]; poc = k; }
    for (let k = 0; k < nb; k++) bins[k] /= mx || 1;
    return { bins, poc, lo, hi }; // bin 0 = low price
  };
  stocks.forEach(s => { if (s.sel) { s.vap18 = vap(s, 18); s.vap24 = vap(s, 24); } });

  /* ---- OI / delta / build-up / pips ---- */
  const vols = stocks.map(s => s.volTot).sort((a, b) => b - a); const q1 = vols[Math.floor(vols.length / 4)];
  stocks.forEach(s => {
    const r = rng(s.s, 'oi');
    const rb = r();
    if (s.bu) s.bu = String(s.bu).trim().toUpperCase().replace(/\bBUILDUP$/, 'BUILD-UP');
    if (!s.bu) { if (s.side > 0) s.bu = rb < .70 ? 'LONG BUILD-UP' : 'SHORT COVERING'; else s.bu = rb < .70 ? 'SHORT BUILD-UP' : 'LONG UNWINDING'; }
    const mag = 3 + 11 * Math.min(1, Math.abs(s.c) / 3.5) + 4 * (r() - .5);
    s._oiMag = mag;
    s.delta = Math.sign(s.c) * s.w * 12000 * (0.5 + Math.abs(s.c));
  });
  const setOI = s => { s.oi = (s.bu === 'LONG BUILD-UP' || s.bu === 'SHORT BUILD-UP' || s.bu === 'LONG BUILDUP' || s.bu === 'SHORT BUILDUP') ? s._oiMag : -s._oiMag; };
  stocks.forEach(setOI);

  /* ---- picks (rule: top-3 by rank, no events, max 2 per sector) ---- */
  const pickSide = list => {
    const out = [], cnt = {};
    for (const s of list) { if (s.event) continue; if ((cnt[s.sec] || 0) >= 2) { s.secCap = true; continue; } out.push(s); cnt[s.sec] = (cnt[s.sec] || 0) + 1; if (out.length === 3) break; }
    return out;
  };
  M.buyPicks = pickSide(bulls); M.sellPicks = pickSide(bears);
  // non-pick setups: T2 anchors to structure (the next opposing pool), so R:R varies by name (2.1 – 3.4);
  // the six tickets keep the exact §3.6 levels (1 : 2.8)
  const pickSet = new Set([...M.buyPicks, ...M.sellPicks]);
  stocks.forEach(s => {
    if (!s.L || s.x || pickSet.has(s)) return;
    const L = s.L, m = 2.1 + 1.3 * rng(s.s, 'rr')(), sd = s.side;
    L.T2 = tick(L.E + sd * m * L.R); if (sd * (L.T2 - L.T1) <= 0) L.T2 = tick(L.T1 + sd * 0.4 * L.R);
    L.oppLo = sd > 0 ? L.T2 + 0.1 * s.ATR : L.T2 - 0.45 * s.ATR; L.oppHi = sd > 0 ? L.T2 + 0.45 * s.ATR : L.T2 - 0.1 * s.ATR;
    L.rr = Math.abs(L.T2 - L.E) / L.R;
  });
  M.buyPicks.forEach((s, i) => { s.pick = i + 1; if (!s.bu) s.bu = 'LONG BUILD-UP'; setOI(s); });
  M.sellPicks.forEach((s, i) => { s.pick = i + 1; if (!s.bu) s.bu = 'SHORT BUILD-UP'; setOI(s); });
  stocks.forEach(s => {
    const sec = secMap[s.sec]; const sc = sec ? sec.chg : 0;
    s.secChg = sc;
    s.pips = typeof s.flowAgree === 'number'
      ? Array.from({ length: Math.max(1, Math.min(5, s.flowTotal || 5)) }, (_, i) => i < s.flowAgree)
      : [
          Math.abs(2 * s.p - 1) >= 0.9,
          s.side > 0 ? (s.bu === 'LONG BUILD-UP' || s.bu === 'LONG BUILDUP') : (s.bu === 'SHORT BUILD-UP' || s.bu === 'SHORT BUILDUP'),
          s.vwapHold,
          Math.sign(sc) === s.side || Math.abs(s.c - sc) >= 1.5,
          s.w >= 0.9 || s.volTot >= q1,
        ];
  });

  /* ---- mosaic columns ---- */
  const colsFor = (list, picks, isBull) => {
    const sel = list.filter(s => s.sel && !s.event);
    const rest = sel.filter(s => !picks.includes(s));
    const c2 = rest.slice(0, 4), c3 = rest.slice(4, 9), c4 = rest.slice(9);
    const c1 = picks.slice();
    if (!isBull) { const ev = list.filter(s => s.sel && s.event).slice(0, 1); c1.push(...ev); }
    return { c1, c2, c3, c4 };
  };
  M.mos = { bull: colsFor(bulls, M.buyPicks, true), bear: colsFor(bears, M.sellPicks, false) };
  stocks.forEach(s => { if (!s.pctPlume) s.pctPlume = s.pct; });
  stocks.forEach(s => { if (s.x && s.x.k) obRealPath(s); });
  M.selected = stocks.filter(s => s.sel);
  return M;
}

/* ================= layout(Hd): every rect & y ================= */
const CREST2_DY = 46;
function layout(Hd, M) {
  const W = Math.max(1920, (S && S.W) || 1920);
  const G = { Hd, W };
  // text-lifted screens (S.crest2) give the index grid its own crest row, so the plume starts lower
  G.crest2 = !!S.crest2; G.T0 = 96; G.T1 = Hd - 12; G.P = (G.T1 - G.T0) / Math.max(1, M.lanes.length); G.yT = G.T0 + M.nBullAll * G.P;
  G.bandTop = 8; G.bandBot = Hd - 8;
  G.anomRow = M.mos.bear.c1.some(s => s.event);
  if (M.sideMode === "BULL") {
    G.bullH = G.bandBot - G.bandTop;
    G.yS = G.bandBot + 14;
    G.bearTop = G.bandBot + 28;
    G.bearH = 0;
  } else if (M.sideMode === "BEAR") {
    G.bullH = 0;
    G.yS = G.bandTop - 14;
    G.bearTop = G.bandTop;
    G.bearH = G.bandBot - G.bandTop;
  } else {
    G.bullH = Math.round((G.bandBot - G.bandTop - 28) * (G.anomRow ? 0.4761 : 0.5));
    G.yS = G.bandTop + G.bullH + 14; G.bearTop = G.bandTop + G.bullH + 28; G.bearH = G.bandBot - G.bearTop;
  }
  G.A = { x0: 66, x1: 590 }; G.nowX = 590; G.gateX = 690; G.lensX1 = 810; G.C = { x0: 810, x1: 1340 }; G.D = { x0: 1368, x1: W - 16 };
  G.reactor = { x: 1354, y: G.yS };
  G.cols = { c4: { x: 810, w: 94 }, c3: { x: 910, w: 114 }, c2: { x: 1030, w: 132 }, c1: { x: 1168, w: 172 } };
  // text-lifted screens: #1 keeps ~1.4x the #2/#3 height (not ~1.6x) so the lifted #2/#3 text keeps a full chip column
  const k1 = G.crest2 ? 0.41 : 0.4435, k1b = G.crest2 ? 0.37 : 0.403;
  const h1 = G.bullH > 0 ? Math.max(200, Math.round(G.bullH * k1)) : 0; let rem = Math.max(0, G.bullH - h1 - 12); const h2 = Math.round(rem * 0.512), h3 = rem - h2;
  const hA = 44, region = Math.max(0, G.bearH - (G.anomRow ? hA + 6 : 0)); const h1b = G.bearH > 0 ? Math.max(200, Math.round(G.bearH * (G.anomRow ? k1b : k1))) : 0; rem = Math.max(0, region - h1b - 12); const h2b = Math.round(rem * 0.508), h3b = rem - h2b;
  G.tk = { h1, h2, h3, h1b, h2b, h3b, hA };
  G.laneY = k => G.T0 + (k + 0.5) * G.P;
  // tiles
  G.tiles = [];
  const fillCol = (list, key, y0, H, fromTop) => {
    const col = G.cols[key]; const n = list.length; if (!n) return;
    const mx = Math.max(...list.map(s => Math.abs(s.c)));
    const wts = list.map(s => 0.6 + 0.4 * Math.abs(s.c) / mx); const sum = wts.reduce((a, b) => a + b, 0);
    const avail = H - (n - 1) * 6; let hs = wts.map(w => Math.round(avail * w / sum)); hs[hs.length - 1] += avail - hs.reduce((a, b) => a + b, 0);
    // order: bull top=strongest (list is strongest first); bear: from spine down weakest first
    const ordered = fromTop ? list.map((s, i) => [s, hs[i]]) : list.map((s, i) => [s, hs[i]]).reverse();
    let y = y0; ordered.forEach(([s, h]) => { G.tiles.push({ s, key, x: col.x, y, w: col.w, h, side: s.side }); y += h + 6; });
  };
  const mb = M.mos.bull, me = M.mos.bear;
  ['c4', 'c3', 'c2'].forEach(k => { fillCol(mb[k], k, G.bandTop, G.bullH, true); fillCol(me[k], k, G.bearTop, G.bearH, true); });
  // c1 bull
  { let y = G.bandTop; const hs = [h1, h2, h3]; mb.c1.forEach((s, i) => { G.tiles.push({ s, key: 'c1', x: 1168, y, w: 172, h: hs[i], side: 1, pick: i + 1 }); y += hs[i] + 6; }); }
  // c1 bear: from spine down #3, #2, #1, anomaly
  { const picks = me.c1.filter(s => !s.event), ev = me.c1.filter(s => s.event); const order = [[picks[0], h1b, 1], [picks[1], h2b, 2], [picks[2], h3b, 3]];
    let y = G.bearTop; order.forEach(([s, h, n]) => { if (!s) return; G.tiles.push({ s, key: 'c1', x: 1168, y, w: 172, h, side: -1, pick: n }); y += h + 6; });
    ev.forEach(s => { G.tiles.push({ s, key: 'c1', x: 1168, y, w: 172, h: hA, side: -1, event: true }); y += hA + 6; }); }
  G.tileBy = {}; G.tiles.forEach(t => { G.tileBy[t.s.s] = t; t.cy = t.y + t.h / 2; });
  // tickets row-aligned with c1 tiles
  G.tickets = G.tiles.filter(t => t.key === 'c1').map(t => ({ s: t.s, x: G.D.x0, y: t.y, w: G.D.x1 - G.D.x0, h: t.h, side: t.side, pick: t.pick, event: t.event, cy: t.cy }));
  G.ticketBy = {}; G.tickets.forEach(t => G.ticketBy[t.s.s] = t);
  // warped axis Q
  const kn = [];
  { const cv = M.lanes.map(s => s.c), pos = cv.filter(v => v > 0).sort((a, b) => b - a), neg = cv.filter(v => v <= 0).sort((a, b) => b - a);
    pos.forEach((v, i) => kn.push([v, G.T0 + (i + 0.5) * (G.yT - G.T0) / pos.length]));
    neg.forEach((v, i) => { if (i === neg.length - 1) v = Math.max(v, -4.0); kn.push([v, G.yT + (i + 0.5) * (G.T1 - G.yT) / neg.length]); }); }
  kn.push([0, G.yT]);
  // average ties
  const byV = new Map(); kn.forEach(([v, y]) => { const key = v.toFixed(4); if (!byV.has(key)) byV.set(key, [v, 0, 0]); const e = byV.get(key); e[1] += y; e[2]++; });
  let K = [...byV.values()].map(([v, ys, n]) => [v, ys / n]).sort((a, b) => b[0] - a[0]);
  // ensure monotone y
  for (let i = 1; i < K.length; i++) if (K[i][1] < K[i - 1][1]) K[i][1] = K[i - 1][1];
  G.knots = K;
  const vMax = K[0][0], vMin = K[K.length - 1][0];
  G.Q = v => {
    if (v >= vMax) return Math.max(G.T0, K[0][1] - (v - vMax) * 2);
    if (v <= vMin) return G.T1;
    let lo = 0, hi = K.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (K[mid][0] >= v) lo = mid; else hi = mid; }
    const [v0, y0] = K[lo], [v1, y1] = K[hi]; return y0 + (y1 - y0) * (v - v0) / (v1 - v0);
  };
  return G;
}
