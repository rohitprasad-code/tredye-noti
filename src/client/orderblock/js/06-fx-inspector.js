/* ================= FX: particles, comet, sweep, shimmer, brushing ================= */
let OB_FX_PAUSED = false;
try { OB_FX_PAUSED = localStorage.getItem('ob_fx_paused') === '1'; } catch (e) {}
const FX = {
  cv: null, ctx: null, paths: [], parts: [], flashes: [], sprites: {}, sweepStrip: null, weightedTiles: [],
  running: false, last: 0, lastDraw: 0, frameAvg: 16, ambient: false, userPaused: OB_FX_PAUSED,
  dirty: false, hover: null, pinned: null, showT0: 0, show: false,
  moveRaf: 0, pendingMove: null, lastMoveTarget: null, lastMoveMs: 0,
};
if (OB_FX_PAUSED && document.body && document.body.classList) document.body.classList.add('fx-paused');
function wakeFx(dirty) {
  if (dirty) FX.dirty = true;
  if (!FX.running && !document.hidden) {
    FX.running = true; FX.last = 0; FX.lastDraw = 0;
    requestAnimationFrame(fxLoop);
  }
}
function polyPath(pts) { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return { pts, cum, L: cum[cum.length - 1] }; }
function pathAt(p, d) {
  if (d <= 0) return p.pts[0]; if (d >= p.L) return p.pts[p.pts.length - 1];
  let lo = 0, hi = p.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m] < d) lo = m; else hi = m; }
  const f = (d - p.cum[lo]) / (p.cum[hi] - p.cum[lo] || 1); const a = p.pts[lo], b = p.pts[hi]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
