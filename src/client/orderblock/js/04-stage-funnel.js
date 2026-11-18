/* ================= stage core ================= */
const COL = {
  bull: '#19E58C', bullHi: '#7CFFC4', bullHot: '#C9FFE9', bullDeep: '#0E7A49', bullMute: '#1E9E6E',
  bear: '#FF3B5C', bearHi: '#FF9AA8', bearHot: '#FFD3DC', bearDeep: '#A3172E', bearMute: '#C23A52',
  spine: '#E8F1FF', nifty: '#F4F7FB', wall: '#2F6BFF', vwap: '#6FA3FF', neutral: '#3A4658', amber: '#FFB020', crash: '#FF6A4D', slate: '#4A5468',
  ink: '#EEF3FA', ink2: '#9AA8BD', ink3: '#5E6C82', ink4: '#3F4B5E', hair: '#1A2433'
};
const SC = { 1: '25,229,140', '-1': '255,59,92' };
const SCHI = { 1: '124,255,196', '-1': '255,154,168' };
const SCHOT = { 1: '201,255,233', '-1': '255,211,220' };
const sideCol = (side, k = '') => COL[(side > 0 ? 'bull' : 'bear') + k];
const RAMP_A = {
  1: ramp([[0, '#05100C'], [.30, '#0A2B1F'], [.55, '#0F5E40'], [.80, '#1E9E6E'], [1, '#6FE0B4']]),
  '-1': ramp([[0, '#12060A'], [.30, '#3A0D17'], [.55, '#7E1A2C'], [.80, '#C23A52'], [1, '#F08A9C']])
};
const RAMP_C = {
  1: ramp([[0, '#0B3A2D'], [.5, '#19E58C'], [1, '#C9FFE9']]),
  '-1': ramp([[0, '#3E0C17'], [.5, '#FF3B5C'], [1, '#FFD3DC']])
};
const FONT_UI = "'Inter Tight',-apple-system,'SF Pro Display','Segoe UI',Roboto,sans-serif";
const FONT_NUM = "'JetBrains Mono','SF Mono',Menlo,Consolas,monospace";
const FONT_TK = "'Barlow Condensed','Arial Narrow','Roboto Condensed',sans-serif";

const S = { s: 1, dpr: 1, k: 1, W: 1920, Hd: 1080, tx: 1, stacked: false, reduced: false, tier3: true };
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, cls, parent, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; if (parent) parent.appendChild(e); return e; }
function css(e, o) { for (const k in o) e.style[k] = typeof o[k] === 'number' && !/opacity|zIndex/.test(k) ? o[k] + 'px' : o[k]; return e; }