function bezPts(b, n) { const o = []; for (let i = 0; i <= n; i++) o.push(bez(b, i / n)); return o; }
function threadPts(s, fromC) {
  const cw = 524 / 125; const pts = []; if (fromC <= 0) pts.push([66, G.yT]);
  const raw = []; for (let c = 0; c < 125; c++) raw.push(G.Q(s.pctPlume[3 * c + 3]));
  // the horn warp puts near-zero names at Q(c) while their ladder lane is rank-based: glide into the lane
  // over the last K columns so the lit chain never jumps vertically at NOW
  const yL = G.laneY(s.lane), dy = yL - G.Q(s.c), K = 14;
  for (let c = Math.max(0, fromC); c < 125; c++) {
    const a = raw[Math.max(0, c - 1)], b = raw[Math.min(124, c + 1)];
    let y = c === 124 ? G.Q(s.c) : (a + 2 * raw[c] + b) / 4;
    if (dy) y += dy * smoothstep(124 - K, 124, c);
    pts.push([66 + (c + 1) * cw, y]);
  }
  pts.push([590, yL]);
  return pts;
}
function chainFor(s) {
  // full lineage chain for a stock in stage coords (thread -> bar -> fibre -> tile -> bridge -> ticket)
  const segs = [];
  segs.push(threadPts(s, 0));
  const y = G.laneY(s.lane);
  if (!s.sel) { segs.push([[590, y], [592 + ladderLen(M, s), y]]); return { segs, herd: true, y }; }
  segs.push([[590, y], [690, y]]);
  const t = G.tileBy[s.s]; segs.push(bezPts(fibrePath(G, s), 30));
  const lb = t.ltpBox;  // the lineage crosses the tile at its centre: break around the boxed LTP chip so it stays legible
  if (lb && t.cy - t.y > lb.y0 - 4 && t.cy - t.y < lb.y1 + 4) { segs.push([[t.x + 4, t.cy], [t.x + lb.x0 - 4, t.cy]]); segs.push([[t.x + lb.x1 + 4, t.cy], [t.x + t.w, t.cy]]); }
  else segs.push([[t.x + 4, t.cy], [t.x + t.w, t.cy]]);
  const tk = G.ticketBy[s.s]; if (tk && !tk.event) segs.push([[1340, tk.cy], [1368, tk.cy], [1388, tk.cy]]);
  return { segs, herd: false, y, tile: t, ticket: tk };
}
function buildSweepStrip() {
  const cv = document.createElement('canvas'); cv.width = 120; cv.height = 1;
  const cx = cv.getContext('2d');
  if (cx) {
    const g = cx.createLinearGradient(0, 0, 120, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(.5, 'rgba(255,255,255,.06)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = g; cx.fillRect(0, 0, 120, 1);
  }
  return cv;
}
function buildFx() {
  const wrap = $('#fxWrap'); wrap.innerHTML = '';
  const o = stageCanvas(wrap, 0, 0, (G && G.W) || 1920, G.Hd, ''); o.cv.id = 'cvFx'; FX.cv = o.cv; FX.ctx = o.ctx;
  FX.sprites = { 1: glowSprite(SC[1], 5), '-1': glowSprite(SC[-1], 5), w: glowSprite('232,241,255', 6), a: glowSprite('255,176,32', 5) };
  FX.sweepStrip = FX.sweepStrip || buildSweepStrip();
  // particle paths
  FX.paths = []; const cw = 524 / 125;
  M.selected.forEach(s => {
    if (s.event) return; const side = s.side;
    const cb = Math.floor((s.ubPlume || s.ub) * 125) + 1; FX.paths.push({ kind: 'thread', side, s, p: polyPath(threadPts(s, cb)), v: 40, n: 2 });
    const y = G.laneY(s.lane); FX.paths.push({ kind: 'bar', side, s, p: polyPath([[592, y], [690, y]]), v: 80, n: 1 });
    FX.paths.push({ kind: 'fibre', side, s, p: polyPath(bezPts(fibrePath(G, s), 40)), v: 120, n: 2 });
  });
  G.tickets.forEach(tk => { if (tk.event) return; FX.paths.push({ kind: 'bridge', side: tk.side, s: tk.s, p: polyPath([[1340, tk.cy], [1368, tk.cy]]), v: 170, n: 3, tk }); });
  FX.spine = polyPath(spinePts(G).pts.map(p => [p[0], p[1]]));
  const cap = S.stacked ? 80 : 280;
  FX.parts = []; const r = mulberry32(7);
  FX.paths.forEach((pa, i) => { for (let k = 0; k < pa.n; k++) FX.parts.push({ pi: i, d: r() * pa.p.L, a: 0.5 + 0.5 * r() }); });
  if (FX.parts.length > cap) FX.parts.length = cap;
  FX.nodeD = { nNow: 524, nGate: 624, nLens: FX.spine.cum[FX.spine.pts.findIndex(p => p[0] >= 810 && Math.abs(p[1] - G.yS) < .5)] || 760, nReactor: FX.spine.L };
  FX.weightedTiles = [];
  if (G && Array.isArray(G.tiles)) {
    G.tiles.forEach(t => {
      if (t.s && !t.s.event && t.rd) {
        FX.weightedTiles.push(t);
        if (t.pick) { FX.weightedTiles.push(t); FX.weightedTiles.push(t); }
      }
    });
  }
  FX.dirty = true;
}
function flash(x, y, r, rgb, dur, a = 1) { FX.flashes.push({ x, y, r, rgb, t0: performance.now(), dur, a }); wakeFx(true); }
function nodeFlare(id) { const n = document.getElementById(id); if (!n) return; n.classList.remove('flare'); void n.offsetWidth; n.classList.add('flare'); }

/* ---- tile shimmer ---- */
function shimmerStep(now) {
  const weighted = FX.weightedTiles;
  if (!weighted || !weighted.length) return;
  for (let i = 0; i < 6; i++) {
    const t = weighted[Math.floor(Math.random() * weighted.length)]; const k = Math.floor(Math.random() * t.rd.rows);
    t.mul0[k] = t.mul[k]; t.mulT[k] = 0.9 + Math.random() * 0.2; t.tw[k] = now;
  }
}
function shimmerUpdate(now) {
  let shimCount = 0;
  for (let i = 0; i < G.tiles.length; i++) {
    const t = G.tiles[i];
    if (!t.tw || t.s.event || !t.built) continue;
    let dirty = false;
    for (let k = 0; k < t.tw.length; k++) {
      if (t.tw[k] < 0) continue;
      const f = clamp((now - t.tw[k]) / 500, 0, 1);
      const e = f * f * (3 - 2 * f);
      t.mul[k] = t.mul0[k] + (t.mulT[k] - t.mul0[k]) * e;
      if (f >= 1) t.tw[k] = -1;
      dirty = true;
    }
    if (dirty && (!t.lastDraw || now - t.lastDraw > 160)) {
      t.lastDraw = now;
      drawTileCanvas(t, 1e9);
      shimCount++;
      if (shimCount >= 3) break;
    }
  }
}

/* ---- main loop ---- */
let SHIM_LAST = 0, COMET_T0 = 0, SWEEP_T0 = 0;
function fxLoop(now) {
  if (!FX.running) return;
  if (document.hidden) { FX.running = false; return; }
  const h = FX.pinned || FX.hover;
  const ambientOn = FX.ambient && !S.reduced && !FX.userPaused;
  const revActive = Boolean(h && h.rev && now - h.rev < 500);
  const busy = FX.show || FX.flashes.length > 0 || FX.packets.length > 0 || revActive;
  const hoverAnimating = Boolean(h && ambientOn);
  const keepLoop = busy || hoverAnimating || ambientOn;
  if (!keepLoop) {
    if (!FX.dirty) { FX.running = false; return; }
  } else {
    requestAnimationFrame(fxLoop);
  }
  if (!busy && !FX.dirty && FX.lastDraw && now - FX.lastDraw < 30) return;
  const dt = Math.min(64, now - (FX.last || now)); FX.last = now; FX.lastDraw = now;
  FX.frameAvg = FX.frameAvg * 0.95 + dt * 0.05;
  if (FX.show) showUpdate(now);
  const ctx = FX.ctx; if (!ctx) { FX.running = keepLoop; return; }
  ctx.clearRect(0, 0, (G && G.W) || 1920, G.Hd);
  if (ambientOn) {
    if (obState() === 'LIVE') { if (now - SHIM_LAST > 180) { SHIM_LAST = now; shimmerStep(now); } shimmerUpdate(now); }
    drawParticles(ctx, dt, now);
    drawComet(ctx, now);
    drawSweep(ctx, now);
  }
  drawFlashes(ctx, now);
  drawBrush(ctx, now);
  FX.dirty = false;
  if (!keepLoop) FX.running = false;
}
function drawParticles(ctx, dt, now) {
  if (FX.frameAvg > 20 && FX.parts.length > 60) FX.parts.length = Math.floor(FX.parts.length / 2);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  FX.parts.forEach(pt => {
    const pa = FX.paths[pt.pi]; pt.d += pa.v * dt / 1000;
    if (pt.d >= pa.p.L) {
      pt.d -= pa.p.L;
      const e = pa.p.pts[pa.p.pts.length - 1];
      if (pa.kind === 'fibre' || pa.kind === 'bridge') flash(e[0], e[1], pa.kind === 'bridge' ? 9 : 6, SC[pa.side], 250, .5);
      if (pa.kind === 'bridge' && pa.tk && pa.tk.el) { const acc = pa.tk.el.querySelector('.acc'); }
    }
    const [x, y] = pathAt(pa.p, pt.d); const sp = FX.sprites[pa.side];
    const sz = pa.kind === 'bridge' ? 12 : pa.kind === 'fibre' ? 9 : 8;
    const fade = Math.min(1, pt.d / 12, (pa.p.L - pt.d) / 12);
    ctx.globalAlpha = pt.a * fade * (pa.kind === 'thread' ? .55 : .85);
    ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
  });
  ctx.restore();
}
function drawComet(ctx, now) {
  const per = 7000, dur = 5000; const t = (now - COMET_T0) % per; if (t > dur) { FX.cometHit = {}; return; }
  const f = t / dur; const e = f < .5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; const head = e * FX.spine.L;
  FX.cometHit = FX.cometHit || {};
  Object.entries(FX.nodeD).forEach(([id, d]) => { if (head >= d && !FX.cometHit[id]) { FX.cometHit[id] = 1; nodeFlare(id); if (id === 'nReactor') G.tickets.forEach(tk => { if (!tk.event) FX.packets.push({ tk, t0: now }); }); } });
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 24; i++) {
    const d = head - i * 2.5; if (d < 0) break; const [x, y] = pathAt(FX.spine, d);
    ctx.globalAlpha = (1 - i / 24) * .9; const sz = 14 - i * .35; ctx.drawImage(FX.sprites.w, x - sz / 2, y - sz / 2, sz, sz);
  }
  ctx.restore();
}
FX.packets = [];
function drawPackets(ctx, now) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  FX.packets = FX.packets.filter(pk => {
    const f = (now - pk.t0) / 200; if (f > 1) { if (pk.tk.el) { const a = pk.tk.el.querySelector('.acc'); if (a) { a.classList.remove('pulse'); void a.offsetWidth; a.classList.add('pulse'); } } if (pk.onLand) pk.onLand(); return false; }
    const x = 1340 + 28 * f, y = pk.tk.cy; ctx.globalAlpha = 1; ctx.drawImage(FX.sprites.w, x - 8, y - 8, 16, 16); ctx.drawImage(FX.sprites[pk.tk.side], x - 10, y - 10, 20, 20); return true;
  });
  ctx.restore();
}
function drawSweep(ctx, now) {
  const per = 12000, dur = 2400; const t = (now - SWEEP_T0) % per;
  if (t > dur) { FX.sweepHit = {}; return; }
  const xEnd = (G && G.D && G.D.x1) || 1896;
  const f = t / dur; const e = -(Math.cos(Math.PI * f) - 1) / 2; const x = 24 + e * (xEnd - 24);
  if (FX.sweepStrip) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(FX.sweepStrip, x - 60, 0, 120, G.Hd); ctx.restore();
  }
  FX.sweepHit = FX.sweepHit || {};
  G.tiles.forEach(T => {
    if (!T.pick || FX.sweepHit[T.s.s] || x < T.x + T.w / 2) return; FX.sweepHit[T.s.s] = 1;
    if (T.ret) { T.ret.style.transform = 'scale(.88)'; setTimeout(() => { T.ret.style.transform = ''; }, 220); }
    const tk = G.ticketBy[T.s.s]; if (tk) FX.packets.push({ tk, t0: now });
  });
}
function drawFlashes(ctx, now) {
  drawPackets(ctx, now);
  if (!FX.flashes.length) return;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  FX.flashes = FX.flashes.filter(f => {
    const k = (now - f.t0) / f.dur; if (k > 1) return false; if (k < 0) return true;
    if (f.rect) { ctx.globalAlpha = f.a * (1 - k); ctx.fillStyle = `rgba(${f.rgb},1)`; ctx.fillRect(f.rect[0], f.rect[1], f.rect[2], f.rect[3]); return true; }
    const r = f.r * (0.6 + 0.8 * k); const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
    g.addColorStop(0, `rgba(255,255,255,${f.a * (1 - k)})`); g.addColorStop(.3, `rgba(${f.rgb},${f.a * (1 - k) * .8})`); g.addColorStop(1, `rgba(${f.rgb},0)`);
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(f.x - r, f.y - r, 2 * r, 2 * r); return true;
  });
  ctx.restore();
}

/* ---- brushing ---- */
function strokePts(ctx, pts) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); }
function drawBrush(ctx, now) {
  const h = FX.pinned || FX.hover; if (!h) return;
  if (h.kind === 'stock') {
    const s = M.bySym[h.sym]; if (!s) return; const ch = h.chain || (h.chain = chainFor(s));
    const rgb = s.event ? '255,176,32' : SC[s.side];
    const y = ch.y;
    // crosshair A+B
    ctx.save(); ctx.strokeStyle = 'rgba(232,241,255,.28)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(66, Math.round(y) + .5); ctx.lineTo(690, Math.round(y) + .5); ctx.stroke(); ctx.setLineDash([]);
    // dual-pass glow + white core (avoids per-frame Gaussian shadowBlur)
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ch.segs.forEach(sg => {
      ctx.strokeStyle = `rgba(${rgb},.18)`; ctx.lineWidth = 10; strokePts(ctx, sg);
      ctx.strokeStyle = `rgba(${rgb},.55)`; ctx.lineWidth = 4.6; strokePts(ctx, sg);
    });
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ch.segs.forEach(sg => strokePts(ctx, sg));
    // marching dashes
    ctx.setLineDash([6, 8]); ctx.lineDashOffset = -(now / 1000 * 40) % 14; ctx.strokeStyle = `rgba(${SCHOT[s.side > 0 ? 1 : -1]},.95)`; ctx.lineWidth = 1.5;
    ctx.translate(0, -3.5); ch.segs.forEach(sg => strokePts(ctx, sg)); ctx.translate(0, 3.5); ctx.setLineDash([]);
    // bar highlight
    ctx.fillStyle = 'rgba(255,255,255,.9)'; const len = ladderLen(M, s); ctx.fillRect(592, y - 1.5, len, 3);
    if (ch.herd) {
      const k = (now % 900) / 900; ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(690, y, 4 + 12 * k, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(690, y, 2.5, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(592 + len, y); ctx.lineTo(690, y); ctx.stroke(); ctx.setLineDash([]);
    }
    // reverse pulse
    if (h.rev && now - h.rev < 500) {
      const all = []; ch.segs.forEach(sg => sg.forEach(p => all.push(p))); all.push([66, G.yT]);
      const pp = polyPath(all.slice().reverse()); const [x2, y2] = pathAt(pp, pp.L * (now - h.rev) / 500);
      ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(FX.sprites.w, x2 - 12, y2 - 12, 24, 24); ctx.drawImage(FX.sprites[s.side > 0 ? 1 : -1], x2 - 14, y2 - 14, 28, 28);
    }
    ctx.restore();
  } else if (h.kind === 'sector') {
    const items = h.sectorData || (h.sectorData = M.stocks.filter(s => s.sec === h.sec).map(s => ({
      side: s.side,
      pts: threadPts(s, 0),
      y: G.laneY(s.lane),
      len: ladderLen(M, s),
      fibre: s.sel ? bezPts(fibrePath(G, s), 30) : null,
    })));
    ctx.save(); ctx.lineJoin = 'round';
    items.forEach(it => {
      ctx.strokeStyle = `rgba(${SC[it.side]},.24)`; ctx.lineWidth = 5; strokePts(ctx, it.pts);
      ctx.strokeStyle = `rgba(${SC[it.side]},.9)`; ctx.lineWidth = 1.6; strokePts(ctx, it.pts);
      ctx.fillStyle = '#fff'; ctx.fillRect(592, it.y - 1.5, it.len, 3);
      if (it.fibre) { ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1.2; strokePts(ctx, it.fibre); }
    });
    ctx.restore();
  } else if (h.kind === 'anomaly') {
    const k = ((now - h.t0) % 700) / 700; const xs = 66 + 126 / NT * 524;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,176,32,${(.25 - .12 * k).toFixed(3)})`;
    ctx.fillRect(xs - 5, G.Q(-1.1), 10, G.T1 + 8 - G.Q(-1.1));
    ctx.fillStyle = `rgba(255,176,32,${(.9 - .6 * k).toFixed(3)})`;
    ctx.fillRect(xs - 1.5, G.Q(-1.1), 3, G.T1 + 8 - G.Q(-1.1)); ctx.fillRect(xs, G.T1 + 2.5, 590 - xs, 3); ctx.restore();
  }
}

/* ================= load choreography ================= */
/* Reading order taught in ~4.4s: plume (replay head sweeps 09:15 -> NOW) -> NOW flash + ladder -> gate + cones
   -> fibres sweep over the mosaic and each column builds as the fibre front reaches it -> lock-on reticles
   -> bridges fire -> tickets lift. Station count badges (.cnt, if present) pop as the build reaches their node. */
const SHOW = { events: [], t0: 0, fired: 0, tweens: [] };
function easeOutExpo(x) { return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); }
function easeInOutCubic(x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
function setClip(cv, x1) { if (!cv) return; const w = cv._w, x0 = cv._x; const r = clamp(w - (x1 - x0), 0, w); cv.style.clipPath = `inset(0 ${r}px 0 0)`; }
/* inverse of an ease (monotone on 0..1), by bisection */
function easeInv(ease, y) { let lo = 0, hi = 1; for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ease(m) < y) lo = m; else hi = m; } return (lo + hi) / 2; }
/* plume-side canvases revealed by the replay clip (everything in #plumeWrap except the axis/thermometer) */
function plumeCanvases() { return [...document.querySelectorAll('#plumeWrap canvas.cv')].filter(c => c.id !== 'cvAxis'); }
/* stage-x of a DOM element's centre */
function stageX(e) { const st = $('#stage'); const r = e.getBoundingClientRect(), q = st.getBoundingClientRect(); return (r.left + r.width / 2 - q.left) / (S.s || 1); }
/* which spine station a count badge belongs to: explicit data-node, else nearest station by x */
const CNT_T = { now: 1960, gate: 2580, lens: 2940, reactor: 3540 };
function cntStation(e) {
  const d = (e.dataset && (e.dataset.node || e.dataset.station) || '').toLowerCase();
  if (CNT_T[d]) return d;
  const x = stageX(e); const st = [['now', 590], ['gate', 690], ['lens', 810], ['reactor', 1354]];
  let best = 'now', bd = 1e9; st.forEach(([k, sx]) => { const dd = Math.abs(sx - x); if (dd < bd) { bd = dd; best = k; } }); return best;
}
function popCnt(station) {
  document.querySelectorAll('#stage .cnt').forEach(e => { if (e._stn !== station) return; e.classList.remove('cntpop'); void e.offsetWidth; e.classList.add('in', 'cntpop'); });
}
function scanHead() {
  let h = $('#scanHead');
  if (!h) { h = el('div', '', $('#stage')); h.id = 'scanHead'; const nx = $('#chips') || $('#fxWrap'); if (nx) $('#stage').insertBefore(h, nx); }  // under the chip scrims, over the plume
  css(h, { left: 66, top: G.T0 - 8, height: G.T1 - G.T0 + 16 });
  return h;
}
function afterRender() {
  buildFx(); bindInteractions();
  // the canonical linked-brushing demo is the #1 BUY ticket
  const hero = G.tickets.find(t => !t.event && t.side > 0 && t.pick === 1); if (hero && hero.el) hero.el.setAttribute('data-hover-demo', '');
  G.tiles.forEach(t => t.built = true);
  wakeFx(true);
}
function finalState() {
  (SHOW.tweens || []).forEach(w => { if (!w.done) { try { w.fn(w.ease(1)); } catch (e) { } w.done = true; } });
  const st = $('#stage'); st.classList.add('noanim');
  st.querySelectorAll('.in').forEach(e => e.classList.remove('in'));
  st.classList.remove('pre');
  st.querySelectorAll('canvas.cv').forEach(c => { c.style.clipPath = ''; c.style.opacity = ''; });
  const sh = $('#scanHead'); if (sh) sh.style.opacity = 0;
  G.tiles.forEach(t => { t.built = true; if (t.ctx) drawTileCanvas(t, 1e9); });
  G.tickets.forEach(tk => { if (!tk.el) return; tk.el.querySelectorAll('circle.fg').forEach(c => { const C = +c.dataset.c, v = +c.dataset.v; c.style.strokeDashoffset = (C * (1 - v / 100)).toFixed(2); }); tk.el.querySelectorAll('.pc[data-v]').forEach(p => p.textContent = pctStr(+p.dataset.v)); });
  obPulseDraw(1);
  const b1 = $('#brB'), b2 = $('#brS'); if (b1) { b1.textContent = M.nBullAll; b2.textContent = M.nBearAll; }
  const ck = $('#clockT'); if (ck) ck.textContent = obClock();
  void st.offsetWidth; st.classList.remove('noanim');
  FX.show = false; FX.ambient = true; st.classList.add('amb');
  wakeFx(true);
}
/* the build show plays untouched (user request): while it runs the hover is held, because brush mode outranks the
   build's hidden states (every tile and card the build has not reached showed through, and the stock's chain and popup
   drew ahead of the replay). When the show ends, the stock under the resting pointer lights up. */
function obStageTargetAt(st, p) {
  if (!st || !p || typeof document.elementFromPoint !== 'function') return null;
  let t = document.elementFromPoint(p[0], p[1]);
  const toast = t && t.closest ? t.closest('.ob-toast') : null;
  if (toast) {
    const prevPe = toast.style.pointerEvents;
    toast.style.pointerEvents = 'none';
    t = document.elementFromPoint(p[0], p[1]);
    toast.style.pointerEvents = prevPe;
  }
  return t && st.contains(t) ? t : null;
}
function obHoverAfterShow() {
  const p = FX.ptr; if (!p || S.stacked) return;
  const t = obStageTargetAt($('#stage'), p); if (!t) return;
  t.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p[0], clientY: p[1] }));
}
function settleShow() { if (FX.show) { FX.show = false; } finalState(); }
function startShow() {
  if (S.stacked) return;
  if (S.reduced) { finalState(); return; }
  const st = $('#stage');
  FX.pinned = null; FX.hover = null; applyBrush(null);
  st.classList.add('noanim'); st.classList.add('pre');
  st.querySelectorAll('.in').forEach(e => e.classList.remove('in'));
  st.querySelectorAll('.cntpop').forEach(e => e.classList.remove('cntpop'));
  FX.ambient = false; FX.flashes = []; FX.packets = []; st.classList.remove('amb');
  G.tiles.forEach(t => { t.built = false; if (t.ctx) t.ctx.clearRect(0, 0, t.w, t.h); t.startAt = null; });
  const lens = $('#cvLens'), spine = $('#cvSpine'), ladder = $('#cvLadder'), axis = $('#cvAxis'), walls = $('#cvWalls');
  const pcs = plumeCanvases();
  pcs.forEach(c => setClip(c, 66));
  setClip(spine, 60); setClip(lens, 686); setClip(ladder, 584);
  if (axis) axis.style.clipPath = `inset(${G.yT - (G.T0 - 12)}px 0 ${(G.T1 + 12) - G.yT}px 0)`;
  if (walls) walls.style.opacity = 0;
  const head = scanHead(); head.style.opacity = 0; head.style.transform = 'translateX(0)';
  G.tickets.forEach(tk => { if (!tk.el) return; tk.el.querySelectorAll('circle.fg').forEach(c => { c.style.strokeDashoffset = c.dataset.c; }); tk.el.querySelectorAll('.pc[data-v]').forEach(p => p.textContent = pctStr(0)); });
  obPulseDraw(0);
  const b1 = $('#brB'), b2 = $('#brS'); if (b1) { b1.textContent = '0'; b2.textContent = '0'; }
  const ck = $('#clockT'); if (ck) ck.textContent = '';
  void st.offsetWidth; st.classList.remove('noanim');
  SHOW.events = []; SHOW.tweens = [];
  const at = (t, fn) => SHOW.events.push({ t, fn });
  const tw = (t0, dur, fn, ease = x => x) => SHOW.tweens.push({ t0, dur, fn, ease });
  const addIn = sel => st.querySelectorAll(sel).forEach(e => e.classList.add('in'));
  // 0-300 background + brand
  at(0, () => { addIn('#brand'); addIn('#topRail'); });
  at(150, () => addIn('.pulse'));
  // beacon
  at(200, () => { addIn('#nBeacon'); const b = $('#nBeacon'); if (b) { b.style.transition = 'transform .5s cubic-bezier(.2,1.5,.35,1)'; b.style.transform = 'translate(-50%,-50%) scale(1.6)'; setTimeout(() => { b.style.transform = ''; }, 260); } flash(66, G.yT, 40, '232,241,255', 600, 1); });
  // plume replay: clip reveal + a travelling replay head (09:15 -> 15:30) that hands over to the NOW flash
  tw(400, 1600, f => { const x = 66 + 524 * f; pcs.forEach(c => setClip(c, x)); setClip(spine, x); head.style.transform = `translateX(${(524 * f).toFixed(1)}px)`; }, easeInOutCubic);
  tw(400, 160, f => { head.style.opacity = f; });
  tw(1880, 260, f => { head.style.opacity = 1 - f; });
  tw(400, 1600, f => { if (axis) { const top = (G.yT - (G.T0 - 12)) * (1 - f), bot = ((G.T1 + 12) - G.yT) * (1 - f); axis.style.clipPath = `inset(${top}px 0 ${bot}px 0)`; } }, easeOutExpo);
  tw(400, 700, f => { if (walls) walls.style.opacity = f; });
  tw(400, 1600, f => obPulseDraw(f), easeInOutCubic);
  tw(400, 1600, f => { if (b1) { b1.textContent = Math.round(M.nBullAll * f); b2.textContent = Math.round(M.nBearAll * f); } }, easeOutExpo);
  // sector chips light up as the thermometer fill (from the spine outward) passes them
  {
    const upS = G.yT - (G.T0 - 12), dnS = (G.T1 + 12) - G.yT;
    st.querySelectorAll('#chips .chip').forEach(c => {
      const cy = (parseFloat(c.style.top) || G.yT) + 12; const d = clamp(cy < G.yT ? (G.yT - cy) / upS : (cy - G.yT) / dnS, 0, .999);
      at(400 + 1600 * easeInv(easeOutExpo, d) + 60, () => c.classList.add('in'));
    });
  }
  // POLICYBZR streak flash at 11:21
  const xs = 66 + 126 / NT * 524; const tStreak = 400 + 1600 * easeInv(easeInOutCubic, (xs - 66) / 524);
  at(tStreak, () => { FX.flashes.push({ rect: [xs - 2, G.Q(-1.1), 4, G.T1 + 8 - G.Q(-1.1)], rgb: '255,176,32', t0: performance.now(), dur: 180, a: .9 }); });
  at(tStreak + 260, () => { FX.flashes.push({ rect: [xs - 2, G.Q(-1.1), 4, G.T1 + 8 - G.Q(-1.1)], rgb: '255,176,32', t0: performance.now(), dur: 180, a: .9 }); });
  // NOW flash + clock
  at(1900, () => { addIn('#nowLine, #nowGlow, #nNow, .clock + .fade0'); nodeFlare('nNow'); FX.flashes.push({ rect: [586, G.T0 - 8, 9, G.T1 - G.T0 + 8], rgb: '232,241,255', t0: performance.now(), dur: 420, a: .5 }); });
  tw(1900, 300, f => { if (ck) ck.textContent = obClock().slice(0, Math.round(8 * f)); });
  // ladder
  tw(2000, 600, f => { setClip(ladder, 584 + 118 * f); setClip(spine, 590 + 100 * f); }, x => 1 - Math.pow(1 - x, 3));
  // herd ghost impacts settle into the gate strip
  at(2320, () => { const r = mulberry32(11); M.lanes.forEach((s, k) => { if (s.sel || r() > .35) return; FX.flashes.push({ x: 686, y: G.laneY(k), r: 5, rgb: s.side > 0 ? '30,158,110' : '194,58,82', t0: performance.now() + r() * 260, dur: 220, a: .55 }); }); });
  at(2550, () => { M.selected.forEach((s, i) => { const y = G.laneY(s.lane); FX.flashes.push({ x: 690, y, r: 7, rgb: s.event ? '255,176,32' : SC[s.side], t0: performance.now() + i * 4, dur: 160, a: 1 }); }); addIn('#nGate'); nodeFlare('nGate'); });
  // cones unroll from the gate, then the fibre front sweeps across the mosaic
  tw(2500, 420, f => { setClip(lens, 690 + 120 * f); setClip(spine, 690 + 120 * f); }, x => 1 - Math.pow(1 - x, 3));
  at(2920, () => { addIn('#nLens'); nodeFlare('nLens'); });
  const FIB0 = 2920, FIBD = 520, FIBX0 = 810, FIBW = 566;
  tw(FIB0, FIBD, f => { setClip(lens, FIBX0 + FIBW * f); setClip(spine, FIBX0 + (1354 - FIBX0) * f); });
  // tiles: each column builds as the fibre front reaches it; within a column, outer edge -> spine, both halves together
  ['c4', 'c3', 'c2', 'c1'].forEach(k => {
    const col = G.cols[k]; const t0 = FIB0 + (col.x - FIBX0) / FIBW * FIBD + 10;
    [1, -1].forEach(side => {
      const list = G.tiles.filter(t => t.key === k && t.side === side).sort((a, b) => Math.abs(b.cy - G.yS) - Math.abs(a.cy - G.yS));
      list.forEach((t, i) => at(t0 + i * 25, () => { if (t.el) t.el.classList.add('in'); t.startAt = performance.now(); }));
    });
  });
  SHOW.tileAnim = true;
  // lock-on, once the pick column has landed
  at(3380, () => { G.tiles.forEach(t => { if (t.ret) { t.ret.classList.add('in'); FX.flashes.push({ rect: [t.x, t.y, t.w, t.h], rgb: '255,255,255', t0: performance.now() + 120, dur: 260, a: .12 }); } }); });
  // bridges + tickets
  const TB = 3520;
  at(TB, () => { addIn('#nReactor'); nodeFlare('nReactor'); addIn('.bridge'); });
  tw(TB, 650, f => setClip(spine, 1354 + (((G && G.W) || 1920) - 1354) * f));
  const order = [[1, 1], [-1, 1], [1, 2], [-1, 2], [1, 3], [-1, 3]];
  order.forEach(([side, n], i) => {
    const tk = G.tickets.find(x => !x.event && x.side === side && x.pick === n); if (!tk || !tk.el) return;
    const t = TB + 20 + i * 80;
    at(t, () => {
      tk.el.classList.add('in');
      tk.el.querySelectorAll('circle.fg').forEach(c => { const C = +c.dataset.c, v = +c.dataset.v; c.style.strokeDashoffset = (C * (1 - v / 100)).toFixed(2); });
      FX.packets.push({ tk, t0: performance.now() + 60, onLand: () => { const p = tk.el.querySelector('.pill'); if (p) { p.classList.remove('punch'); void p.offsetWidth; p.classList.add('punch'); } } });
    });
    tw(t + 100, 500, f => { tk.el.querySelectorAll('.pc[data-v]').forEach(p => p.textContent = pctStr(+p.dataset.v * f)); }, x => 1 - Math.pow(1 - x, 3));
  });
  at(TB + 520, () => { const a = st.querySelector('.anom'); if (a) { a.classList.add('in'); setTimeout(() => a.classList.add('flick'), 200); } });
  // station count badges (optional, owned by the terrain module): hidden now, popped as the build reaches each node
  st.querySelectorAll('.cnt').forEach(e => { e._stn = cntStation(e); });
  Object.keys(CNT_T).forEach(k => at(CNT_T[k], () => popCnt(k)));
  at(4600, () => { finalState(); COMET_T0 = performance.now() - 0; SWEEP_T0 = performance.now() + 1500; obHoverAfterShow(); });
  SHOW.events.sort((a, b) => a.t - b.t); SHOW.fired = 0; SHOW.t0 = performance.now(); FX.show = true;
  if (!FX.running) { FX.running = true; requestAnimationFrame(fxLoop); }
}
function showUpdate(now) {
  const t = now - SHOW.t0;
  while (SHOW.fired < SHOW.events.length && SHOW.events[SHOW.fired].t <= t) { const ev = SHOW.events[SHOW.fired++]; try { ev.fn(); } catch (e) { console.warn(e); } }
  SHOW.tweens.forEach(w => { if (t < w.t0 || w.done) return; const f = clamp((t - w.t0) / w.dur, 0, 1); try { w.fn(w.ease(f)); } catch (e) { } if (f >= 1) w.done = true; });
  if (SHOW.tileAnim) G.tiles.forEach(T => { if (T.startAt && !T.built) { const ms = now - T.startAt; drawTileCanvas(T, ms); if (ms > 6 * (T.rd ? T.rd.rows : 20) + 400) { T.built = true; drawTileCanvas(T, 1e9); } } });
}

/* ================= interaction: linked brushing, inspector, keys ================= */
function toStage(e) { const st = $('#stage'); const r = st.getBoundingClientRect(); return [(e.clientX - r.left) / S.s, (e.clientY - r.top) / S.s]; }
function clearLit(opts) {
  const st = $('#stage');
  if (!(opts && opts.keepBrushClass)) st.classList.remove('brush');
  st.querySelectorAll('.lit,.hot').forEach(e => e.classList.remove('lit', 'hot'));
}
function setBrush(h, e) {
  const same = FX.hover && h && FX.hover.kind === h.kind && FX.hover.sym === h.sym && FX.hover.sec === h.sec && FX.hover.idx === h.idx;
  if (same) {
    if (e) placeInspector(e);
    return;
  }
  FX.hover = h;
  if (FX.pinned) return;
  applyBrush(h, e);
}
function applyBrush(h, e, opts) {
  const st = $('#stage'), i = $('#inspector');
  const nextSym = h && h.kind === 'stock' && M && M.bySym && M.bySym[h.sym] ? h.sym : null;
  const keepIns = !!(opts && opts.preserveInspector && nextSym && e && i && i.classList.contains('on') && i._sym === nextSym && i._at);
  const savedAt = keepIns ? i._at : null;
  clearLit(opts);
  if (!keepIns) hideInspector();
  obPulseMark(h);
  if (!h) {
    clearLit(); hideInspector(); drawLens(M, G, $('#ladderWrap'), null);
    wakeFx(true);
    return;
  }
  if (h.kind === 'stock') {
    const s = M && M.bySym ? M.bySym[h.sym] : null;
    if (!s) {
      clearLit(); hideInspector(); obPulseMark(null); drawLens(M, G, $('#ladderWrap'), null);
      wakeFx(true);
      return;
    }
    st.classList.add('brush');
    st.querySelectorAll(`[data-k="${CSS.escape(h.sym)}"]`).forEach(x => x.classList.add('lit'));
    const sec = st.querySelector(`#chips .chip[data-sec="${CSS.escape(s.sec)}"]`); if (sec) sec.classList.add('hot');
    drawLens(M, G, $('#ladderWrap'), h.sym);
    if (e) { if (savedAt && i) i._at = savedAt; showInspector(s, e); }
    else if (keepIns) hideInspector();
  } else if (h.kind === 'sector') {
    st.classList.add('brush');
    if (keepIns) hideInspector();
    M.stocks.filter(s => s.sec === h.sec).forEach(s => st.querySelectorAll(`[data-k="${CSS.escape(s.s)}"]`).forEach(x => x.classList.add('lit')));
    const c = st.querySelector(`#chips .chip[data-sec="${CSS.escape(h.sec)}"]`); if (c) c.classList.add('hot');
  } else if (h.kind === 'anomaly') {
    st.classList.add('brush');
    if (keepIns) hideInspector();
    st.querySelectorAll('[data-k="' + (M.eventSym || '~') + '"]').forEach(x => x.classList.add('lit'));
  }
  wakeFx(true);
}
function hideInspector() {
  const i = $('#inspector');
  if (!i) return;
  i.classList.remove('on');
  i._at = null;
  if (window.gsap && typeof gsap.killTweensOf === 'function') gsap.killTweensOf(i);
  if (i.style) i.style.opacity = '';
}
function inspectorHTML(s) {
  const L = s.L; const rank = s.event ? '⊘ event' : `#${s.rank}/${s.side > 0 ? M.nBull : M.nBear}${s.side < 0 ? ' ex-⊘' : ''}`;
  const hi = s.event ? '255,106,77' : SCHI[s.side];
  const two = !!(L && !s.event);   // the wide chart popup: VWAP price and the ratio get cells of their own so every cell fits its half
  const vwRel = (s.l >= s.vwapEnd ? '▲ above' : '▼ below') + ' VWAP' + (two ? '' : ' ' + inr(s.vwapEnd));
  let rows = `<div class="row px"><span class="lp">₹${inr(s.l)}</span><span style="color:rgb(${hi})">${pctStr(s.c)} · ${ptsStr(s.pts)}</span></div>`;
  rows += `<div class="g2"><div class="row"><span class="k">rank</span><span>p${(s.p * 100).toFixed(1)} · ${rank}</span></div>`;
  if (L) rows += `<div class="row"><span class="k">conv</span><span>${s.conv} <span class="pp">${s.pips.map(x => x ? '●' : '○').join('')}</span></span></div>`;
  rows += `<div class="row"><span class="k">OI</span><span>${sgnStr(s.oi)}${Math.abs(s.oi).toFixed(1)}% · ${s.bu}</span></div>`;
  rows += `<div class="row"><span class="k">Δ</span><span>${lakh(s.delta)} · ${vwRel}</span></div>`;
  if (two) rows += `<div class="row"><span class="k">VWAP</span><span>${inr(s.vwapEnd)}</span></div>`;
  if (L) {
    rows += `<div class="row"><span class="k">OB</span><span>${inr(L.obLo)}–${inr(L.obHi)}</span></div>`;
    rows += `<div class="row"><span class="k">Z/${obLv('SL', s.side)}</span><span>${inr(L.E)} · <span style="color:var(--amber)">${inr(L.SL)}</span></span></div>`;
    rows += `<div class="row"><span class="k">${obLv('T1', s.side)}/${obLv('T2', s.side)}</span><span><span style="color:rgb(${SCHI[s.side]})">${inr(L.T1)} · ${inr(L.T2)}</span>${two ? '' : ' · 1:' + L.rr.toFixed(1)}</span></div>`;
    if (two) rows += `<div class="row"><span class="k">R:R</span><span>1:${L.rr.toFixed(1)}</span></div>`;
    // the pick rule, spelled out: top 3 per side, no event names, at most 2 per sector
    const picks = s.side > 0 ? M.buyPicks : M.sellPicks;
    let st;
    if (s.pick) st = `<span style="color:rgb(${SCHI[s.side]});font-weight:700">PICK · ${s.side > 0 ? 'BULLISH' : 'BEARISH'} #${s.pick}</span>`;
    else if (s.secCap) { const mates = picks.filter(x => x.sec === s.sec).map(x => x.s); st = `NOT PICKED · sector cap: ${s.sec} ×${mates.length} (${mates.join(', ')})`; }
    else st = `NOT PICKED · outside top 3 ${s.side > 0 ? 'bulls' : 'bears'}`;
    rows += `<div class="row note${!s.pick && s.secCap ? ' full' : ''}"><span class="k">rule</span><span>${st}</span></div>`;
  } else if (!s.event) {
    rows += `<div class="row"><span class="k">gate</span><span style="color:var(--ink-3)">below cut · no signal</span></div>`;
  } else rows += `<div class="row"><span class="k">status</span><span style="color:var(--amber)">EVENT RISK · NO TRADE</span></div>`;
  rows += '</div>';
  return `<div class="h"><div class="mg" style="background:linear-gradient(135deg,${s.event ? '#6b4a10' : sideCol(s.side, 'Deep')},#0A0F17)">${monogram(s)}</div><div><div class="t">${s.s}</div><div class="n">${s.n} · ${s.sec}</div></div></div>${rows}`;
}
function inspectorSpark(parent, s, w, scale, h = 24, cls = '') {
  const rgb = s.event ? '255,176,32' : SC[s.side];
  const { ctx } = localCanvas(parent, w, h, scale, cls);
  let mn = 1e9, mx = -1e9; for (let t = 0; t <= NT; t += 3) { mn = Math.min(mn, s.P[t]); mx = Math.max(mx, s.P[t]); }
  const yOf = v => 2 + (mx - v) / (mx - mn || 1) * (h - 4);
  ctx.strokeStyle = `rgba(${rgb},.95)`; ctx.lineWidth = 1.2; ctx.lineJoin = 'round'; ctx.beginPath(); for (let t = 0; t <= NT; t += 3) { const x = t / NT * (w - 4) + 1, y = yOf(s.P[t]); t ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
  ctx.fillStyle = `rgba(${rgb},.12)`; ctx.lineTo(w - 3, h); ctx.lineTo(1, h); ctx.closePath(); ctx.fill();
  const ly = yOf(s.P[NT - (NT % 3)]); ctx.fillStyle = `rgb(${SCHOT[s.side > 0 ? 1 : -1]})`; ctx.beginPath(); ctx.arc(w - 3, ly, 1.8, 0, 7); ctx.fill();
}
function showInspector(s, e) {
  const i = $('#inspector'); if (!i) return;
  i.style.setProperty('--sc', s.event ? '255,176,32' : SC[s.side]);
  if (i.dataset) i.dataset.side = s.event ? 'event' : (s.side > 0 ? 'bull' : 'bear');
  i.innerHTML = inspectorHTML(s);
  inspectorSpark(i, s, Math.round(92 * S.tx), S.s * S.dpr, Math.round(18 * S.tx), 'spk');
  i.classList.toggle('wide', !!(s.L && !s.event));   // a popup with a full-day chart gets the room for it
  obInspectorChart(i, s, Math.round(376 * S.tx), Math.round(238 * S.tx), S.tx, S.s * S.dpr, false);   // 238: 150 + the room the two-to-a-line stats freed, then +30% (user request)
  obLockNote(i);   // a locked preview: Access Locked on the chart, the Unlock line under it (terminal_locked.js)
  i._sym = s.s; i._cand = null; i._fixed = null;
  i._boxW = i.offsetWidth || (i.classList.contains('wide') ? 420 : 330);
  i._boxH = i.offsetHeight || 280;
  i.classList.add('on'); placeInspector(e);
}
/* ---- inspector placement: never on another ticket, never over the lit chain, always fully on-stage ----
   Candidates are scored against sampled points of the hovered stock's lineage (thread, crosshair, bar, fibre,
   tile, bridge) plus the ticket column; the cheapest wins, with a little hysteresis so it does not flip-flop. */
function rectHits(r, pts, pad) { let n = 0; for (const p of pts) if (p[0] > r.x - pad && p[0] < r.x + r.w + pad && p[1] > r.y - pad && p[1] < r.y + r.h + pad) n++; return n; }
function rectOverlap(a, b) { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; }
const CHAIN_PTS = { sym: null, G: null, pts: [] };
function chainSamples(sym, withCross, cy) {
  const s = M.bySym[sym]; if (!s) return [];
  if (CHAIN_PTS.sym !== sym || CHAIN_PTS.G !== G) {
    const ch = chainFor(s); const pts = [];
    ch.segs.forEach(sg => { for (let i = 1; i < sg.length; i++) { const [x0, y0] = sg[i - 1], [x1, y1] = sg[i]; const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6)); for (let k = 0; k <= n; k++) pts.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]); } });
    CHAIN_PTS.sym = sym; CHAIN_PTS.G = G; CHAIN_PTS.pts = pts;
  }
  if (!withCross) return CHAIN_PTS.pts;
  const pts = CHAIN_PTS.pts.slice(); for (let x = 66; x <= 690; x += 8) pts.push([x, cy]);
  return pts;
}
const SPINE_PTS = { G: null, pts: [] };
function spineSamples() {
  if (SPINE_PTS.G === G) return SPINE_PTS.pts;
  const pts = []; let src = [];
  try { src = (FX.spine && FX.spine.pts) || spinePts(G).pts; } catch (e) { src = [[66, G.yT], [690, G.yT], [810, G.yS], [1354, G.yS]]; }
  for (let i = 1; i < src.length; i++) { const [x0, y0] = src[i - 1], [x1, y1] = src[i]; const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8)); for (let k = 0; k < n; k++) pts.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]); }
  SPINE_PTS.G = G; SPINE_PTS.pts = pts; return pts;
}
function placeInspector(e) {
  const i = $('#inspector');
  if (!i || !e || !i.classList.contains('on')) return;
  const [x, y] = toStage(e);
  const W = i._boxW || i.offsetWidth || (i.classList.contains('wide') ? 420 : 330);
  const H = i._boxH || i.offsetHeight || 280;
  const M8 = 16;
  const GW = (G && G.W) || 1920;
  const Hd = (G && G.Hd) || 1080;

  // Smooth floating tooltip: directly follows cursor with compositor translate3d
  let px = x + 24;
  let py = y + 16;

  // Flip to the left if near the right edge
  if (px + W > GW - M8) {
    px = x - W - 24;
  }
  px = clamp(px, M8, GW - W - M8);

  // Flip above if near bottom
  if (py + H > Hd - M8) {
    py = y - H - 16;
  }
  py = clamp(py, M8, Hd - H - M8);

  const rx = Math.round(px);
  const ry = Math.round(py);
  const firstShow = !i._at;
  i._fixed = null;
  i._at = [x, y];
  i._atG = G;
  if (window.gsap) {
    if (firstShow) {
      gsap.set(i, { left: 0, top: 0, x: rx, y: ry, opacity: 0, scale: 0.97 });
      gsap.to(i, {
        opacity: 1,
        scale: 1,
        duration: 0.16,
        ease: 'power3.out',
        overwrite: 'auto',
        onComplete: () => { if (i.style) i.style.opacity = ''; },
      });
    } else {
      gsap.to(i, { x: rx, y: ry, scale: 1, duration: 0.12, ease: 'power3.out', overwrite: 'auto' });
    }
  } else {
    css(i, { left: 0, top: 0 });
    i.style.transform = `translate3d(${rx}px, ${ry}px, 0) scale(1)`;
    if (i.style) i.style.opacity = '';
  }
}
const _cardFlashTimers = new WeakMap();
let _toastTimer = null;
let _toastRemainingMs = 2800;
let _toastStartedAt = 0;
let _toastBound = false;
let _lastAnnouncedMsg = '';