/* canvas placed in stage coords; ctx draws in stage coords */
function stageCanvas(parent, x, y, w, h, cls) {
  const cv = el('canvas', 'cv' + (cls ? ' ' + cls : ''), parent);
  css(cv, { left: x, top: y, width: w, height: h });
  const k = S.k; cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
  const ctx = cv.getContext('2d'); ctx.setTransform(k, 0, 0, k, -x * k, -y * k);
  cv._x = x; cv._y = y; cv._w = w; cv._h = h;
  return { cv, ctx };
}
/* local canvas (0,0 origin) sized in css px with a scale factor */
function localCanvas(parent, w, h, scale, cls) {
  const cv = el('canvas', cls || '', parent);
  css(cv, { width: w, height: h });
  cv.width = Math.max(1, Math.round(w * scale)); cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
  cv._w = w; cv._h = h; cv._k = scale;
  return { cv, ctx };
}
let FILTER_OK = null;
function filterOk() {
  if (FILTER_OK !== null) return FILTER_OK;
  try { const c = document.createElement('canvas').getContext('2d'); c.filter = 'blur(2px)'; FILTER_OK = c.filter === 'blur(2px)'; } catch (e) { FILTER_OK = false; }
  return FILTER_OK;
}
/* returns a blurred copy (same pixel size) of a canvas */
function blurCopy(src, px) {
  const out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
  const o = out.getContext('2d');
  if (filterOk()) { o.filter = `blur(${px}px)`; o.drawImage(src, 0, 0); o.filter = 'none'; return out; }
  const f = Math.max(1, px / 1.2); const sm = document.createElement('canvas');
  sm.width = Math.max(1, Math.round(src.width / f)); sm.height = Math.max(1, Math.round(src.height / f));
  const sc = sm.getContext('2d'); sc.imageSmoothingEnabled = true; sc.imageSmoothingQuality = 'high'; sc.drawImage(src, 0, 0, sm.width, sm.height);
  o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high'; o.drawImage(sm, 0, 0, out.width, out.height);
  return out;
}
function fitFont(ctx, text, weight, family, size, minSize, maxW) {
  let fs = size; ctx.font = `${weight} ${fs}px ${family}`;
  while (fs > minSize && ctx.measureText(text).width > maxW) { fs -= 0.5; ctx.font = `${weight} ${fs}px ${family}`; }
  if (ctx.measureText(text).width <= maxW) return { fs, text };
  let t = text; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return { fs, text: t + '…' };
}
/* shrink DOM text until it fits its width */
function fitDom(e, maxW, minPx) {
  let fs = parseFloat(getComputedStyle(e).fontSize);
  let guard = 40;
  while (e.scrollWidth > maxW + 0.5 && fs > minPx && guard--) { fs -= 0.5; e.style.fontSize = fs + 'px'; }
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function glowSprite(rgb, r) {
  const c = document.createElement('canvas'); const d = Math.ceil(r * 2 * 2); c.width = c.height = d; const x = c.getContext('2d');
  const g = x.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
  g.addColorStop(0, `rgba(255,255,255,1)`); g.addColorStop(.18, `rgba(${rgb},.95)`); g.addColorStop(.45, `rgba(${rgb},.35)`); g.addColorStop(1, `rgba(${rgb},0)`);
  x.fillStyle = g; x.fillRect(0, 0, d, d); return c;
}

/* ================= warp axis: rank-quantile Q + asinh horn near zero =================
   layout() builds Q as a pure rank-quantile map; the real data has no names between −0.31 and +0.21,
   so the whole opening hour collapses onto the spine. We keep Q(knot) for every |v| beyond the horn and
   soft-max it with k·asinh(v/0.15) near zero, so ±0.1–0.3% moves fan out as a visible horn.
   Idempotent: every zone-A entry point calls it, whoever builds G. */
function warpQ(G) {
  if (!G || G._horn) return G;
  const Qr = G.Q, yT = G.yT, k = 6 * G.P, s0 = 0.15, r0 = 6;
  const smax = (a, b, r) => { if (r <= 0) return Math.max(a, b); const h = Math.max(r - Math.abs(a - b), 0) / r; return Math.max(a, b) + h * h * r / 4; };
  G.Qrank = Qr; G.hornK = k;
  G.Q = v => {
    const av = Math.abs(v); if (!(av > 1e-9)) return yT;
    const R = Math.abs(yT - Qr(v)), H = k * Math.asinh(av / s0);
    return yT - (v > 0 ? 1 : -1) * smax(R, H, r0 * smoothstep(0, 0.06, av));
  };
  G._horn = true;
  return G;
}

/* ================= market pulse: the crest is one picture of the whole market =================
   In place of the brand, NIFTY, the index grid and the clock (user request: visual, logical, the whole strip).
   Every stock is a dot at its % move on one scale (0 at the glowing axis): bullish dots stack up from the
   line, bearish dots hang below it, and the line sits at the breadth split (more bullish names, more room above).
   Big movers streak away from zero; contenders glow; the six picks are ringed; event names are amber. The
   only words: the scale's ends, the labelled counts, and two market callouts (the leading and the lagging
   sector) whose leaders drop to that sector's average on the scale. Hover a dot to light that stock across the
   page, a callout to light its whole sector. */
let PULSE = null;
const OB_TREND = {
  dn: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 3.5l3.5 3.5 2.2-2.2L11 9"/><path d="M11 5.6V9H7.6"/></svg>',
  up: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 8.5l3.5-3.5 2.2 2.2L11 3"/><path d="M7.6 3H11v3.4"/></svg>'
};
const OB_TRI = {
  up: '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M4 1.2l3.2 5.4H.8z"/></svg>',
  dn: '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M4 6.8L.8 1.4h6.4z"/></svg>'
};
function obPulseModel(M, w, h, cw, top) {
  top = top || 0;                                            // phone: the caption band the dots keep clear of
  const PW = w - cw, pad = 22, nb = M.nBullAll, nr = M.nBearAll;
  const a = M.stocks.map(s => Math.abs(s.c)).sort((x, y) => x - y);
  const R = [2, 3, 4, 5, 6, 8].find(r => r >= (a[Math.floor(a.length * 0.97)] || 0)) || 8;   // 97% of names on the scale
  const ys = Math.round(top + 2 + (h - top - 4) * clamp(nb / Math.max(1, nb + nr), 0.3, 0.7));
  const x0 = pad, x1 = PW - pad, xOf = v => x0 + (clamp(v, -R, R) + R) / (2 * R) * (x1 - x0);
  // beeswarm: each dot sits as close to the line as it can on its own side; dots shrink until all of them fit
  const dots = M.stocks.map(s => ({ s, x: xOf(s.c) })).sort((p, q) => p.x - q.x);
  let rs = 1;
  const rad = s => (s.pick ? 3.3 : s.sel ? 2.9 : 1.7 + 0.75 * Math.sqrt(s.w || 1)) * rs;
  const swarm = () => {
    const L = { 1: [], '-1': [] };
    dots.forEach(d => {
      const s = d.s, r = rad(s), Ls = L[s.side]; let off = r + 1.4;
      for (let g = 0; g < 600; g++) {
        const y = ys - s.side * off; let hit = false;
        for (let i = Ls.length - 1; i >= 0; i--) { const o = Ls[i], dx = d.x - o.x; if (dx > 8) break; const dy = o.y - y, rr = o.r + r + 0.5 * rs; if (dx * dx + dy * dy < rr * rr) { hit = true; break; } }
        if (!hit) break; off += 0.4;
      }
      d.r = r; d.y = ys - s.side * off; Ls.push(d);
    });
  };
  swarm(); for (let i = 0; i < 16 && !dots.every(d => d.y - d.r >= top + 0.5 && d.y + d.r <= h - 0.5); i++) { rs *= 0.94; swarm(); }
  return { R, ys, x0, x1, xOf, dots, PW, nb, nr };
}
/* the picture at build progress f (0 → 1): dots burst out of the zero axis to their % move, counts count up */
function obPulsePaint(Z, f) {
  const { P, w, h, k } = Z, x = Z.sctx, xz = P.xOf(0), ease = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, Z.st.width, Z.st.height); x.setTransform(k, 0, 0, k, 0, 0);
  const mean = side => { const l = P.dots.filter(d => d.s.side === side); return l.length ? l.reduce((a, d) => a + d.x, 0) / l.length : xz; };
  const glow = (cx, cy, rx, ry, rgb) => { x.save(); x.translate(cx, cy); x.scale(rx / 40, ry / 40); const g = x.createRadialGradient(0, 0, 0, 0, 0, 40); g.addColorStop(0, `rgba(${rgb},.10)`); g.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = g; x.fillRect(-40, -40, 80, 80); x.restore(); };
  glow(mean(1), P.ys * 0.55, 190, P.ys * 0.9, SC[1]); glow(mean(-1), P.ys + (h - P.ys) * 0.45, 190, (h - P.ys) * 0.9, SC[-1]);
  // the line (breadth split) with a tick per step of the scale, and the zero axis
  x.fillStyle = 'rgba(232,241,255,.34)'; x.fillRect(P.x0, P.ys - 0.5, P.x1 - P.x0, 1);
  const stp = P.R > 4 ? 2 : 1;
  for (let v = -P.R; v <= P.R; v += stp) if (v) { x.fillStyle = 'rgba(154,168,189,.5)'; x.fillRect(Math.round(P.xOf(v)), P.ys - 2.5, 1, 5); }
  const zg = x.createLinearGradient(0, 0, 0, h); zg.addColorStop(0, 'rgba(232,241,255,0)'); zg.addColorStop(.5, 'rgba(232,241,255,.85)'); zg.addColorStop(1, 'rgba(232,241,255,0)');
  x.fillStyle = zg; x.fillRect(xz - 0.6, 0, 1.2, h);
  const la = clamp((f - 0.3) / 0.5, 0, 1);
  x.globalAlpha = la; x.font = `500 ${8.5 * Z.tx}px ${FONT_NUM}`; x.fillStyle = COL.ink3; x.textBaseline = 'middle';
  x.textAlign = 'right'; x.fillText(MINUS + P.R + '%', P.x0 - 3, P.ys); x.textAlign = 'left'; x.fillText('+' + P.R + '%', P.x1 + 3, P.ys);
  x.globalAlpha = 1;
  // callout leaders (behind the dots): from each callout's icon down to its sector's average on the scale
  if (la > 0) (Z.anchors || []).forEach(a => {
    x.save(); x.globalAlpha = la * 0.9; x.setLineDash([1.5, 2.5]); x.strokeStyle = `rgba(${SC[a.side]},.6)`; x.lineWidth = 1;
    const ix = Math.round(a.ix) + 0.5, ax = Math.round(a.ax) + 0.5, y0 = a.y0 != null ? a.y0 : 15, yj = a.yj != null ? a.yj : 18;
    x.beginPath(); x.moveTo(ix, y0); if (Math.abs(ix - ax) > 1) { x.lineTo(ix, yj); x.lineTo(ax, yj); } x.lineTo(ax, P.ys - 3); x.stroke(); x.restore();
  });
  // dots (and the big movers' streaks), herd first, contenders over them, picks on top
  const at = d => xz + (d.x - xz) * ease(f * 1.25 - 0.25 * Math.min(1, Math.abs(d.s.c) / P.R));
  P.dots.forEach(d => {
    const s = d.s; if (Math.abs(s.c) < 1 || s.event) return;
    const cx = at(d), L = Math.min(46, 0.4 * Math.abs(cx - xz)); if (L < 1) return;
    const dir = Math.sign(s.c), xa = cx - dir * L, rgb = s.sel ? SCHI[s.side] : SC[s.side], g = x.createLinearGradient(xa, 0, cx, 0);
    g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(1, `rgba(${rgb},${s.sel ? .55 : .3})`); x.fillStyle = g; x.fillRect(Math.min(xa, cx), d.y - d.r * 0.55, L, d.r * 1.1);
  });
  const dot = d => {
    const s = d.s, sd = s.side, cx = at(d);
    if (s.event) { x.fillStyle = 'rgba(255,176,32,.95)'; x.beginPath(); x.arc(cx, d.y, d.r, 0, 7); x.fill(); return; }
    x.save();
    if (s.pick) { x.shadowColor = `rgba(${SC[sd]},1)`; x.shadowBlur = 8 * k; x.fillStyle = '#fff'; }
    else if (s.sel) { x.shadowColor = `rgba(${SC[sd]},.9)`; x.shadowBlur = 5 * k; x.fillStyle = `rgb(${SCHI[sd]})`; }
    else { x.shadowColor = `rgba(${SC[sd]},.5)`; x.shadowBlur = 3 * k; x.fillStyle = `rgba(${SC[sd]},${0.42 + 0.3 * Math.min(1, Math.abs(s.c) / P.R)})`; }
    x.beginPath(); x.arc(cx, d.y, d.r, 0, 7); x.fill(); x.restore();
    if (s.pick) { x.strokeStyle = `rgba(${SCHI[sd]},.9)`; x.lineWidth = 1; x.beginPath(); x.arc(cx, d.y, d.r + 2.2, 0, 7); x.stroke(); }
  };
  P.dots.forEach(d => { if (!d.s.sel) dot(d); }); P.dots.forEach(d => { if (d.s.sel && !d.s.pick) dot(d); }); P.dots.forEach(d => { if (d.s.pick) dot(d); });
  // each callout's sector average: a small diamond on the line
  if (la > 0) (Z.anchors || []).forEach(a => {
    x.save(); x.globalAlpha = la; x.fillStyle = `rgb(${SCHI[a.side]})`; x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(a.ax, P.ys - 3.4); x.lineTo(a.ax + 3.4, P.ys); x.lineTo(a.ax, P.ys + 3.4); x.lineTo(a.ax - 3.4, P.ys); x.closePath(); x.fill(); x.stroke(); x.restore();
  });
  (Z.tags || []).forEach(t => { t.style.opacity = clamp((f - 0.65) / 0.35, 0, 1).toFixed(3); });
  // the counts count up with the build
  const n = v => String(Math.round(v * clamp(f * 1.6, 0, 1)));
  if (Z.cb) { Z.cb.textContent = n(P.nb); Z.cr.textContent = n(P.nr); }
  Z.f = f;
}
function obPulse(box, M, w, h, k, stacked, tx) {
  box.innerHTML = '';
  if (stacked) return obPulseStack(box, M, w, h, k, tx);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // the counts, labelled and top-aligned with the callouts; their width sets where the plot ends
  const cnt = el('div', 'pcount', box, `<div class="pc b"><span class="k">${OB_TRI.up}BULLISH</span><b>${M.nBullAll}</b></div><div class="pc r"><span class="k">${OB_TRI.dn}BEARISH</span><b>${M.nBearAll}</b></div>`);
  const P = obPulseModel(M, w, h, Math.ceil(cnt.offsetWidth) + 12), { cv, ctx } = localCanvas(box, w, h, k, 'pcv');
  box.insertBefore(cv, box.firstChild);                                                // the picture under the words
  const st = document.createElement('canvas'); st.width = cv.width; st.height = cv.height;
  const Z = PULSE = { box, cv, ctx, st, sctx: st.getContext('2d'), P, w, h, k, stacked, tx: tx || 1, mark: null, t0: 0, cb: cnt.querySelector('.b b'), cr: cnt.querySelector('.r b') };
  css(el('i', 'pz', box), { left: P.xOf(0), top: P.ys });                              // zero: where every stock started the day
  // market callouts: the lagging sector over the falling side, the leading sector over the rising side; each icon
  // faces the zero axis and its leader drops to that sector's average on the scale
  const secs = (M.D.sectors || []).filter(x => x.n > 0).slice().sort((a, b) => b.chg - a.chg);
  const tag = (x, lead) => {
    const up = x.chg >= 0, ic = up ? OB_TREND.up : OB_TREND.dn, words = `<span class="k">${lead ? 'LEADING' : 'LAGGING'} SECTOR</span><b>${esc(x.sec)}</b><span class="v">${pctStr(x.chg)}</span>`;
    const t = el('div', 'ptag ' + (up ? 'up' : 'dn'), box, lead ? ic + words : words + ic); t.dataset.sec = x.sec;
    return { t, x, ax: P.xOf(x.chg), side: up ? 1 : -1 };
  };
  let H = secs.length ? tag(secs[0], true) : null, L = secs.length > 1 ? tag(secs[secs.length - 1], false) : null;
  const xz = P.xOf(0);
  const place = () => {
    let bad = false;
    if (L) { const wd = L.t.offsetWidth; let left = Math.min(L.ax + 6 - wd, xz - 10 - wd); if (left < 0) { left = 0; bad = true; } css(L.t, { left, top: 1 }); L.ix = left + wd - 6; }
    if (H) { const wd = H.t.offsetWidth; let left = Math.max(H.ax - 6, xz + 10); if (left + wd > P.PW) { left = Math.max(0, P.PW - wd); bad = true; } css(H.t, { left, top: 1 }); H.ix = left + 6; }
    return bad || !!(L && H && L.t.offsetLeft + L.t.offsetWidth + 8 > H.t.offsetLeft);
  };
  if (place()) { box.classList.add('tight'); if (place() && L) { L.t.remove(); L = null; place(); } }
  Z.tags = [H, L].filter(Boolean).map(o => o.t); Z.anchors = [H, L].filter(Boolean).map(o => ({ ix: o.ix, ax: o.ax, side: o.side }));
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${M.stocks.length} stocks by % move: ${P.nb} bullish above the line, ${P.nr} bearish below` +
    (H ? `; leading sector ${H.x.sec} ${pctStr(H.x.chg)}` : '') + (L ? `; lagging sector ${L.x.sec} ${pctStr(L.x.chg)}` : ''));
  obPulsePaint(Z, 1);
  requestAnimationFrame(t => obPulseFrame(Z, t));
}
/* phone: the same picture in the stacked page. Both sector callouts always stay (user request: never dropped): on one
   caption row, pushed apart inside the plot when they meet; else each on its own row and the crest grows by a row.
   The dots keep below the caption band, so a callout never covers a stock. */
function obPulseStack(box, M, w, h, k, tx) {
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cnt = el('div', 'pcount', box, `<div class="pc b"><span class="k">${OB_TRI.up}BULLISH</span><b>${M.nBullAll}</b></div><div class="pc r"><span class="k">${OB_TRI.dn}BEARISH</span><b>${M.nBearAll}</b></div>`);
  const cw = Math.ceil(cnt.offsetWidth) + 12;
  let P = obPulseModel(M, w, h, cw);
  const secs = (M.D.sectors || []).filter(x => x.n > 0).slice().sort((a, b) => b.chg - a.chg);
  const tag = (x, lead) => {
    const up = x.chg >= 0, ic = up ? OB_TREND.up : OB_TREND.dn, words = `<span class="k">${lead ? 'LEADING' : 'LAGGING'} SECTOR</span><b>${esc(x.sec)}</b><span class="v">${pctStr(x.chg)}</span>`;
    const t = el('div', 'ptag ' + (up ? 'up' : 'dn'), box, lead ? ic + words : words + ic); t.dataset.sec = x.sec;
    return { t, x, ax: P.xOf(x.chg), side: up ? 1 : -1, lead };
  };
  const H = secs.length ? tag(secs[0], true) : null, L = secs.length > 1 ? tag(secs[secs.length - 1], false) : null;
  const tags = [H, L].filter(Boolean), xz = P.xOf(0), PW = P.PW, RH = 17;
  const put = (o, left, row) => { o.w = o.t.offsetWidth; o.left = clamp(left, 0, Math.max(0, PW - o.w)); o.row = row; css(o.t, { left: o.left, top: 1 + row * RH }); o.ix = o.lead ? o.left + 6 : o.left + o.w - 6; };
  const nat = o => o.lead ? Math.max(o.ax - 6, xz + 10) : Math.min(o.ax + 6 - o.t.offsetWidth, xz - 10 - o.t.offsetWidth);
  const oneRow = () => {
    tags.forEach(o => put(o, nat(o), 0));
    if (!(H && L) || L.left + L.w + 8 <= H.left) return true;
    if (L.w + 8 + H.w > PW) return false;
    const hl = Math.min(PW - H.w, Math.max(H.left, L.left + L.w + 8)); put(H, hl, 0); put(L, Math.min(L.left, H.left - 8 - L.w), 0);
    return L.left + L.w + 8 <= H.left + 0.5;
  };
  const twoRows = () => {
    // the upper callout's leader runs down through the lower row: keep it clear of the lower callout
    const clear = (up, dn) => !(up.ix > dn.left - 4 && up.ix < dn.left + dn.w + 4);
    for (const [up, dn] of [[H, L], [L, H]]) { put(up, nat(up), 0); put(dn, nat(dn), 1); if (clear(up, dn)) return; }
    put(H, nat(H), 0); put(L, nat(L), 1);
    const a = H.ix - 8 - L.w, b = H.ix + 8; put(L, a >= 0 ? a : b, 1);
  };
  // one caption row (full words, then the compact form the desktop uses), else two rows (full words, then compact)
  let rows = 1;
  if (!oneRow()) { box.classList.add('tight'); if (!oneRow()) { box.classList.remove('tight'); rows = 2; twoRows(); if (tags.some(o => o.w > PW)) { box.classList.add('tight'); twoRows(); } } }
  const capH = rows * RH + 2;
  if (rows === 2) h += RH;
  box.style.height = h + 'px';
  P = obPulseModel(M, w, h, cw, capH + 3);
  const { cv, ctx } = localCanvas(box, w, h, k, 'pcv');
  box.insertBefore(cv, box.firstChild);
  const st = document.createElement('canvas'); st.width = cv.width; st.height = cv.height;
  const Z = PULSE = { box, cv, ctx, st, sctx: st.getContext('2d'), P, w, h, k, stacked: true, tx: tx || 1, mark: null, t0: 0, rows, cb: cnt.querySelector('.b b'), cr: cnt.querySelector('.r b') };
  css(el('i', 'pz', box), { left: P.xOf(0), top: P.ys });
  Z.tags = tags.map(o => o.t); Z.anchors = tags.map(o => ({ ix: o.ix, ax: o.ax, side: o.side, y0: o.row * RH + 15, yj: capH }));
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `${M.stocks.length} stocks by % move: ${P.nb} bullish above the line, ${P.nr} bearish below` +
    (H ? `; leading sector ${H.x.sec} ${pctStr(H.x.chg)}` : '') + (L ? `; lagging sector ${L.x.sec} ${pctStr(L.x.chg)}` : ''));
  obPulsePaint(Z, 1);
  requestAnimationFrame(t => obPulseFrame(Z, t));
  return Z;
}
function ensurePulseSweepGrad(Z, ctx) {
  if (Z.sweepGrad) return Z.sweepGrad;
  const g = ctx.createLinearGradient(0, 0, 50, 0);
  g.addColorStop(0, 'rgba(232,241,255,0)');
  g.addColorStop(1, 'rgba(232,241,255,0.9)');
  Z.sweepGrad = g;
  return g;
}
/* the live layer: the picks' rings breathe, a light runs the line, the brushed stock is ringed */
function obPulseRenderFrame(Z, now) {
  const { ctx, P, k } = Z, T = now / 1000;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, Z.cv.width, Z.cv.height); ctx.drawImage(Z.st, 0, 0);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const animOn = !(FX && (FX.userPaused || FX.winBlurred || FX.idleSleeping || S.reduced));
  if (Z.f >= 1 && animOn) {
    P.dots.forEach((d, i) => {
      if (!d.s.pick) return; const q = (T / 2.6 + i * 0.37) % 1;
      ctx.strokeStyle = `rgba(${SCHI[d.s.side]},${(0.7 * (1 - q)).toFixed(3)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(d.x, d.y, d.r + 2 + 9 * q, 0, 7); ctx.stroke();
    });
    const q = (T / 6.5) % 1;
    if (q < 0.7) {
      const px = P.x0 + (P.x1 - P.x0) * q / 0.7;
      ctx.save(); ctx.translate(px - 50, 0); ctx.globalAlpha = Math.sin(Math.PI * q / 0.7);
      ctx.fillStyle = ensurePulseSweepGrad(Z, ctx); ctx.fillRect(0, P.ys - 1, 50, 2); ctx.restore();
    }
  }
  if (Z.mark) P.dots.forEach(d => {
    if (!Z.mark.has(d.s.s)) return;
    ctx.strokeStyle = `rgba(${SC[d.s.side]},.42)`; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r + 2.4, 0, 7); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r + 2.4, 0, 7); ctx.stroke();
  });
  Z.dirty = false;
}
function obPulseFrame(Z, now) {
  if (PULSE !== Z || !Z.cv.isConnected) return;
  const paused = Z.off || document.hidden || (FX && (FX.userPaused || FX.winBlurred || FX.idleSleeping)) || S.reduced;
  if (paused) {
    if (Z.dirty) obPulseRenderFrame(Z, now);
    Z.halt = true;
    return;
  }
  if (!Z.stacked && typeof FX !== 'undefined' && FX.running && FX.ambient) {
    Z.halt = true;
    if (Z.dirty || !Z.last || now - Z.last >= 50) {
      Z.last = now;
      obPulseRenderFrame(Z, now);
    }
    return;
  }
  requestAnimationFrame(t => obPulseFrame(Z, t));
  if (Z.last && now - Z.last < 50 && !Z.dirty) return;
  Z.last = now;
  obPulseRenderFrame(Z, now);
}
function obPulseWake(Z) {
  if (!Z || Z.off || PULSE !== Z) return;
  const paused = document.hidden || (FX && (FX.userPaused || FX.winBlurred || FX.idleSleeping)) || S.reduced;
  if (!paused && !Z.stacked && typeof FX !== 'undefined' && FX.running && FX.ambient) {
    if (Z.dirty) obPulseRenderFrame(Z, performance.now());
    return;
  }
  if (Z.halt && !paused) {
    Z.halt = false; Z.last = 0;
    requestAnimationFrame(t => obPulseFrame(Z, t));
  } else if (Z.dirty) {
    obPulseRenderFrame(Z, performance.now());
  }
}
/* build show: f = 0 → 1 with the plume replay (the phone's section intro too) */
function obPulseDraw(f) {
  const Z = PULSE; if (!Z) return;
  obPulsePaint(Z, f);
}
/* hover: the dot nearest the pointer is the stock to brush */
function obPulseHit(box, e) {
  const Z = PULSE; if (!Z || Z.box !== box) return null;
  const tg = e.target && e.target.closest && e.target.closest('.ptag'); if (tg && tg.dataset.sec) return { kind: 'sector', sec: tg.dataset.sec };
  const r = box.getBoundingClientRect(), sc = r.width / Z.w, mx = (e.clientX - r.left) / sc, my = (e.clientY - r.top) / sc;
  let best = null, bd = Z.stacked ? 18 : 9;                                         // a finger needs a wider reach
  Z.P.dots.forEach(d => { const dd = Math.hypot(d.x - mx, d.y - my) - d.r; if (dd < bd) { bd = dd; best = d.s; } });
  return best ? { kind: 'stock', sym: best.s } : null;
}
/* whatever the page is brushing is ringed here: a stock's dot, or every dot of a sector */
function obPulseMark(h) {
  const Z = PULSE; if (!Z) return;
  Z.mark = !h ? null : h.kind === 'stock' ? new Set([h.sym]) : h.kind === 'sector' ? new Set(M.stocks.filter(s => s.sec === h.sec).map(s => s.s)) : null;
  Z.dirty = true;
  if (Z.halt && Z.cv && Z.cv.isConnected) obPulseRenderFrame(Z, performance.now());
}