function buildUpstoxTradeUrl(s) {
  if (s && s.et) {
    return `https://pro.upstox.com/chart?chartSegment=NSE_EQ&chartToken=${encodeURIComponent(String(s.et))}`;
  }
  if (s && s.isin) {
    return `https://upstox.com/stocks/stock/${encodeURIComponent(String(s.isin))}/`;
  }
  return 'https://pro.upstox.com/';
}

function flashCardAttr(cardEl, attr, durationMs = 1300) {
  if (!cardEl || !cardEl.setAttribute) return;
  const prev = _cardFlashTimers.get(cardEl);
  if (prev) clearTimeout(prev.t);
  cardEl.removeAttribute('data-copied');
  cardEl.removeAttribute('data-opened');
  cardEl.removeAttribute('data-copy-err');
  cardEl.setAttribute(attr, '1');
  const t = setTimeout(() => {
    cardEl.removeAttribute(attr);
    _cardFlashTimers.delete(cardEl);
  }, durationMs);
  _cardFlashTimers.set(cardEl, { t });
}

function announceAction(msg) {
  if (!msg) return;
  if ('ariaNotify' in document && typeof document.ariaNotify === 'function') {
    try { document.ariaNotify(msg); return; } catch {}
  }
  const live = document.getElementById('obActionAnnounce');
  if (!live) return;
  const text = msg === _lastAnnouncedMsg ? `${msg}\u00A0` : msg;
  _lastAnnouncedMsg = text;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

function pauseToastTimer() {
  if (!_toastTimer) return;
  clearTimeout(_toastTimer);
  _toastTimer = null;
  _toastRemainingMs = Math.max(400, _toastRemainingMs - (Date.now() - _toastStartedAt));
}

function startToastTimer(ms) {
  clearTimeout(_toastTimer);
  _toastRemainingMs = ms;
  _toastStartedAt = Date.now();
  _toastTimer = setTimeout(hideActionToast, ms);
}

function hideActionToast() {
  clearTimeout(_toastTimer);
  _toastTimer = null;
  const toast = document.getElementById('obActionToast');
  if (!toast) return;
  if (typeof toast.hidePopover === 'function') {
    try {
      if (toast.matches(':popover-open')) toast.hidePopover();
    } catch {}
  }
  toast.classList.remove(':popover-open');
}

function ensureToastBound() {
  if (_toastBound) return null;
  const toast = document.getElementById('obActionToast');
  if (!toast) return null;
  _toastBound = true;
  if (toast.getAttribute('popover') !== 'manual') {
    toast.setAttribute('popover', 'manual');
  }
  toast.addEventListener('pointerenter', pauseToastTimer);
  toast.addEventListener('focusin', pauseToastTimer);
  const maybeResume = () => {
    if (!toast.matches(':hover') && !toast.contains(document.activeElement)) {
      startToastTimer(_toastRemainingMs || 1800);
    }
  };
  toast.addEventListener('pointerleave', maybeResume);
  toast.addEventListener('focusout', () => setTimeout(maybeResume, 0));
  const btn = toast.querySelector('.ob-toast-close');
  if (btn) btn.addEventListener('click', hideActionToast);
  return toast;
}

function showActionToast({ kind = 'copy', ico = '✓', msg = '', sub = '', durationMs = 2800 } = {}) {
  const toast = document.getElementById('obActionToast');
  if (!toast) return;
  ensureToastBound();
  toast.dataset.kind = kind;
  const icoEl = toast.querySelector('.ob-toast-ico');
  const msgEl = toast.querySelector('.ob-toast-msg');
  const subEl = toast.querySelector('.ob-toast-sub');
  if (icoEl) icoEl.textContent = ico;
  if (msgEl) msgEl.textContent = msg;
  if (subEl) subEl.textContent = sub;
  if (typeof toast.showPopover === 'function') {
    try {
      if (!toast.matches(':popover-open')) toast.showPopover();
    } catch {
      toast.classList.add(':popover-open');
    }
  } else {
    toast.classList.add(':popover-open');
  }
  if (!toast.matches(':hover') && !toast.contains(document.activeElement)) {
    startToastTimer(durationMs);
  } else {
    _toastRemainingMs = durationMs;
  }
  announceAction(sub ? `${msg}. ${sub}` : msg);
}

function legacyCopyText(text) {
  const active = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (active && typeof active.focus === 'function' && document.contains(active)) {
    try { active.focus({ preventScroll: true }); } catch {}
  }
  return ok;
}

function handleCopyResult(ok, sym, cardEl) {
  if (ok) {
    flashCardAttr(cardEl, 'data-copied', 1300);
    showActionToast({
      kind: 'copy',
      ico: '✓',
      msg: `Copied ${sym}`,
      sub: 'Paste in broker · ⌘+Click opens Upstox',
    });
  } else {
    flashCardAttr(cardEl, 'data-copy-err', 1300);
    showActionToast({
      kind: 'error',
      ico: '!',
      msg: `Could not copy ${sym}`,
      sub: 'Clipboard permission denied',
      durationMs: 3600,
    });
  }
}

async function copyStockCode(sym, cardEl) {
  const code = String(sym || '').trim();
  if (!code) return;
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      ok = legacyCopyText(code);
    }
  } else {
    ok = legacyCopyText(code);
  }
  handleCopyResult(ok, code, cardEl);
}