/* ================= crest ================= */
function buildCrest(M, G, root) {
  warpQ(G);
  root.innerHTML = '';
  // the whole crest is one picture of the market: every stock at its % move (no brand, no clock)
  const pz = el('div', 'blk pulse fade0', root);
  css(pz, { left: 24, top: 12, width: 672, height: 82 });
  obPulse(pz, M, 672, 82, S.k, false, S.crest2 ? Math.min(S.tx, 1.3) : Math.min(S.tx, 1.08));
}
/* shrink the grid / clock (via --gs / --cs) until each sits inside its slot; robust to any --tx/--txc */
function fitCrest(g, c) {
  if (!g || !c) return;
  const GX0 = g.offsetLeft, CX = c.offsetLeft, CR = 630, GR = S.crest2 ? 570 : CX - 8;
  let gs = 1; g.style.setProperty('--gs', gs);
  for (let i = 0; i < 30 && GX0 + g.offsetWidth > GR && gs > 0.74; i++) { gs -= 0.02; g.style.setProperty('--gs', gs.toFixed(2)); }
  let cs = 1; c.style.setProperty('--cs', cs);
  for (let i = 0; i < 30 && CX + c.offsetWidth > CR && cs > 0.74; i++) { cs -= 0.02; c.style.setProperty('--cs', cs.toFixed(2)); }
}

/* ================= axis + thermometer ================= */
function drawAxis(M, G, wrap) {
  warpQ(G);
  const { cv, ctx } = stageCanvas(wrap, 0, G.T0 - 12, 66, G.T1 - G.T0 + 24, 'dimmable');
  cv.id = 'cvAxis';
  // thermometer
  const x = 24, w = 6;
  ctx.save(); roundRect(ctx, x, G.T0, w, G.T1 - G.T0, 3); ctx.clip();
  ctx.fillStyle = 'rgba(25,229,140,.55)'; ctx.fillRect(x, G.T0, w, G.yT - G.T0);
  ctx.fillStyle = 'rgba(255,59,92,.55)'; ctx.fillRect(x, G.yT, w, G.T1 - G.yT);
  ctx.fillStyle = 'rgba(124,255,196,.8)'; ctx.fillRect(x + w - 1, G.T0, 1, G.yT - G.T0);
  ctx.fillStyle = 'rgba(255,154,168,.8)'; ctx.fillRect(x + w - 1, G.yT, 1, G.T1 - G.yT);
  ctx.restore();
  ctx.fillStyle = '#fff'; ctx.fillRect(x - 2, G.yT - 1.5, w + 4, 3);
  if (S.noText) return cv;
  // labels — honest: each sits at Q(value) (the horn included), collision-dodged, leader back to its true y
  const vals = [5, 3, 2, 1, 0.5, 0.2, 0, -0.2, -0.5, -0.75, -1, -1.25, -1.5, -2, -3];
  const items = vals.map(v => ({ v, y: G.Q(v), t: v === 0 ? '0' : (v > 0 ? '+' : MINUS) + String(Math.abs(v)) }));
  let fs = 9 * S.tx; ctx.font = `500 ${fs}px ${FONT_NUM}`;
  while (fs > 8 && ctx.measureText(MINUS + '1.25').width > 27) { fs -= 0.25; ctx.font = `500 ${fs}px ${FONT_NUM}`; }
  const gap = Math.max(11, fs + 1.5);
  for (let it = 0; it < 40; it++) { for (let i = 1; i < items.length; i++) { const d = items[i].y - items[i - 1].y; if (d < gap) { const p = (gap - d) / 2; items[i - 1].y -= p; items[i].y += p; } } }
  items.forEach(i => { i.y = clamp(i.y, G.T0 - 4, G.T1 + 4); });
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  items.forEach(i => {
    const minor = Math.abs(i.v) === 0.2;
    ctx.fillStyle = i.v === 0 ? '#C9D4E5' : minor ? 'rgba(94,108,130,.8)' : COL.ink3; ctx.fillText(i.t, 58, i.y);
    ctx.strokeStyle = 'rgba(94,108,130,.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(60, i.y); ctx.lineTo(62, i.y); ctx.lineTo(66, G.Q(i.v)); ctx.stroke();
  });
  return cv;
}