function openUpstoxStockTab(s, cardEl) {
  if (!s || !s.s || s._anchor) return;
  const url = buildUpstoxTradeUrl(s);
  window.open(url, '_blank', 'noopener,noreferrer');
  flashCardAttr(cardEl, 'data-opened', 1400);
  showActionToast({
    kind: 'open',
    ico: '↗',
    msg: `Opening ${s.s} in Upstox`,
    sub: s.et ? 'Upstox Pro chart & order pad' : (s.isin ? 'Upstox stock page' : 'Upstox Pro'),
    durationMs: 2800,
  });
}

function obBrushHit(e, refHover) {
  const ref = FX.hover || refHover;
  const tEl = e.target && e.target.closest ? e.target.closest('[data-k]') : null;
  if (tEl && (tEl.classList.contains('tile') || tEl.classList.contains('ticket') || tEl.classList.contains('bridge'))) {
    const sym = tEl.dataset.k;
    return { kind: 'stock', sym, rev: ref && ref.sym === sym && ref.rev ? ref.rev : performance.now() };
  }
  if (tEl && tEl.classList.contains('anom')) return { kind: 'anomaly', sym: M.eventSym, t0: (ref && ref.kind === 'anomaly' && ref.t0) || performance.now() };
  const pz = e.target && e.target.closest ? e.target.closest('#crest .pulse') : null;
  if (pz) return obPulseHit(pz, e);
  const chip = e.target && e.target.closest ? e.target.closest('#chips .chip') : null;
  if (chip) return { kind: 'sector', sec: chip.dataset.sec };
  const [x, y] = toStage(e);
  if (x >= 66 && x <= 696 && y >= G.T0 && y < G.T1 && M.lanes && M.lanes.length) {
    const lane = clamp(Math.floor((y - G.T0) / G.P), 0, M.lanes.length - 1);
    const s = M.lanes[lane];
    if (s) return { kind: 'stock', sym: s.s };
  }
  return null;
}