/* ================= plume ================= */
function drawPlume(M, G, wrap) {
  warpQ(G);
  const X0 = 60, Y0 = G.T0 - 10, W = 540, H = G.T1 - G.T0 + 40;
  const { cv, ctx } = stageCanvas(wrap, X0, Y0, W, H, 'dimmable clip');
  cv.id = 'cvPlume';
  const NC = 125, NR = M.lanes.length, cw = 524 / NC, P = G.P, T0 = G.T0, yT = G.yT;
  const xOfT = t => 66 + t / NT * 524;
  const xOfC = c => 66 + (c + 1) * cw;
  // accumulate
  const I = []; for (let c = 0; c < NC; c++) I.push(new Float32Array(NR));
  const crowd = new Float32Array(NC);               // how many names still sit inside the horn
  const hornR = G.hornK * Math.asinh(0.45 / 0.15);  // horn half-height in px
  const prevRow = new Float32Array(M.lanes.length).fill(-1);
  M.lanes.forEach((s, si) => {
    for (let c = 0; c < NC; c++) {
      const pct = s.pctPlume[3 * c + 3]; const yy = G.Q(pct); const r = (yy - T0) / P - 0.5;
      if (Math.abs(yy - yT) < hornR) crowd[c]++;
      const w = 0.3 + 0.7 * Math.min(1, Math.abs(pct) / 1.6);
      const r0 = Math.floor(r), f = r - r0;
      if (r0 >= 0 && r0 < NR) I[c][r0] += w * (1 - f);
      if (r0 + 1 >= 0 && r0 + 1 < NR) I[c][r0 + 1] += w * f;
      const pr = prevRow[si];
      if (pr >= 0) { const a = Math.min(pr, r), b = Math.max(pr, r); for (let k = Math.ceil(a) + 1; k < Math.floor(b); k++) if (k >= 0 && k < NR) I[c][k] += 0.12; }
      prevRow[si] = r;
    }
  });
  for (let c = 1; c < NC; c++) for (let k = 0; k < NR; k++) I[c][k] = Math.max(I[c][k], 0.88 * I[c - 1][k]);
  // heat to offscreen
  const heat = document.createElement('canvas'); heat.width = cv.width; heat.height = cv.height;
  const h = heat.getContext('2d'); h.setTransform(S.k, 0, 0, S.k, -X0 * S.k, -Y0 * S.k);
  // horn envelope (volumetric under-glow): per-column 6th/94th percentile of Q(pct), smoothed.
  {
    const up = [], dn = [];
    for (let c = 0; c < NC; c++) {
      const ys = M.lanes.map(s => G.Q(s.pctPlume[3 * c + 3])).sort((a, b) => a - b);
      up.push(Math.min(yT - 1, ys[Math.floor(ys.length * 0.08)])); dn.push(Math.max(yT + 1, ys[Math.floor(ys.length * 0.90)]));
    }
    const sm = a => a.map((v, i) => { let t = 0, n = 0; for (let j = -4; j <= 4; j++) { const k = i + j; if (k >= 0 && k < a.length) { t += a[k]; n++; } } return t / n; });
    const U = sm(up), Dn = sm(dn);
    // lobes fade out as the horn dissolves into the day's plume (~11:45)
    const lobe = (arr, side) => {
      const rgb = side > 0 ? '38,190,128' : '214,64,92';
      const g = h.createLinearGradient(66, 0, 66 + 524, 0);
      g.addColorStop(0, `rgba(${rgb},.30)`); g.addColorStop(0.14, `rgba(${rgb},.18)`); g.addColorStop(0.34, `rgba(${rgb},.06)`); g.addColorStop(0.55, `rgba(${rgb},0)`);
      h.fillStyle = g; h.beginPath(); h.moveTo(66, yT);
      for (let c = 0; c < NC; c++) h.lineTo(xOfC(c), arr[c]);
      h.lineTo(66 + 524, yT); h.closePath(); h.fill();
      // luminous rim: the horn's silhouette, brightest at the mouth
      const ge = h.createLinearGradient(66, 0, 66 + 524, 0);
      ge.addColorStop(0, `rgba(${rgb},.55)`); ge.addColorStop(0.18, `rgba(${rgb},.32)`); ge.addColorStop(0.4, `rgba(${rgb},0)`);
      h.strokeStyle = ge; h.lineWidth = 1; h.beginPath(); h.moveTo(66, yT);
      for (let c = 0; c < NC; c++) h.lineTo(xOfC(c), arr[c]);
      h.stroke();
    };
    h.save(); h.globalCompositeOperation = 'lighter'; lobe(U, 1); lobe(Dn, -1);
    // white-hot core that narrows from the beacon
    const gc = h.createLinearGradient(66, 0, 300, 0); gc.addColorStop(0, 'rgba(232,241,255,.30)'); gc.addColorStop(1, 'rgba(232,241,255,0)');
    h.fillStyle = gc; h.beginPath(); h.moveTo(66, yT - 2); h.quadraticCurveTo(160, yT - 1.2, 300, yT - .4); h.lineTo(300, yT + .4); h.quadraticCurveTo(160, yT + 1.2, 66, yT + 2); h.closePath(); h.fill();
    h.restore();
    M.hornEnv = { up: U, dn: Dn };
  }
  const neutral = hexRgb(COL.neutral);
  const cellH = Math.max(1.2, P - 1.4);
  for (let c = 0; c < NC; c++) {
    const u = c / (NC - 1);
    const ta = 0.30 + 0.70 * Math.pow(u, 1.3);
    // crowd-aware tone map: when most of the market is packed into the horn the cells stay faint heat, not a blob
    const tau = 0.9 * Math.max(1, Math.pow(crowd[c] / 26, 0.85));
    for (let k = 0; k < NR; k++) {
      const v = 1 - Math.exp(-I[c][k] / tau); if (v < 0.03) continue;
      const side = k < M.nBullAll ? 1 : -1; let col = RAMP_A[side](v);
      if (Math.abs(k + 0.5 - M.nBullAll) <= 1.5) col = mixRgb(col, neutral, 0.6);
      h.fillStyle = rgbStr(col, ta * (0.12 + 0.88 * v * v) * 0.84);
      h.fillRect(66 + c * cw, T0 + k * P + (P - cellH) / 2, cw - 1, cellH);
    }
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(heat, 0, 0);
  const glow = blurCopy(heat, 6 * S.k);
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35; ctx.drawImage(glow, 0, 0);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // rack focus (blur left part)
  const rf = blurCopy(heat, 2 * S.k); const rc = rf.getContext('2d');
  rc.globalCompositeOperation = 'destination-in';
  const gx0 = (66 - X0) * S.k, gx1 = (260 - X0) * S.k; const gr = rc.createLinearGradient(gx0, 0, gx1, 0); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  rc.fillStyle = gr; rc.fillRect(0, 0, rf.width, rf.height);
  ctx.globalAlpha = 0.9; ctx.drawImage(rf, 0, 0); ctx.globalAlpha = 1;
  ctx.restore();

  // SMC origin boxes (+ extension bands to NOW)
  M.selected.forEach(s => {
    if (s.event) return; const side = s.side; const pk = !!s.pick;
    const cb = Math.floor((s.ubPlume || s.ub) * NC);
    let lo = 1e9, hi = -1e9; for (let t = 3 * (cb - 2); t <= 3 * cb; t++) { const y = G.Q(s.pctPlume[Math.max(0, t)]); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    if (hi - lo < 5) { const m = (hi + lo) / 2; lo = m - 2.5; hi = m + 2.5; }
    if (hi - lo > 12) { const m = side > 0 ? hi - 6 : lo + 6; lo = m - 6; hi = m + 6; } // a zone, never a pillar
    const x0 = 66 + (cb - 2) * cw, x1 = 66 + cb * cw; const rgb = SC[side];
    ctx.fillStyle = `rgba(${rgb},${pk ? .08 : .04})`; ctx.fillRect(x1, lo, 590 - x1, hi - lo);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = `rgba(${rgb},${pk ? .45 : .25})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, Math.round(lo) + .5); ctx.lineTo(590, Math.round(lo) + .5); ctx.moveTo(x1, Math.round(hi) - .5); ctx.lineTo(590, Math.round(hi) - .5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = `rgba(${rgb},.14)`; ctx.fillRect(x0, lo, x1 - x0, hi - lo);
    ctx.strokeStyle = `rgba(${rgb},.45)`; ctx.strokeRect(Math.round(x0) + .5, Math.round(lo) + .5, Math.round(x1 - x0) - 1, Math.max(1, Math.round(hi - lo) - 1));
  });
  // selected threads
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineWidth = 1; ctx.lineJoin = 'round';
  M.selected.forEach(s => {
    if (s.event) return; const rgb = SC[s.side]; const cb = Math.floor((s.ubPlume || s.ub) * NC);
    const raw = [G.yT]; for (let c = 0; c < NC; c++) raw.push(G.Q(s.pctPlume[3 * c + 3]));
    const pts = raw.map((y, i) => { if (i === 0 || i === raw.length - 1) return [i ? xOfC(i - 1) : 66, y]; const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)]; return [xOfC(i - 1), (a + 2 * y + b) / 4]; });
    // alpha rises through the breakout leg (dim while it falls/rises through the crowd, bright once it has left it),
    // drawn as runs of quantised alpha so joints never double up under 'lighter'
    const aPre = .13, aPost = s.pick ? .62 : .36, ce = Math.max(cb + 2, Math.floor((s.ubPlumeEnd || s.ub + .02) * NC));
    const aAt = i => i <= cb + 1 ? aPre : aPre + (aPost - aPre) * Math.pow(smoothstep(cb + 1, ce + 1, i), 1.6);
    let i0 = 0;
    while (i0 < pts.length - 1) {
      const q = Math.round(aAt(i0 + 1) / 0.02) * 0.02; let i1 = i0 + 1;
      while (i1 < pts.length - 1 && Math.round(aAt(i1 + 1) / 0.02) * 0.02 === q) i1++;
      ctx.strokeStyle = `rgba(${rgb},${q.toFixed(2)})`; ctx.beginPath(); ctx.moveTo(...pts[i0]); for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(...pts[i]); ctx.stroke();
      i0 = i1;
    }
  });
  ctx.restore();
  // POLICYBZR crash
  const pb = M.lanes[M.lanes.length - 1];
  if (pb && pb.event) {
    const xs = xOfT(126), y0 = G.Q(-1.1), y1 = G.T1 + 8;
    ctx.save(); const gg = ctx.createLinearGradient(0, y0, 0, y1); gg.addColorStop(0, COL.amber); gg.addColorStop(.5, COL.crash); gg.addColorStop(1, COL.bear);
    ctx.shadowColor = 'rgba(255,106,77,.9)'; ctx.shadowBlur = 10 * S.k; ctx.fillStyle = gg; ctx.fillRect(xs - 1, y0, 2, y1 - y0);
    ctx.fillRect(xs - 1, G.T1 + 3, 590 - xs, 2);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,176,32,.9)'; ctx.font = `700 ${8.5 * S.tx}px ${FONT_NUM}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    if (S.tier3 && !S.noText) ctx.fillText('⊘ ' + MINUS + Math.abs(pb.c).toFixed(2), xs + 5, G.T1 + 1);
  }
  if (!S.noText) {
  // time axis
  ctx.font = `500 ${9 * S.tx}px ${FONT_NUM}`; ctx.textBaseline = 'alphabetic';
  const labs = obAxisLabels();
  labs.forEach(([t, s], i) => {
    if (!S.tier3 && i % 2 === 1) return;
    const x = xOfT(t); ctx.textAlign = i === 0 ? 'left' : 'center'; ctx.fillStyle = COL.ink3; ctx.fillText(s, x, G.T1 + 22);
    ctx.fillStyle = 'rgba(94,108,130,.5)'; ctx.fillRect(x, G.T1 + 10, 1, 3);
  });
  ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.fillText(obEndLabel(), 588, G.T1 + 22);
  }
  return cv;
}

/* ================= liquidity walls ================= */
function drawWalls(M, G, wrap) {
  warpQ(G);
  const X0 = 60, Y0 = G.T0 - 10, W = 540, H = G.T1 - G.T0 + 40;
  const { cv, ctx } = stageCanvas(wrap, X0, Y0, W, H, 'dimmable');
  cv.id = 'cvWalls';
  const lv = [2, 1, 0.5, -0.5, -0.75, -1, -1.25, -1.5, -2];
  const cnt = lv.map(v => M.stocks.filter(s => Math.abs(s.c - v) <= 0.1).length); const cmax = Math.max(...cnt, 1), cmin = Math.min(...cnt);
  const herd = M.stocks.filter(s => !s.sel);
  const med = []; for (let c = 0; c < 125; c++) { const a = herd.map(s => s.pctPlume[3 * c + 3]).sort((x, y) => x - y); med.push(a[a.length >> 1]); }
  const cw = 524 / 125; M.walls = [];
  lv.forEach((v, i) => {
    const r = rng('wall', String(v)); const c0 = 5 + Math.floor(r() * 30);
    const f = (cnt[i] - cmin) / Math.max(1, cmax - cmin);
    const th = 2 + 3 * f, al = 0.16 + 0.22 * f; const y = G.Q(v);
    let cEnd = 124, consumed = false;
    for (let c = c0 + 1; c < 125; c++) { if ((med[c - 1] - v) * (med[c] - v) <= 0 && Math.abs(med[c] - med[c - 1]) > 0) { cEnd = c; consumed = true; break; } }
    const x0 = 66 + c0 * cw, x1 = consumed ? 66 + (cEnd + .5) * cw : 590;
    ctx.save(); ctx.shadowColor = 'rgba(47,107,255,.7)'; ctx.shadowBlur = 8 * S.k;
    const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, `rgba(47,107,255,0)`); g.addColorStop(.08, `rgba(47,107,255,${al})`); g.addColorStop(1, `rgba(47,107,255,${al})`);
    ctx.fillStyle = g; ctx.fillRect(x0, y - th / 2, x1 - x0, th); ctx.restore();
    if (consumed) { ctx.save(); ctx.shadowColor = '#fff'; ctx.shadowBlur = 8 * S.k; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x1, y, 1.5, 0, 7); ctx.fill(); ctx.restore(); }
    M.walls.push({ v, y, x0, x1, th, al, consumed });
  });
  return cv;
}

/* ================= sector chips ================= */
function buildChips(M, G, root) {
  warpQ(G);
  root.innerHTML = '';
  const secs = M.D.sectors.slice().sort((a, b) => b.chg - a.chg);
  const top = secs.filter(x => x.chg > 0), bot = secs.filter(x => x.chg <= 0);
  const chips = [];
  const mk = (x, y) => {
    const c = el('div', 'chip fade0', root); css(c, { left: 72, top: y }); c.dataset.sec = x.sec;
    c.classList.add(x.chg > 0 ? 'up' : 'dn');
    let strip = ''; for (let i = 0; i < x.n; i++) strip += `<i style="background:${i < x.adv ? 'rgba(30,158,110,.9)' : 'rgba(194,58,82,.75)'}"></i>`;
    c.innerHTML = `<div class="r1"><span class="cap">${x.sec}</span><span class="v">${pctStr(x.chg)}</span></div><div class="strip">${strip}</div>`;
    chips.push(c);
  };
  const ch = S.tier3 ? 24 : 18, pm = ch + 2, lo = G.T0 + 8, hi = G.T1 - 8, botEnd = hi - ch, nT = top.length, nB = bot.length;
  const splitMin = lo + ch + 8 + Math.max(0, nT - 1) * pm;
  const splitMax = botEnd - 10 - Math.max(0, nB - 1) * pm;
  const split = splitMin <= splitMax ? clamp(G.yT, splitMin, splitMax) : (lo + botEnd) / 2;
  const pT = nT > 1 ? Math.min(pm, Math.max(14, (split - 8 - ch - lo) / (nT - 1))) : pm;
  top.forEach((x, i) => mk(x, lo + i * pT));
  const botMinY = Math.max(G.yT + 68, split + 10);
  const y0 = nB > 0 ? Math.max(botMinY, botEnd - Math.max(0, nB - 1) * pm) : botEnd;
  const pB = nB > 1 ? Math.min(pm, Math.max(14, (botEnd - y0) / (nB - 1))) : pm;
  bot.forEach((x, i) => mk(x, y0 + i * pB));
  // fit, uniformly across the column (one type size for every chip): label tracking first, then label size;
  // the value never shrinks
  const fit = () => {
    const caps = chips.map(c => c.querySelector('.r1 .cap')).filter(Boolean);
    const ok = () => chips.every(c => { const r1 = c.querySelector('.r1'); return !r1 || r1.scrollWidth <= r1.clientWidth + 0.5; });
    caps.forEach(cp => { cp.style.letterSpacing = ''; cp.style.fontSize = ''; });
    if (ok()) return;
    caps.forEach(cp => cp.style.letterSpacing = '.05em'); if (ok()) return;
    let fs = parseFloat(getComputedStyle(caps[0]).fontSize), g = 16;
    while (!ok() && fs > 7 && g--) { fs -= 0.5; caps.forEach(cp => cp.style.fontSize = fs + 'px'); }
  };
  fit(); requestAnimationFrame(fit);
}

/* ================= ladder (B) + gate ================= */
/* how many contenders a side has: the gate window on that side holds exactly them (the server picks the top 20 a
   side; a short side has fewer, and the bearish window ends at the last lane whatever the universe size) */
function obWinN(side) { const L = M && M.selected; return L ? L.filter(s => s.side === side).length : 20; }
function ladderLen(M, s) {
  if (s.sel) return 98;
  const L20 = s.side > 0 ? M.bulls : M.bears, c20 = (L20[Math.min(19, L20.length - 1)] || { c: 1 }).c || 1;
  return Math.min(97.3, 98 * Math.min(1, Math.pow(Math.abs(s.c) / Math.abs(c20), 0.9)));
}
function drawLadder(M, G, wrap) {
  const X0 = 584, Y0 = G.T0 - 12, W = 118, H = G.T1 - G.T0 + 24;
  const { cv, ctx } = stageCanvas(wrap, X0, Y0, W, H, 'dimmable');
  cv.id = 'cvLadder';
  const P = G.P, bh = P >= 4.4 ? 3 : Math.max(1.2, P - 1.4);
  // the chosen 20: always a visible dark gap between bars (≥1.5px), crisp, no fill-bleeding glow
  const sbh = Math.max(1.4, Math.min(3, P - 1.6));
  const winB = [G.T0, G.T0 + obWinN(1) * P], winR = [G.T1 - obWinN(-1) * P, G.T1];
  // ghosts + impact strip
  M.lanes.forEach((s, k) => {
    if (s.sel) return; const len = ladderLen(M, s); const y = G.laneY(k);
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.setLineDash([1, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(592 + len + 1, Math.round(y) + .5); ctx.lineTo(684, Math.round(y) + .5); ctx.stroke(); ctx.setLineDash([]);
    const b = 0.15 + 0.5 * Math.pow(len / 98, 2);
    ctx.fillStyle = s.side > 0 ? `rgba(30,158,110,${b})` : `rgba(194,58,82,${b})`;
    ctx.fillRect(684, G.T0 + k * P + (P - bh) / 2, 5, bh);
  });
  // window light wells: a faint side-coloured wash behind the chosen bars, brighter toward the gate
  [[winB, 1], [winR, -1]].filter(([w, side]) => obWinN(side) > 0).forEach(([w, side]) => {
    const rgb = SC[side]; const g = ctx.createLinearGradient(592, 0, 690, 0);
    g.addColorStop(0, `rgba(${rgb},.02)`); g.addColorStop(.6, `rgba(${rgb},.05)`); g.addColorStop(1, `rgba(${rgb},.13)`);
    ctx.fillStyle = g; ctx.fillRect(592, w[0], 98, w[1] - w[0]);
  });
  // bars
  const desat = (hex, f) => { const c = hexRgb(hex); const g = (c[0] + c[1] + c[2]) / 3; return c.map(v => v + (g - v) * f); };
  const herdB = desat(COL.bullMute, .3), herdR = desat(COL.bearMute, .3);
  M.lanes.forEach((s, k) => {
    const len = ladderLen(M, s);
    if (s.sel) {
      const y = G.T0 + k * P + (P - sbh) / 2;
      const g = ctx.createLinearGradient(592, 0, 690, 0);
      if (s.event) { g.addColorStop(0, 'rgba(163,23,46,.16)'); g.addColorStop(.6, 'rgba(255,106,77,.40)'); g.addColorStop(1, 'rgba(255,176,32,.55)'); }
      else { const d = hexRgb(sideCol(s.side, 'Deep')); g.addColorStop(0, rgbStr(d, .22)); g.addColorStop(.45, rgba(sideCol(s.side), .40)); g.addColorStop(1, rgba(sideCol(s.side, 'Hi'), .55)); }
      ctx.fillStyle = g; ctx.fillRect(592, y, len, sbh);
      // hairline top edge catches the light (reads as a machined bar, not a smear)
      ctx.fillStyle = s.event ? 'rgba(255,196,120,.3)' : `rgba(${SCHOT[s.side]},.30)`; ctx.fillRect(604, y, len - 12, Math.min(0.7, sbh / 3));
      // hot tip cap
      ctx.save(); ctx.shadowColor = s.event ? 'rgba(255,176,32,.9)' : rgba(sideCol(s.side), .9); ctx.shadowBlur = 5 * S.k;
      ctx.fillStyle = s.event ? '#FFE3B0' : sideCol(s.side, 'Hot'); ctx.fillRect(592 + len - 2, y, 2, sbh); ctx.restore();
    } else {
      const y = G.T0 + k * P + (P - bh) / 2;
      const a = 0.27 + 0.19 * len / 98; ctx.fillStyle = rgbStr(s.side > 0 ? herdB : herdR, a); ctx.fillRect(592, y, len, bh);
    }
  });
  // gate dashed line (outside windows)
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(690.5, winB[1] + 2); ctx.lineTo(690.5, winR[0] - 2); ctx.stroke(); ctx.setLineDash([]);
  // windows: lit slit in the gate + hairline frame round the chosen block + 8px crop brackets
  [[winB, 1], [winR, -1]].filter(([w, side]) => obWinN(side) > 0).forEach(([w, side]) => {
    const rgb = SC[side], hot = SCHOT[side];
    const y0 = w[0] - 1.5, y1 = w[1] + 1.5;
    ctx.save(); ctx.shadowColor = `rgba(${rgb},.9)`; ctx.shadowBlur = 9 * S.k;
    ctx.fillStyle = `rgba(${rgb},.85)`; ctx.fillRect(689.5, y0, 2, y1 - y0); ctx.restore();
    ctx.fillStyle = `rgba(${hot},.9)`; ctx.fillRect(690, y0 + 2, 1, y1 - y0 - 4);
    ctx.strokeStyle = `rgba(${rgb},.34)`; ctx.lineWidth = 1; ctx.strokeRect(591.5, y0 - 1, 100, y1 - y0 + 2);
    const x0 = 588, x1 = 696, by0 = y0 - 4, by1 = y1 + 4, a = 8;
    ctx.save(); ctx.shadowColor = `rgba(${rgb},.8)`; ctx.shadowBlur = 6 * S.k;
    ctx.strokeStyle = `rgba(${hot},1)`; ctx.lineWidth = 2; ctx.lineCap = 'square'; ctx.beginPath();
    ctx.moveTo(x0, by0 + a); ctx.lineTo(x0, by0); ctx.lineTo(x0 + a, by0);
    ctx.moveTo(x1 - a, by0); ctx.lineTo(x1, by0); ctx.lineTo(x1, by0 + a);
    ctx.moveTo(x0, by1 - a); ctx.lineTo(x0, by1); ctx.lineTo(x0 + a, by1);
    ctx.moveTo(x1 - a, by1); ctx.lineTo(x1, by1); ctx.lineTo(x1, by1 - a); ctx.stroke(); ctx.restore();
  });
  G.gateWin = { bull: winB, bear: winR };
  return cv;
}

/* ================= lens: cones, wedge, fibres ================= */
function coneEdge(x0, y0, x1, y1) { return [[x0, y0], [x0 + 50, y0], [x1 - 50, y1], [x1, y1]]; }
function bez(p, t) { const u = 1 - t; return [u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0], u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]]; }
function fibrePath(G, s) {
  const t = G.tileBy[s.s]; const y0 = G.laneY(s.lane);
  return [[690, y0], [750, y0], [t.x - 60, t.cy], [t.x + 4, t.cy]];
}
function drawLens(M, G, wrap, hi) {
  const X0 = 686, Y0 = 0, W = 690, H = G.Hd;
  let o = wrap._lens; if (!o) { o = stageCanvas(wrap, X0, Y0, W, H, 'dimmable clip'); o.cv.id = 'cvLens'; wrap._lens = o; }
  const { ctx } = o; ctx.clearRect(X0, Y0, W, H);
  const P = G.P;
  const bullTop = coneEdge(690, G.T0, 810, G.bandTop), bullBot = coneEdge(690, G.T0 + obWinN(1) * P, 810, G.bandTop + G.bullH);
  const bearTop = coneEdge(690, G.T1 - obWinN(-1) * P, 810, G.bearTop), bearBot = coneEdge(690, G.T1, 810, G.bandBot);
  const conePath = (a, b) => { ctx.beginPath(); ctx.moveTo(...a[0]); ctx.bezierCurveTo(...a[1], ...a[2], ...a[3]); ctx.lineTo(...b[3]); ctx.bezierCurveTo(...b[2], ...b[1], ...b[0]); ctx.closePath(); };
  // wedge
  conePath(bullBot, bearTop); ctx.fillStyle = 'rgba(2,3,5,.85)'; ctx.fill();
  ctx.save(); conePath(bullBot, bearTop); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,.035)'; ctx.lineWidth = 1;
  ctx.beginPath(); for (let x = 690 - 800; x < 820; x += 6) { ctx.moveTo(x, G.bandBot + 10); ctx.lineTo(x + G.bandBot + 10, 0); } ctx.stroke(); ctx.restore();
  // cones
  [[bullTop, bullBot, 1], [bearTop, bearBot, -1]].filter(([a, b, side]) => obWinN(side) > 0).forEach(([a, b, side]) => {
    const rgb = SC[side];
    ctx.save(); conePath(a, b); ctx.clip();
    const g = ctx.createLinearGradient(690, 0, 810, 0); g.addColorStop(0, `rgba(${rgb},.20)`); g.addColorStop(1, `rgba(${rgb},.07)`);
    ctx.fillStyle = g; const yA = Math.min(a[0][1], a[3][1]) - 2, yB = Math.max(b[0][1], b[3][1]) + 2;
    for (let y = Math.floor(yA); y < yB; y += 3) ctx.fillRect(690, y, 120, 1);
    const g2 = ctx.createLinearGradient(690, 0, 810, 0); g2.addColorStop(0, `rgba(${rgb},.06)`); g2.addColorStop(1, `rgba(${rgb},.0)`);
    ctx.fillStyle = g2; ctx.fillRect(690, yA, 120, yB - yA);
    ctx.restore();
    ctx.strokeStyle = `rgba(${rgb},.5)`; ctx.lineWidth = 1;
    [a, b].forEach(e => { ctx.beginPath(); ctx.moveTo(...e[0]); ctx.bezierCurveTo(...e[1], ...e[2], ...e[3]); ctx.stroke(); });
  });
  // fibres
  const cross = { 1: [], '-1': [] };
  M.selected.forEach(s => {
    const p = fibrePath(G, s); const pk = !!s.pick; const isHi = hi && hi === s.s;
    const rgb = s.event ? '255,176,32' : SC[s.side];
    ctx.strokeStyle = isHi ? 'rgba(255,255,255,.95)' : `rgba(${rgb},${pk ? .7 : .35})`; ctx.lineWidth = isHi ? 2 : pk ? 1.2 : .75;
    ctx.beginPath(); ctx.moveTo(...p[0]); ctx.bezierCurveTo(...p[1], ...p[2], ...p[3]); ctx.stroke();
    // crossing at x=810
    let lo = 0, hiT = 1; for (let i = 0; i < 24; i++) { const m = (lo + hiT) / 2; if (bez(p, m)[0] < 810) lo = m; else hiT = m; }
    cross[s.side].push(bez(p, lo)[1]);
  });
  // rim landing glow
  [[G.bandTop, G.bandTop + G.bullH, 1], [G.bearTop, G.bandBot, -1]].filter(([y0, y1, side]) => y1 > y0 && obWinN(side) > 0).forEach(([y0, y1, side]) => {
    const rgb = SC[side];
    for (let y = y0; y < y1; y += 1) {
      let a = 0.08; cross[side].forEach(cy => { a += 0.8 * Math.exp(-((y - cy) ** 2) / (2 * 3.5 * 3.5)); });
      ctx.fillStyle = `rgba(${rgb},${Math.min(.9, a)})`; ctx.fillRect(806, y, 2, 1);
    }
  });
  // echo brackets (16px)
  [[G.bandTop, G.bandTop + G.bullH, 1], [G.bearTop, G.bandBot, -1]].filter(([y0, y1, side]) => y1 > y0 && obWinN(side) > 0).forEach(([y0, y1, side]) => {
    const rgb = SC[side]; const x0 = 810 - 4, x1 = 1340 + 4, a = 16; y0 -= 4; y1 += 4;
    ctx.strokeStyle = `rgba(${rgb},.8)`; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(x0, y0 + a); ctx.lineTo(x0, y0); ctx.lineTo(x0 + a, y0);
    ctx.moveTo(x1 - a, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + a);
    ctx.moveTo(x0, y1 - a); ctx.lineTo(x0, y1); ctx.lineTo(x0 + a, y1);
    ctx.moveTo(x1 - a, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - a); ctx.stroke();
  });
  return o.cv;
}

/* ================= spine ================= */
function spinePts(G) {
  // polyline samples along the spine with thickness
  const pts = [];
  for (let x = 66; x <= 690; x += 4) pts.push([x, G.yT]);
  const b = [[690, G.yT], [750, G.yT], [750, G.yS], [810, G.yS]];
  for (let i = 1; i <= 40; i++) pts.push(bez(b, i / 40));
  for (let x = 814; x <= 1354; x += 4) pts.push([x, G.yS]);
  // cumulative length
  let L = 0; pts[0].push(0); for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); pts[i].push(L); }
  return { pts, L };
}
function drawSpine(M, G, wrap) {
  const sy0 = Math.min(G.yT, G.yS) - 40, sy1 = Math.max(G.yT, G.yS) + 40;
  const { cv, ctx } = stageCanvas(wrap, 40, sy0, (G.W || 1920) - 40, sy1 - sy0, 'clip');
  cv.id = 'cvSpine';
  const path = () => { ctx.beginPath(); ctx.moveTo(66, G.yT); ctx.lineTo(690, G.yT); ctx.bezierCurveTo(750, G.yT, 750, G.yS, 810, G.yS); ctx.lineTo(1354, G.yS); };
  ctx.lineCap = 'round';
  ctx.save(); ctx.shadowColor = 'rgba(91,108,255,1)'; ctx.shadowBlur = 18 * S.k; ctx.strokeStyle = 'rgba(91,108,255,.12)'; ctx.lineWidth = 6; path(); ctx.stroke(); ctx.restore();
  ctx.save(); ctx.shadowColor = 'rgba(169,184,255,1)'; ctx.shadowBlur = 6 * S.k; ctx.strokeStyle = 'rgba(169,184,255,.35)'; ctx.lineWidth = 3; path(); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(66, G.yT); ctx.lineTo(590, G.yT); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(590, G.yT); ctx.lineTo(690, G.yT); ctx.bezierCurveTo(750, G.yT, 750, G.yS, 810, G.yS); ctx.stroke();
  ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(810, G.yS); ctx.lineTo(1354, G.yS); ctx.stroke();
  // tail through D gutter
  const g = ctx.createLinearGradient(1354, 0, G.D.x1, 0); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,.25)');
  ctx.save(); ctx.shadowColor = 'rgba(169,184,255,.8)'; ctx.shadowBlur = 6 * S.k; ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(1354, G.yS); ctx.lineTo(G.D.x1, G.yS); ctx.stroke(); ctx.restore();
  return cv;
}