function obRestoreHoverAfterRender(prevHover) {
  const st = $('#stage');
  if (FX.pinned) return;
  if (FX.show || S.stacked || !FX.ptr) {
    FX.hover = null;
    applyBrush(null);
    return;
  }
  const p = FX.ptr;
  const t = obStageTargetAt(st, p);
  if (!t) {
    if (typeof document.elementFromPoint !== 'function' && prevHover) {
      const valid = prevHover.kind === 'stock' ? !!(M && M.bySym && M.bySym[prevHover.sym])
        : prevHover.kind === 'sector' ? !!(M && M.stocks && M.stocks.some(x => x.sec === prevHover.sec))
        : prevHover.kind === 'anomaly' ? !!(M && M.eventSym) : false;
      if (valid) {
        FX.hover = prevHover;
        applyBrush(prevHover, { clientX: p[0], clientY: p[1], target: st }, { preserveInspector: true, keepBrushClass: true });
        return;
      }
    }
    FX.hover = null;
    applyBrush(null);
    return;
  }
  const ev = { clientX: p[0], clientY: p[1], target: t };
  const h = obBrushHit(ev, prevHover);
  FX.hover = h;
  applyBrush(h, ev, { preserveInspector: true, keepBrushClass: !!h });
}

function bindInteractions() {
  const st = $('#stage'); if (st._bound) return; st._bound = true;
  const handleMove = e => {
    FX.lastMoveMs = performance.now();
    FX.lastMoveTarget = e.target;
    FX.ptr = [e.clientX, e.clientY]; if (FX.show) return;   // the build show plays untouched: the hover waits for its end
    setBrush(obBrushHit(e), e);
  };
  st.addEventListener('mousemove', e => {
    if (S.stacked) return;
    const now = performance.now();
    if (FX.lastMoveTarget === e.target && FX.lastMoveMs && now - FX.lastMoveMs < 16) {
      FX.pendingMove = { clientX: e.clientX, clientY: e.clientY, target: e.target };
      if (!FX.moveRaf) {
        FX.moveRaf = requestAnimationFrame(() => {
          FX.moveRaf = 0;
          const ev = FX.pendingMove; FX.pendingMove = null;
          if (ev) handleMove(ev);
        });
      }
      return;
    }
    FX.pendingMove = null;
    handleMove(e);
  });
  st.addEventListener('mouseleave', () => { FX.ptr = null; FX.pendingMove = null; FX.lastMoveTarget = null; setBrush(null); });
  st.addEventListener('click', e => {
    const card = e.target && e.target.closest ? e.target.closest('.ticket, .tile, .anom') : null;
    if (card) {
      const sym = card.dataset && card.dataset.k;
      const s = sym && M && M.bySym ? M.bySym[sym] : null;
      if (s && !s._anchor) {
        if (e.metaKey) {
          e.preventDefault();
          openUpstoxStockTab(s, card);
          return;
        }
        copyStockCode(s.s, card);
        if (FX.pinned) { FX.pinned = null; applyBrush(FX.hover, e); }
        return;
      }
    }
    if (FX.pinned) { FX.pinned = null; applyBrush(FX.hover, e); return; }
    if (FX.hover) FX.pinned = Object.assign({}, FX.hover);
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { FX.pinned = null; FX.hover = null; applyBrush(null); }
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !S.stacked) startShow();
  });
  const br = $('#brand'); st.addEventListener('dblclick', e => { if (e.target.closest('#brand, #crest .pulse')) startShow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      FX.running = false;
    } else {
      if (!S.stacked) wakeFx(true);
      if (typeof PULSE !== 'undefined' && PULSE) obPulseWake(PULSE);
    }
  });
}