/* ================= nodes, NOW, reactor, bridges ================= */
function buildNodes(M, G, root) {
  root.innerHTML = '';
  const glow = el('div', 'nowglow fade0', root); css(glow, { left: 590.5, top: G.T0 - 8, height: G.T1 - G.T0 + 8 });
  glow.id = 'nowGlow';
  const now = el('div', 'nowline fade0', root); css(now, { left: 590, top: G.T0 - 8, height: G.T1 - G.T0 + 8 }); now.id = 'nowLine';
  const mk = (x, y, d, cls, id) => { const n = el('div', 'node ' + cls, root); css(n, { left: x, top: y, width: d, height: d }); if (id) n.id = id; return n; };
  const bc = mk(66, G.yT, 6, 'beacon fade0', 'nBeacon'); el('div', 'ring', bc);
  mk(590, G.yT, 8 / Math.SQRT2 * 1.1, 'dia st fade0', 'nNow');
  mk(690, G.yT, 10, 'st fade0', 'nGate');
  mk(810, G.yS, 12, 'st fade0', 'nLens');
  const r = el('div', 'reactor fade0', root); css(r, { left: 1354, top: G.yS }); r.id = 'nReactor';
  r.innerHTML = `<div class="halo"></div><svg class="r1" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="11" fill="none" stroke="rgba(232,241,255,.75)" stroke-width="1.2" stroke-dasharray="3 3"/></svg><svg class="r2" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="none" stroke="rgba(169,184,255,.55)" stroke-width="1" stroke-dasharray="6 4"/></svg><div class="core"></div>`;
  buildStationCounts(M, G, root);
  buildGateMotes(M, G, root);
}
/* station counts: how many names are still in play at each node (209 → 40 → 6). Mono numerals + hairline
   leaders, no words. Class `cnt` (S4's choreography may pop them); they also pop with their node by CSS. */
function buildStationCounts(M, G, root) {
  const nAll = M.lanes.length, nSel = M.selected.length, nPick = (M.buyPicks || []).length + (M.sellPicks || []).length;
  const mk = (cls, n, ax, ay, nx, ny, anchor) => {
    const c = el('div', 'cnt ' + cls, root); css(c, { left: ax, top: ay });
    const dx = nx - ax, dy = ny - ay, L = Math.hypot(dx, dy), th = Math.atan2(dy, dx) * 180 / Math.PI;
    c.innerHTML = `<i class="ld" style="left:0;top:0;width:${L.toFixed(1)}px;transform:rotate(${th.toFixed(1)}deg)"></i><b class="${anchor}">${n}</b>`;
    c.dataset.n = n; return c;
  };
  // 209: up-left of the NOW diamond, in the dark river the horn leaves at the close
  mk('c209', nAll, 583, G.yT - 8, 587, G.yT - 3, 'bl-r');
  // 40: up-right of the gate node, over the hatched wedge
  mk('c40', nSel, 698, G.yT - 8, 694, G.yT - 3.5, 'bl');
  // 6: on the spine tail, just out of the reactor's rings
  mk('c6', nPick, 1374, G.yS, 1363, G.yS, 'ml');
}
/* slow floating motes inside the two gate windows (live; static in reduced motion) */
function buildGateMotes(M, G, root) {
  const P = G.P, wins = [[G.T0, G.T0 + obWinN(1) * P, 1], [G.T1 - obWinN(-1) * P, G.T1, -1]];
  wins.filter(([y0, y1, side]) => obWinN(side) > 0 && y1 > y0).forEach(([y0, y1, side]) => {
    const w = el('div', 'gwin', root); css(w, { left: 593, top: y0, width: 96, height: y1 - y0 });
    const r = rng('gate', String(side)); const n = 5;
    for (let i = 0; i < n; i++) {
      const m = el('i', 'gmote', w);
      const x = 6 + r() * 66, y = 3 + r() * (y1 - y0 - 6), d = 8 + r() * 7;
      css(m, { left: x, top: y });
      m.style.setProperty('--mc', SCHOT[side]);
      m.style.setProperty('--dx', (16 + r() * 22).toFixed(1) + 'px');
      m.style.setProperty('--dy', ((r() - .5) * 8).toFixed(1) + 'px');
      m.style.setProperty('--md', d.toFixed(1) + 's');
      m.style.setProperty('--mdl', (-r() * d).toFixed(2) + 's');
      m.style.setProperty('--mo', (0.45 + r() * 0.45).toFixed(2));
    }
  });
}
function buildBridges(M, G, root) {
  root.innerHTML = '';
  G.tickets.forEach(t => {
    if (t.event) return;
    const b = el('div', 'bridge', root); css(b, { left: 1340, top: t.cy - 10, width: 28 }); b.style.setProperty('--sc', SC[t.side]); b.dataset.k = t.s.s; t.bridge = b;
  });
}
