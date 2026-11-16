/* ================= stacked (phone / portrait) layout: the vertical pipeline =================
   The desktop's left → right funnel (market → flow → gate → contenders in tiers → six setups) read top → bottom
   (user request: the phone must carry everything the desktop has, as premium). Injected by tools/patch_terminal.py
   inside the page's main script, in place of the old stacked region; renderStack() stays the entry point that
   boot / go / rerender / onUpdate / lateFonts call.

   Page: #stack = #phNav (sticky station nav) + .phpage > #phBody (swapped whole on every rebuild) + #sheet + #phScrim
   + #phLoupe. A rebuild (new minute, width or theme change, late fonts) is built section by section into a hidden
   holder of the same width, then swapped in one task with the reader's place restored (role-keyed [data-anchor]).
   A height-only resize (URL bar, keyboard, status strip) never rebuilds (phKeep).

   HOOKS FOR THE MOTION LAYER (tools/terminal_phone_fx.js; everything below is static and complete without it):
   - PH.secs: the section registry, in page order. Each entry {key, station, el, kind, side, pick, vis, risen}:
     keys 'market', 'flow', 'branch:bull', 'bay:bull:1..3', 'branch:bear', 'bay:bear:1..3', 'event'.
     PH.intro[kind](sec) runs the first time a section comes into view (never again: S.risen keeps the key through
     rebuilds); the motion layer owns the trigger (its own observer, set up on every swap) and the intros.
     sec.vis is kept current (IntersectionObserver) for "animate only what is on screen".
   - PH.overUnder(ctx, now, F): drawn on the flow overlay after it is cleared, under the brush chain (particles,
     flashes); PH.hurry(): a tap during an intro asks it to finish quickly and sets PH.holdUntil (the tap waits).
   - PH.flow: the flow composite {el, fx, AX, padT, yO, Gp, cv:{walls, axis, plume, ladder, spine, over}, octx,
     X(x), Y(y) design → css px, lane(k) → css y, node:{beacon, now, gate}, cnt:{all, gate}, motes, nowline, nowglow}.
     PH.drawOverlay(now) redraws the brush chain on cv.over (the static chain; call it per frame for marching dashes).
   - PH.lens[1|-1]: the lens bands {el, cv, ctx, w, h, slitY, rimY, notch:{sym→x}, land:{sym→x}, draw(hiSet)}.
   - PH.tiers: [{side, key, el, rows:[{el, h}], tiles:[T]}]; PH.tiles: every phone tile T (tile objects of buildTile,
     with T.el / T.cv / T.rd), PH.tileBy[sym].
   - PH.bays: [{side, pick, s, el, tile:T, bridge, ret, TK}] (TK.el = the card); PH.eventBay the same for the event.
   - PH.spine: {el, top, bottom, nodes:[{key, el, y, cnt}]} (y in #phBody px); nodes flare with class 'flare'.
   - PH.rail: {el, chips:[el]}; PH.crest: the PULSE object of the crest; PH.nav: the nav element.
   - PH.onSwap / PH.onSelect: arrays of callbacks; PH.holdUntil (performance.now ms): taps wait for an intro;
     PH.introBusy(): return true while an intro plays (a pending minute swap waits for it).
   - phFrame(fn) adds a per-frame callback to the one phone rAF loop (fn(now) → false to remove it).
   - Diagnostics: PH.buildMs (ms per build task, in order), PH.swapMs, PH.lastAnchor (the place kept by the last swap). */
const PH = {
  inited: false, gen: 0, cw: 0, theme: '', wide: false, side: false, navH: 44,
  root: null, page: null, nav: null, body: null, sheet: null, scrim: null, loupe: null,
  secs: [], flow: null, lens: {}, tiers: [], tiles: [], tileBy: {}, bays: [], eventBay: null, spine: null, rail: null, crest: null,
  sel: null, sh: { open: false, kind: '', sym: '', sec: '', detent: 'half', list: null, i: -1, filter: 'all', fside: 0, q: '' },
  obs: [], finger: false, lastScroll: 0, holdUntil: 0, frames: new Set(), looping: false,
  intro: { market() { }, flow() { }, branch() { }, bay() { }, event() { } },
  introBusy: () => false, hurry: null, overUnder: null, onSwap: [], onSelect: []
};
const PH_TRI = { 1: '<svg class="tri" viewBox="0 0 8 8" aria-hidden="true"><path d="M4 1.2l3.2 5.4H.8z"/></svg>', '-1': '<svg class="tri" viewBox="0 0 8 8" aria-hidden="true"><path d="M4 6.8L.8 1.4h6.4z"/></svg>' };
const PH_REACTOR = `<div class="halo"></div><svg width="40" height="40" viewBox="0 0 40 40"><g class="r1"><circle cx="20" cy="20" r="11" fill="none" stroke="rgba(232,241,255,.75)" stroke-width="1.2" stroke-dasharray="3 3"/></g><g class="r2"><circle cx="20" cy="20" r="17" fill="none" stroke="rgba(169,184,255,.55)" stroke-width="1" stroke-dasharray="6 4"/></g></svg><div class="core"></div>`;
const phEsc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const phSd = side => side > 0 ? 'bull' : 'bear';
const phYield = () => new Promise(r => setTimeout(r, 0));
function phStatus(s) {
  if (s.event) return { t: 'EVENT RISK', c: 'ev' };
  if (s.pick) return { t: (s.side > 0 ? 'BULLISH' : 'BEARISH') + ' #' + s.pick, c: s.side > 0 ? 'up' : 'dn', pk: 1 };
  if (s.sel) return { t: 'CONTENDER #' + s.rank, c: s.side > 0 ? 'up' : 'dn' };
  return { t: 'HERD', c: 'hd' };
}
function phSideVars(e, side, ev) {
  e.style.setProperty('--sc', ev ? '255,176,32' : SC[side]); e.style.setProperty('--hi', ev ? '255,176,32' : SCHI[side]); e.style.setProperty('--hot', ev ? '255,176,32' : SCHOT[side]);
  return e;
}

/* ---------------- geometry for a content width W ---------------- */
// a short frame (landscape phone): the row variant from 600 wide and a plume capped so the flow and its header fit one
// screen under the nav (the composite is the plume + ~63 px, the header 34)
function phShort(W) { return window.innerHeight <= 500 && W >= 600; }
function phGeo(W) {
  const short = phShort(W), wide = W >= 700 || short, AX = 48, fx = (W - AX) / 636;   // design x 66..702 → css AX..W (the axis column is AX wide)
  const plumeH = short ? Math.max(150, Math.min(0.6 * W, window.innerHeight - (PH.navH || 40) - 106)) : wide ? 0.6 * W : 1.05 * W;   // the plume area, css px
  return {
    W, wide, short, AX, fx, HdP: Math.round(plumeH / fx) + 152, crestH: wide ? 120 : 100, secCols: wide ? 5 : W < 360 ? 2 : 3,
    tier: { c4: { n: wide ? 8 : 4, base: 64 }, c3: { n: wide ? 5 : 3, base: 84 }, c2: { n: wide ? 4 : 2, base: 100 } },
    gap: 6, lensH: wide ? 84 : 72, stripH: 72
  };
}
function phContentW() { return Math.max(240, (PH.page ? PH.page.clientWidth : window.innerWidth) - 38); }

/* ---------------- persistent shell: nav, page, sheet, scrim, loupe; one set of listeners ---------------- */
function phInit() {
  if (PH.inited) return;
  PH.inited = true;
  const root = PH.root = $('#stack'); root.innerHTML = '';
  root.setAttribute('aria-label', 'Order Block terminal');
  const nav = PH.nav = el('nav', 'phnav', root); nav.id = 'phNav'; nav.setAttribute('aria-label', 'Stations');
  nav.innerHTML = `<div class="phnavin">
    <button class="phn" data-act="nav" data-to="market" aria-label="Market"><span class="c">MARKET</span><span class="bd"><i class="b"></i><i class="r"></i></span></button>
    <button class="phn" data-act="nav" data-to="flow" aria-label="Flow"><span class="c">FLOW</span><b class="n" data-n="all">·</b></button>
    <button class="phn up" data-act="nav" data-to="bull" aria-label="Bullish contenders"><span class="c">${PH_TRI[1]}TOP</span><b class="n" data-n="bull">·</b></button>
    <button class="phn dn" data-act="nav" data-to="bear" aria-label="Bearish contenders"><span class="c">${PH_TRI[-1]}TOP</span><b class="n" data-n="bear">·</b></button>
    <button class="phn find" data-act="find" aria-label="Find a stock"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.6"/><path d="M12.8 12.8L17 17"/></svg></button>
  </div><div class="phprog"><i></i></div>`;
  PH.page = el('div', 'phpage', root);
  const sheet = PH.sheet = el('div', 'sheet phsheet', root); sheet.id = 'sheet';
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-hidden', 'true'); sheet.setAttribute('aria-label', 'Details');
  PH.scrim = el('div', 'phscrim', root); PH.scrim.id = 'phScrim';
  PH.loupe = el('div', 'phloupe', root); PH.loupe.id = 'phLoupe';
  phRouterBind(root);
  phSheetBind(sheet);
  window.addEventListener('scroll', phOnScrollEv, { passive: true });
  window.addEventListener('resize', phOnResize);
  window.addEventListener('keydown', phOnKey);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) phLoopKick(); });
}

/* ---------------- entry point: build (hidden, chunked, generation-guarded) then swap ---------------- */
function renderStack() {
  phInit();
  // a desktop build show cut short by a stage → phone switch is settled, or FX.show would hold every minute update
  if (FX.show) { try { if (typeof settleShow === 'function') settleShow(); } catch (e) { } FX.show = false; }
  FX.ptr = null;
  FX.running = false;                                   // the desktop FX loop never runs under the phone
  S.s = 1; S.dpr = Math.min(2, window.devicePixelRatio || 1); S.k = S.dpr; S.tx = 1; S.tier3 = true;
  document.documentElement.style.setProperty('--tx', 1);
  PH.risen = S.risen || (S.risen = new Set());
  phSideMode();
  const gen = ++PH.gen;
  phBuild(gen).catch(e => console.warn('phone build failed', e));
}
async function phBuild(gen) {
  const W = phContentW(), geo = phGeo(W), m = M;
  const B = { gen, M: m, W, geo, wide: geo.wide, secs: [], tiers: [], tiles: [], tileBy: {}, bays: [], lens: {}, eventBay: null };
  const holder = el('div', 'phnext'); PH.page.appendChild(holder);
  const body = B.body = el('div', 'phbody' + (geo.wide ? ' wide' : '') + (geo.wide && W < 700 ? ' r3' : ''), holder);   // each body carries its own variant
  const steps = [phBuildMarket, b => phBuildFlow(b, 0), b => phBuildFlow(b, 1), b => phBuildFlow(b, 2), b => phBuildBranch(b, 1), b => phBuildBays(b, 1), b => phBuildBranch(b, -1), b => { phBuildBays(b, -1); phBuildEvent(b); }, phBuildFoot];
  B.ms = [];
  for (const step of steps) {
    if (gen !== PH.gen || m !== M || !S.stacked) { phZero(holder); holder.remove(); return; }   // !S.stacked: the frame went to the desktop stage
    const t0 = performance.now(); step(B); B.ms.push(Math.round(performance.now() - t0));   // PH.buildMs: one task per section
    await phYield();
  }
  if (gen !== PH.gen || m !== M || !S.stacked) { phZero(holder); holder.remove(); return; }
  B.cw = W; B.theme = document.documentElement.getAttribute('data-theme') || 'dark';
  phSwap(B, holder);
}
/* the swap waits while a finger is down, while the page scrolls (idle ≥150 ms) and while an intro plays */
function phSwap(B, holder) {
  if (B.gen !== PH.gen || !S.stacked) { phZero(holder); holder.remove(); return; }   // never takes G / PULSE from the desktop stage
  if (PH.body) {
    const busy = PH.introBusy && PH.introBusy();
    if (PH.finger || performance.now() - PH.lastScroll < 150 || busy) { setTimeout(() => phSwap(B, holder), busy ? 300 : 160); return; }
  }
  const first = !PH.body, tSwap = performance.now();
  const a = first ? phAnchorStored() : B.cw !== PH.cw && PH.idleA && PH.idleA.cw === PH.cw ? PH.idleA.a : phAnchorCapture();
  const shTop = PH.sh.open ? phSheetScrollTop() : 0;
  const old = PH.body;
  if (old) { old.replaceWith(B.body); phZero(old); } else PH.page.insertBefore(B.body, holder);
  holder.remove();
  PH.obs.forEach(o => o.disconnect()); PH.obs = [];
  PH.body = B.body; PH.cw = B.cw; PH.theme = B.theme; PH.wide = B.wide; PH.short = B.geo.short;
  PH.secs = B.secs; PH.flow = B.flow; PH.lens = B.lens; PH.tiers = B.tiers; PH.tiles = B.tiles; PH.tileBy = B.tileBy;
  PH.bays = B.bays; PH.eventBay = B.eventBay; PH.rail = B.rail; PH.buildMs = B.ms;
  G = PH.flow ? PH.flow.Gp : G;                          // threadPts / shimmer helpers read G: the phone's own layout
  phCrest(B);                                            // PULSE is one global: the crest is built in its visible box, last
  phSpineLayout();
  phAnchorRestore(a); PH.lastAnchor = a;
  phObserve();
  phNavCounts();
  if (PH.sel && !phSelValid(PH.sel)) PH.sel = null;
  phApplySel();
  if (PH.sh.open) phSheetRender(true, shTop);
  phOnScroll();
  PH.onSwap.forEach(f => { try { f(B); } catch (e) { console.warn(e); } });
  PH.swapMs = Math.round(performance.now() - tSwap);
}
function phZero(root) { root.querySelectorAll('canvas').forEach(c => { c.width = 0; c.height = 0; }); }
/* resize filter: a height-only resize (URL bar, keyboard, status strip) or the same theme again keeps the page */
function phKeep() {
  if (!PH.body || !PH.page) return false;
  const th = document.documentElement.getAttribute('data-theme') || 'dark';
  const W = phContentW();
  return W === PH.cw && th === PH.theme && phShort(W) === !!PH.short;   // a rotation into / out of a short frame rebuilds
}
function phOnResize() {
  if (!S.stacked || !PH.body) return;
  phSideMode();
  if (PH.sh.open) phDetent(PH.sh.detent, false);
  phObserveNav();
  phOnScroll();
}
function phSideMode() {
  const side = !!(window.matchMedia && window.matchMedia('(max-height: 500px)').matches) || phContentW() >= 700;
  PH.side = side; if (PH.root) PH.root.classList.toggle('phside', side);
  PH.navH = PH.nav ? PH.nav.offsetHeight || 44 : 44;
}

/* ---------------- anchors: role keys, never symbols ---------------- */
function phNavBottom() { return PH.nav ? PH.nav.getBoundingClientRect().bottom : 0; }
function phAnchorCapture() {
  if (!PH.body) return null;
  if (window.scrollY < 2) return { top: true };
  const nb = phNavBottom(), list = [...PH.body.querySelectorAll('[data-anchor]')];
  const rec = (e, r) => { const st = e.closest('[data-station]'); return { key: e.dataset.anchor, off: r.top - nb, frac: r.top < nb ? (nb - r.top) / Math.max(1, r.height) : 0, st: st && st.dataset.station }; };
  for (let i = 0; i < list.length; i++) {
    const r = list[i].getBoundingClientRect(); if (r.bottom <= nb + 1) continue;
    // only a sliver of this one is left under the nav: the reader is on the next one (when it starts in the upper half)
    if (r.top < nb && r.bottom - nb < Math.min(90, r.height * 0.25) && list[i + 1]) {
      const r2 = list[i + 1].getBoundingClientRect(); if (r2.top - nb < window.innerHeight * 0.5) return rec(list[i + 1], r2);
    }
    return rec(list[i], r);
  }
  return null;
}
function phAnchorRestore(a) {
  if (!a) return;
  if (a.top) { if (window.scrollY) window.scrollTo({ top: 0, behavior: 'instant' }); return; }
  const e = PH.body.querySelector(`[data-anchor="${a.key}"]`) || (a.st && PH.body.querySelector(`[data-station="${a.st}"]`));
  if (!e) return;
  // the same element at the same place: by the fraction scrolled past when it started above the nav (its height may
  // differ in the new layout, e.g. after a rotation), else by its offset under the nav
  const r = e.getBoundingClientRect(), same = e.dataset.anchor === a.key;
  const want = !same ? 0 : a.frac > 0 ? -a.frac * r.height : a.off;
  const dy = r.top - phNavBottom() - want;
  if (Math.abs(dy) > 0.5) window.scrollTo({ top: Math.max(0, window.scrollY + dy), behavior: 'instant' });
}
const PH_AKEY = 'ob.ph.anchor';
function phDay() { return (obMeta().generated_at_ist || '').slice(0, 10); }
/* the idle anchor: the place captured when scrolling settles under the current layout. A width / orientation rebuild
   restores it (the old body at the new width, and the browser's scroll clamp, would place the reader wrong) */
function phAnchorSave() {
  if (!PH.body || phContentW() !== PH.cw) return;       // the layout on screen is stale (mid rotation): keep the last good place
  const a = phAnchorCapture(); if (!a) return;
  PH.idleA = { a, cw: PH.cw };
  try { sessionStorage.setItem(PH_AKEY, JSON.stringify(Object.assign({ day: phDay() }, a))); } catch (e) { }
}
function phAnchorStored() {
  try { const a = JSON.parse(sessionStorage.getItem(PH_AKEY) || 'null'); if (a && a.day === phDay()) return a; } catch (e) { }
  return null;
}

/* ---------------- section scaffolding ---------------- */
function phSection(B, station, kind, key, extra) {
  const sec = el('section', 'phsec', B.body); sec.dataset.station = station;
  const rec = Object.assign({ key, station, el: sec, kind, vis: false, risen: false }, extra || {});
  B.secs.push(rec);
  return rec;
}
function phHead(parent, anchor, html, cls) {
  const h = el('header', 'phhd' + (cls ? ' ' + cls : ''), parent, html); h.dataset.anchor = anchor; return h;
}
function phCntBtn(parent, n, act, extra, cls) {
  const b = el('button', 'cnt phcnt' + (cls ? ' ' + cls : ''), parent, `<b>${n}</b>`);
  b.dataset.act = act; b.type = 'button'; if (extra) Object.assign(b.dataset, extra);
  return b;
}

/* ---------------- MARKET: crest (built after the swap), the six setups at a glance, sectors ---------------- */
function phBuildMarket(B) {
  const m = B.M, rec = phSection(B, 'market', 'market', 'market');
  phHead(rec.el, 'hd:market', `<b>MARKET</b><span>${m.lanes.length} STOCKS · AS OF ${obEndLabel()}</span>`);
  const crest = el('div', 'phcrest pulse', rec.el); crest.dataset.anchor = 'market';
  css(crest, { height: B.geo.crestH }); B.crestBox = crest;
  // the six setups at a glance (the desktop shows the six tickets on its first screen)
  const picks = [[1, m.buyPicks || []], [-1, m.sellPicks || []]], nPick = picks[0][1].length + picks[1][1].length;
  const rail = el('div', 'phrail', rec.el); rail.dataset.anchor = 'rail';
  const hd = el('div', 'phrailhd', rail);
  el('div', 'reactor phreact', hd, PH_REACTOR);
  phCntBtn(hd, nPick, 'list', { filter: 'setups' }, 'c6');
  el('span', 'k', hd, 'SETUPS');
  if (B.W >= 340) el('span', 'sub', hd, 'TAP TO JUMP · HOLD FOR DETAILS');
  const grid = el('div', 'phrailg', rail), chips = [];
  picks.forEach(([side, list]) => list.forEach(s => {
    const c = phSideVars(el('button', 'phpick ' + (side > 0 ? 'up' : 'dn'), grid), side);
    c.type = 'button'; c.dataset.k = s.s; c.dataset.act = 'pick'; c.dataset.bay = `bay:${phSd(side)}:${s.pick}`;
    c.setAttribute('aria-label', `${side > 0 ? 'Bullish' : 'Bearish'} setup ${s.pick}: ${s.s} ${pctStr(s.c)}`);
    c.innerHTML = `<span class="mg">${monogram(s)}</span><span class="tw"><b class="tk">${s.s}</b><span class="ln"><span class="pc">${pctStr(s.c)}</span><span class="rk">#${s.pick}</span></span></span>`;
    chips.push(c);
  }));
  B.rail = { el: rail, chips };
  // sectors, sorted by change
  const secs = (m.D.sectors || []).filter(x => x.n > 0).slice().sort((a, b) => b.chg - a.chg);
  const sw = el('div', 'phsecs', rec.el); sw.dataset.anchor = 'sectors';
  el('div', 'phsub', sw, `<b>SECTORS</b><span>${secs.length}</span>`);
  const g = el('div', 'schips', sw); g.style.gridTemplateColumns = `repeat(${B.geo.secCols},minmax(0,1fr))`;
  secs.forEach(x => {
    let strip = ''; for (let i = 0; i < x.n; i++) strip += `<i style="background:${i < x.adv ? 'rgba(30,158,110,.9)' : 'rgba(194,58,82,.75)'}"></i>`;
    const c = el('button', 'chip ' + (x.chg > 0 ? 'up' : 'dn'), g, `<div class="r1"><span class="cap">${phEsc(x.sec)}</span><span class="v" style="color:${x.chg > 0 ? 'rgba(124,255,196,.8)' : 'rgba(255,154,168,.8)'}">${pctStr(x.chg)}</span></div><div class="strip">${strip}</div>`);
    c.type = 'button'; c.dataset.sec = x.sec; c.setAttribute('aria-label', `${x.sec} ${pctStr(x.chg)}, ${x.adv} of ${x.n} up`);
  });
  B.secChips = g;
}
/* one type size for every chip label (buildChips' rule): tracking first, then size; the value never shrinks */
function phFitChips(g) {
  const chips = [...g.querySelectorAll('.chip')], caps = chips.map(c => c.querySelector('.cap'));
  const ok = () => chips.every(c => { const r = c.querySelector('.r1'); return r.scrollWidth <= r.clientWidth + 0.5; });
  if (ok()) return;
  caps.forEach(c => c.style.letterSpacing = '.03em'); if (ok()) return;
  let fs = parseFloat(getComputedStyle(caps[0]).fontSize), n = 12;
  while (!ok() && fs > 9 && n--) { fs -= 0.5; caps.forEach(c => c.style.fontSize = fs + 'px'); }
}
function phCrest(B) {
  const box = B.crestBox; if (!box) return;
  // the crest's scale-end labels are drawn at 8.5·tx: tx lifts them to 10 px on the phone
  PH.crest = obPulse(box, B.M, B.W, B.geo.crestH, S.dpr, true, 10 / 8.5);
  phFitChips(B.secChips);
  phFitRail(B.rail);
}
/* the six setup chips: one ticker size for all six (the longest sets it), never under 11 px */
function phFitRail(R) {
  if (!R || !R.chips.length) return;
  const tks = R.chips.map(c => c.querySelector('.tk')), over = () => tks.some(t => t.scrollWidth > t.clientWidth + 0.5);
  let fs = 15, n = 12; tks.forEach(t => { t.style.fontSize = ''; t.style.letterSpacing = ''; });
  while (over() && fs > 10 && n--) { fs -= 0.5; tks.forEach(t => t.style.fontSize = fs + 'px'); }
  if (over()) tks.forEach(t => t.style.letterSpacing = '-.02em');
}

/* ---------------- FLOW: the desktop's left third, drawn by the desktop functions at a phone layout ----------------
   Three tasks (the plume is the heaviest draw on the page): 0 = section, walls and thermometer, 1 = plume, 2 = ladder,
   the zero split, NOW, nodes, labels, gate windows and the overlay */
function phBuildFlow(B, phase) {
  const m = B.M, geo = B.geo, fx = geo.fx, AX = geo.AX, W = B.W;
  const draw = f => { const kSave = S.k; S.k = fx * S.dpr; S.noText = true; try { return f(); } finally { S.k = kSave; S.noText = false; } };
  if (phase === 0) {
    const rec = phSection(B, 'flow', 'flow', 'flow');
    const hd = phHead(rec.el, 'hd:flow', `<b>FLOW</b><span>${fmtMin(obOpenMin())} → ${obEndLabel()}</span>`);
    // replay the build show (the desktop's R / double-click): every section plays its intro again
    const rp = el('button', 'phreplay', hd, '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8.4a5.2 5.2 0 1 1-1.6-4.1"/><path d="M11.9 1.6v3h-3"/></svg>');
    rp.type = 'button'; rp.dataset.act = 'replay'; rp.setAttribute('aria-label', 'Replay the build'); rp.title = 'Replay';
    const Gp = warpQ(layout(geo.HdP, m)), padT = 20, yO = Gp.T0 - 12;
    const box = el('div', 'phflow', rec.el); box.dataset.anchor = 'flow';
    const wrap = el('div', 'phfw', box);
    B.fl = { rec, hd, Gp, padT, yO, box, wrap };
    B.fl.cvW = draw(() => drawWalls(m, Gp, wrap));     // the walls breathe on their own canvas, under the plume
    B.fl.cvA = draw(() => drawAxis(m, Gp, wrap));
    return;
  }
  if (phase === 1) { const f = B.fl; f.cvP = draw(() => drawPlume(m, f.Gp, f.wrap)); return; }
  const { rec, hd, Gp, padT, yO, box, wrap } = B.fl;
  const X = x => AX + (x - 66) * fx, Y = y => padT + (y - yO) * fx;
  // the bearish window's caption shares the hour row unless it would touch the bold end label
  const nR0 = obWinN(-1), capRow2 = X(696) - (obMeasure(`700 10px ${FONT_UI}`, 'TOP ' + nR0) + 14) < X(588) + 6;
  const H = Math.ceil(Y(Gp.T1) + 30 + (capRow2 ? 14 : 0));
  css(box, { height: H });
  const cvW = B.fl.cvW, cvA = B.fl.cvA, cvP = B.fl.cvP, cvL = draw(() => drawLadder(m, Gp, wrap));
  [cvW, cvA, cvP, cvL].forEach(cv => { cv.removeAttribute('id'); css(cv, { left: X(cv._x), top: Y(cv._y), width: cv._w * fx, height: cv._h * fx }); });
  cvW.classList.add('phwalls'); cvP.classList.add('phplume'); cvL.classList.add('phladder'); cvA.classList.add('phthermo');
  css(cvA, { left: 10 - 32 * fx });          // the thermometer hugs the left edge; the labels get the column
  // the desktop spine's own stretch: along the zero split from the origin beacon through NOW to the gate
  const yT = Y(Gp.yT), sp = localCanvas(box, W, 24, S.dpr, 'phzs dimmable'); css(sp.cv, { position: 'absolute', left: 0, top: yT - 12 });
  { const x = sp.ctx, a = X(66), b = X(590), c = X(690), y = 12;
    x.lineCap = 'round';
    x.save(); x.shadowColor = 'rgba(169,184,255,1)'; x.shadowBlur = 5 * S.dpr; x.strokeStyle = 'rgba(169,184,255,.35)'; x.lineWidth = 2; x.beginPath(); x.moveTo(a, y); x.lineTo(c, y); x.stroke(); x.restore();
    x.strokeStyle = '#fff'; x.lineWidth = 1; x.beginPath(); x.moveTo(a, y); x.lineTo(b, y); x.stroke();
    x.lineWidth = 1.5; x.beginPath(); x.moveTo(b, y); x.lineTo(c, y); x.stroke(); }
  const ov = localCanvas(box, W + 10, H, S.dpr, 'phov'); css(ov.cv, { position: 'absolute', left: 0, top: 0 });   // +10: the gate ring and glows near the right edge are never cut
  // NOW line + glow at the plume's right edge; origin beacon; NOW and gate nodes on the zero split
  const nowX = X(590);
  const glow = el('div', 'nowglow phnowglow', box); css(glow, { left: nowX + 0.5, top: Y(Gp.T0 - 8), height: (Gp.T1 - Gp.T0 + 8) * fx });
  const now = el('div', 'nowline phnow', box); css(now, { left: nowX, top: Y(Gp.T0 - 8), height: (Gp.T1 - Gp.T0 + 8) * fx });
  const node = (x, d, cls) => { const n = el('div', 'node ' + cls, box); css(n, { left: x, top: yT, width: d, height: d }); return n; };
  const beacon = node(X(66), 6, 'beacon'); el('div', 'ring', beacon);
  const nNow = node(nowX, 8 / Math.SQRT2 * 1.1, 'dia st'), nGate = node(X(690), 8, 'st');
  // the station counts as the desktop prints them: all stocks at NOW, the contenders at the gate (captions: their
  // buttons are the spine's own badges, so a finger on the lanes around them always opens the lane)
  const nAll = m.lanes.length, nSel = m.selected.length;
  const cAll = el('div', 'cnt phcap c209', box, `<b>${nAll}</b>`); css(cAll, { right: W - (nowX - 3), bottom: H - (yT - 3) });
  const cGate = el('div', 'cnt phcap c40', box, `<b>${nSel}</b>`); css(cGate, { right: W - (X(690) - 5), bottom: H - (yT - 3) });
  // % axis: the desktop's values at their true (warped) y, collision-dodged, leaders back to the true y
  const K = Gp.knots, vMax = K[0][0], vMin = K[K.length - 1][0];
  const items = [5, 3, 2, 1, 0.5, 0.2, 0, -0.2, -0.5, -0.75, -1, -1.25, -1.5, -2, -3]
    .filter(v => v === 0 || (v <= vMax + 1e-9 && v >= vMin - 1e-9))
    .map(v => ({ v, ty: Y(Gp.Q(v)), y: Y(Gp.Q(v)), t: v === 0 ? '0' : (v > 0 ? '+' : MINUS) + String(Math.abs(v)) }));
  const gap = 12.5;
  for (let it = 0; it < 60; it++) for (let i = 1; i < items.length; i++) { const d = items[i].y - items[i - 1].y; if (d < gap) { const p = (gap - d) / 2; items[i - 1].y -= p; items[i].y += p; } }
  items.forEach(o => o.y = clamp(o.y, Y(Gp.T0) - 2, Y(Gp.T1) + 2));
  const ax = el('div', 'phaxis', box); css(ax, { width: AX, height: H });
  let lp = '';
  items.forEach(o => {
    const l = el('span', 'lb' + (o.v === 0 ? ' z' : Math.abs(o.v) === 0.2 ? ' mi' : ''), ax, o.t); css(l, { top: o.y - 6, right: 6 });
    lp += `M${AX - 5} ${o.y.toFixed(1)}H${AX - 3.5}L${AX} ${o.ty.toFixed(1)}`;
  });
  ax.insertAdjacentHTML('beforeend', `<svg width="${AX}" height="${H}" aria-hidden="true"><path d="${lp}"/></svg>`);
  // hour axis under the plume: every hour that fits, the first label and the bold end label always
  const labs = obAxisLabels().map(([t, s], i) => ({ x: X(66 + t / NT * 524), s, al: i ? 'c' : 'l', pr: i ? 2 : 1 }));
  labs.push({ x: X(588), s: obEndLabel(), al: 'r', pr: 0, now: true });
  const cwid = 6.05, placed = [], ha = el('div', 'phhours', box); css(ha, { top: Y(Gp.T1) + 9 });
  labs.slice().sort((a, b) => a.pr - b.pr).forEach(o => {
    const w = o.s.length * cwid, x0 = o.al === 'l' ? o.x : o.al === 'r' ? o.x - w : o.x - w / 2;
    if (placed.some(p => x0 < p[1] + 6 && x0 + w > p[0] - 6)) return;
    placed.push([x0, x0 + w]);
    const l = el('span', o.now ? 'now' : '', ha, o.s); css(l, { left: x0, width: w });
    const tk = el('i', '', ha); css(tk, { left: Math.round(o.al === 'r' ? o.x - 1 : o.x) });
  });
  // the event's crash streak is labelled at its foot
  const pb = m.lanes[m.lanes.length - 1];
  if (pb && pb.event) { const c = el('span', 'phcrash', box, '⊘ ' + MINUS + Math.abs(pb.c).toFixed(2)); css(c, { left: X(66 + 126 / NT * 524) + 3, bottom: H - Y(Gp.T1 + 1) }); }
  // the two gate windows: captions and floating motes
  const nB = obWinN(1), nR = obWinN(-1);
  const capU = el('span', 'phwin up', box, `${PH_TRI[1]}TOP ${nB}`); css(capU, { right: W - X(696), bottom: H - (Y(Gp.T0) - 9) });
  const capD = el('span', 'phwin dn', box, `${PH_TRI[-1]}TOP ${nR}`); css(capD, { right: W - X(696), top: Y(Gp.T1) + 9 });
  if (capRow2) css(capD, { top: Y(Gp.T1) + 25 });          // narrow: its own row under the hours
  const motes = [[Gp.T0, Gp.T0 + nB * Gp.P, 1], [Gp.T1 - nR * Gp.P, Gp.T1, -1]].map(([y0, y1, side]) => {
    const w = el('div', 'gwin', box), hh = (y1 - y0) * fx, ww = 96 * fx; css(w, { left: X(593), top: Y(y0), width: ww, height: hh });
    const r = rng('gate', String(side));
    for (let i = 0; i < 9; i++) {
      const mo = el('i', 'gmote', w), x = (6 + r() * 66) * fx, y = 3 + r() * Math.max(0, hh - 6), d = 8 + r() * 7;
      css(mo, { left: x, top: y });
      mo.style.setProperty('--mc', SCHOT[side]); mo.style.setProperty('--dx', ((16 + r() * 22) * fx).toFixed(1) + 'px');
      mo.style.setProperty('--dy', ((r() - .5) * 8 * fx).toFixed(1) + 'px'); mo.style.setProperty('--md', d.toFixed(1) + 's');
      mo.style.setProperty('--mdl', (-r() * d).toFixed(2) + 's'); mo.style.setProperty('--mo', (0.45 + r() * 0.45).toFixed(2));
    }
    return w;
  });
  B.flow = {
    el: box, head: hd, fx, AX, padT, yO, Gp, W, H, X, Y, lane: k => Y(Gp.laneY(k)),
    cv: { walls: cvW, axis: cvA, plume: cvP, ladder: cvL, spine: sp.cv, over: ov.cv }, octx: ov.ctx,
    node: { beacon, now: nNow, gate: nGate }, cnt: { all: cAll, gate: cGate }, motes, nowline: now, nowglow: glow
  };
  rec.flow = B.flow;
}

/* ---------------- a branch: lens band + tiers c4 → c3 → c2 inside echo brackets ---------------- */
function phBuildBranch(B, side) {
  const m = B.M, geo = B.geo, W = B.W, sd = phSd(side), mos = m.mos[sd];
  const rec = phSection(B, sd, 'branch', 'branch:' + sd, { side });
  phSideVars(rec.el, side);
  const nCont = m.selected.filter(s => s.side === side).length;
  phHead(rec.el, 'hd:' + sd, `<b>${PH_TRI[side]}${side > 0 ? 'BULLISH' : 'BEARISH'}</b><span>${nCont} CONTENDERS</span>`, side > 0 ? 'up' : 'dn');
  const lensBox = el('div', 'phlens', rec.el); lensBox.dataset.anchor = 'lens:' + sd; css(lensBox, { height: geo.lensH });
  const tiersEl = el('div', 'phtiers', rec.el);
  const land = {};
  const all = m.selected.filter(s => s.side === side && !s.event);
  const cMax = Math.max(0.01, ...all.map(s => Math.abs(s.c)));
  ['c4', 'c3', 'c2'].forEach(key => {
    const list = mos[key]; if (!list.length) return;
    const t = geo.tier[key], n = t.n, gap = geo.gap, Wc = Math.floor((W - (n - 1) * gap) / n);
    const ranks = list.map(s => s.rank);
    const tier = el('div', 'phtier', tiersEl); tier.dataset.anchor = `tier:${sd}:${key}`;
    el('div', 'phthd', tier, `<span class="k">RANK ${String(Math.min(...ranks)).padStart(2, '0')}–${String(Math.max(...ranks)).padStart(2, '0')}</span><span class="n">${list.length}</span>`);
    const tb = el('div', 'phtb', tier);
    ['tl', 'tr', 'bl', 'br'].forEach(c => el('i', 'phecho ' + c, tb));
    const Ts = [], rows = [];
    for (let i = 0; i < list.length; i += n) {
      const row = list.slice(i, i + n), mean = row.reduce((a, s) => a + Math.abs(s.c), 0) / row.length;
      const h = Math.round(t.base * (0.8 + 0.4 * mean / cMax));
      const rw = el('div', 'phrow', tb); rw.style.gridTemplateColumns = `repeat(${row.length},${Wc}px)`;
      const off = (W - (row.length * Wc + (row.length - 1) * gap)) / 2;
      row.forEach((s, j) => {
        const cell = el('div', 'phcell', rw);
        const T = { s, key, w: Wc, h, side, pick: 0, row: rows.length, col: j, cx: off + j * (Wc + gap) + Wc / 2 };
        buildTile(m, T, cell, 'stack', true);
        Ts.push(T); land[s.s] = T.cx;
      });
      rows.push({ el: rw, h });
    }
    // one ticker size per tier (the longest symbol sets it), then one layout read and one paint per tile
    const fs = Math.min(...Ts.filter(T => T.tkFit).map(T => T.tkFit.fs));
    if (isFinite(fs)) Ts.forEach(T => { if (!T.tkFit) return; T.tkFit = tickerFit(T.s.s, fs, T.sp.tkAvail, T.sp.floor); applyTicker(T.tkEl, T.tkFit); });
    Ts.forEach(T => { if (T.plate) readTilePlate(T); });
    Ts.forEach(T => { if (T.plate) finishTile(T); if (T.cv) T.cv.style.opacity = COLDIM[key]; T.built = true; B.tiles.push(T); B.tileBy[T.s.s] = T; });
    B.tiers.push({ side, key, el: tier, rows, tiles: Ts });
  });
  // picks land mid-rim (their tiles are in the setup bays below); the event lands at the right end
  (side > 0 ? m.buyPicks : m.sellPicks).forEach(s => { land[s.s] = W / 2 + (s.pick - 2) * 18; });
  m.selected.filter(s => s.side === side && s.event).forEach(s => { land[s.s] = W - 14; });
  B.lens[side] = phLens(lensBox, side, W, geo.lensH, land, m);
  rec.lens = B.lens[side];
}
/* the lens band: a slit fed by the gate window (one notch per contender, rank order), a cone widening to the tiers,
   one fibre per contender to its own tile's x on the rim, the rim's landing glow */
function phLens(box, side, W, H, land, m) {
  const { cv, ctx } = localCanvas(box, W, H, S.dpr, 'phlenscv');
  const list = m.selected.filter(s => s.side === side).sort((a, b) => (a.event - b.event) || (a.rank - b.rank));
  const n = Math.max(1, list.length), slitW = Math.min(W * 0.62, n * 12), sx0 = (W - slitW) / 2;
  const slitY = 9, rimY = H - 2, notch = {};
  list.forEach((s, i) => { notch[s.s] = sx0 + (i + 0.5) * slitW / n; });
  const L = { el: box, cv, ctx, w: W, h: H, side, slitY, rimY, sx0, sx1: sx0 + slitW, notch, land, list };
  L.draw = hi => phLensDraw(L, hi);
  L.draw(null);
  return L;
}
function phLensDraw(L, hi) {
  const { ctx, w, h, side, slitY, rimY, sx0, sx1 } = L, rgb = SC[side], hot = SCHOT[side], k = S.dpr;
  const dim = hi && hi.size ? 0.35 : 1;                  // a selection: everything but its own fibre steps back
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, L.cv.width, L.cv.height); ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = dim;
  const edge = (a, b) => [[a, slitY], [a, slitY + (rimY - slitY) * .55], [b, rimY - (rimY - slitY) * .5], [b, rimY]];
  const le = edge(sx0, 0), re = edge(sx1, w);
  const cone = () => { ctx.beginPath(); ctx.moveTo(...le[0]); ctx.bezierCurveTo(...le[1], ...le[2], ...le[3]); ctx.lineTo(...re[3]); ctx.bezierCurveTo(...re[2], ...re[1], ...re[0]); ctx.closePath(); };
  // cone: scanline fill brightest at the slit
  ctx.save(); cone(); ctx.clip();
  const g = ctx.createLinearGradient(0, slitY, 0, rimY); g.addColorStop(0, `rgba(${rgb},.20)`); g.addColorStop(1, `rgba(${rgb},.07)`);
  ctx.fillStyle = g; for (let y = slitY; y < rimY; y += 3) ctx.fillRect(0, y, w, 1);
  const g2 = ctx.createLinearGradient(0, slitY, 0, rimY); g2.addColorStop(0, `rgba(${rgb},.06)`); g2.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g2; ctx.fillRect(0, slitY, w, rimY - slitY); ctx.restore();
  ctx.strokeStyle = `rgba(${rgb},.5)`; ctx.lineWidth = 1;
  [le, re].forEach(e => { ctx.beginPath(); ctx.moveTo(...e[0]); ctx.bezierCurveTo(...e[1], ...e[2], ...e[3]); ctx.stroke(); });
  // fibres, from each notch to its own tile's x on the rim (picks thicker, the brushed ones white)
  const lit = [];
  L.list.forEach(s => {
    const x0 = L.notch[s.s], x1 = L.land[s.s]; if (x0 == null || x1 == null) return;
    const on = hi && hi.has(s.s); if (on) { lit.push(s); return; }
    const c = s.event ? '255,176,32' : rgb, pk = !!s.pick;
    ctx.strokeStyle = `rgba(${c},${pk ? .7 : .35})`; ctx.lineWidth = pk ? 1.2 : .75;
    ctx.beginPath(); ctx.moveTo(x0, slitY + 2); ctx.bezierCurveTo(x0, slitY + (rimY - slitY) * .5, x1, rimY - (rimY - slitY) * .45, x1, rimY); ctx.stroke();
  });
  lit.forEach(s => {
    const x0 = L.notch[s.s], x1 = L.land[s.s];
    ctx.save(); ctx.globalAlpha = 1; ctx.shadowColor = `rgba(${s.event ? '255,176,32' : rgb},1)`; ctx.shadowBlur = 6 * k; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, slitY + 2); ctx.bezierCurveTo(x0, slitY + (rimY - slitY) * .5, x1, rimY - (rimY - slitY) * .45, x1, rimY); ctx.stroke(); ctx.restore();
  });
  // the slit: lit, with one notch per contender
  ctx.save(); ctx.shadowColor = `rgba(${rgb},.9)`; ctx.shadowBlur = 8 * k; ctx.fillStyle = `rgba(${rgb},.85)`; ctx.fillRect(sx0 - 3, slitY - 1, sx1 - sx0 + 6, 2); ctx.restore();
  ctx.fillStyle = `rgba(${hot},.9)`; ctx.fillRect(sx0 - 1, slitY - .5, sx1 - sx0 + 2, 1);
  L.list.forEach(s => {
    const x = L.notch[s.s], on = hi && hi.has(s.s);
    ctx.fillStyle = on ? '#fff' : s.event ? 'rgba(255,176,32,.95)' : s.pick ? `rgba(${hot},1)` : `rgba(${rgb},.8)`;
    ctx.fillRect(Math.round(x * k) / k - .5, slitY - 4, 1, 8);
  });
  // the slit's crop brackets (the gate window's)
  ctx.strokeStyle = `rgba(${hot},1)`; ctx.lineWidth = 1.5; ctx.beginPath();
  [[sx0 - 7, 1], [sx1 + 7, -1]].forEach(([x, d]) => { ctx.moveTo(x + d * 5, slitY - 6); ctx.lineTo(x, slitY - 6); ctx.lineTo(x, slitY + 6); ctx.lineTo(x + d * 5, slitY + 6); });
  ctx.stroke();
  // rim landing glow
  const xs = L.list.map(s => L.land[s.s]).filter(x => x != null);
  for (let x = 0; x < w; x += 1) {
    let a = 0.08; xs.forEach(c => { a += 0.8 * Math.exp(-((x - c) ** 2) / (2 * 3.5 * 3.5)); });
    ctx.fillStyle = `rgba(${rgb},${Math.min(.9, a).toFixed(3)})`; ctx.fillRect(x, rimY, 1, 2);
  }
  ctx.globalAlpha = 1;
}

/* ---------------- setup bays: the pick's tile + bridge + reticle + its card ---------------- */
function phBuildBays(B, side) {
  const m = B.M, W = B.W, sd = phSd(side), picks = side > 0 ? m.buyPicks : m.sellPicks;
  const rec = B.secs.find(r => r.key === 'branch:' + sd), parent = rec ? rec.el : B.body;
  const hd = phHead(parent, `hd:${sd}:setups`, `<b>${PH_TRI[side]}${side > 0 ? 'BULLISH' : 'BEARISH'} SETUPS</b><span>${picks.length}</span>`, 'set ' + (side > 0 ? 'up' : 'dn'));
  if (rec) rec.setHead = hd;
  const tk = B.wide ? layout(1080, m).tk : null;
  picks.forEach(s => {
    const bay = phBay(B, parent, s, side, s.pick, tk);
    B.secs.push({ key: `bay:${sd}:${s.pick}`, station: sd, el: bay.el, kind: 'bay', side, pick: s.pick, bay, vis: false, risen: false });
  });
}
function phBay(B, parent, s, side, pick, tk) {
  const m = B.M, W = B.W, sd = phSd(side);
  const bay = el('div', 'phbay' + (B.wide ? ' row' : ''), parent); bay.dataset.k = s.s; bay.dataset.anchor = `bay:${sd}:${pick}`;
  phSideVars(bay, side);
  let T, TK, ret, br;
  if (!B.wide) {
    const dock = el('div', 'phdock', bay);
    T = { s, key: 'c1', w: W, h: B.geo.stripH, side, pick };
    buildTile(m, T, dock, 'stack');
    ret = el('div', 'ret', dock, '<i></i><i></i><i></i><i></i>'); css(ret, { left: -5, top: -5, width: W + 10, height: T.h + 10 });
    br = phSideVars(el('div', 'bridge phbridge', bay), side); br.dataset.k = s.s;
    TK = { s, w: W, h: 0, side, pick };
    buildTicket(m, TK, bay, 'stack'); fitTicket(TK);
  } else {
    // the literal desktop row: tile 166 | bridge 28 | the card in stage mode, desktop heights
    const h = side > 0 ? [tk.h1, tk.h2, tk.h3][pick - 1] : [tk.h1b, tk.h2b, tk.h3b][pick - 1];
    const dock = el('div', 'phdock', bay); css(dock, { width: 166, height: h });
    T = { s, key: 'c1', w: 166, h, side, pick };
    buildTile(m, T, dock, 'stack');
    ret = el('div', 'ret', dock, '<i></i><i></i><i></i><i></i>'); css(ret, { left: -5, top: -5, width: 176, height: h + 10 });
    const bc = el('div', 'phbrc', bay); br = phSideVars(el('div', 'bridge phbridge h', bc), side); br.dataset.k = s.s;
    const cc = el('div', 'phcard', bay);
    TK = { s, x: 0, y: 0, w: W - 194, h, side, pick };
    buildTicket(m, TK, cc, 'stage'); fitTicket(TK);
  }
  T.built = true; T.ret = ret;
  B.tiles.push(T); B.tileBy[s.s] = T;
  const o = { side, pick, s, el: bay, tile: T, bridge: br, ret, TK };
  B.bays.push(o);
  return o;
}
function phBuildEvent(B) {
  const m = B.M, W = B.W, s = m.mos.bear.c1.find(x => x.event);
  if (!s) return;
  const rec = phSection(B, 'bear', 'event', 'event', { side: -1 });
  phHead(rec.el, 'hd:event', '<b class="ev">⊘ EVENT</b><span>EVENT RISK · NO TRADE</span>', 'ev');
  const bay = el('div', 'phbay ev' + (B.wide ? ' row' : ''), rec.el); bay.dataset.k = s.s; bay.dataset.anchor = 'event';
  phSideVars(bay, -1, true);
  const dock = el('div', 'phdock', bay);
  const T = { s, key: 'c1', w: B.wide ? 166 : W, h: 44, side: -1, pick: 0, event: true };
  if (B.wide) css(dock, { width: 166, height: 44 });
  buildTile(m, T, dock, 'stack');
  const bc = B.wide ? el('div', 'phbrc', bay) : bay;
  const br = phSideVars(el('div', 'bridge phbridge' + (B.wide ? ' h' : ''), bc), -1, true); br.dataset.k = s.s;
  const cc = B.wide ? el('div', 'phcard', bay) : bay;
  const TK = { s, w: B.wide ? W - 194 : W, h: 54 };
  buildAnomaly(m, TK, cc, 'stack');
  T.built = true; B.tiles.push(T); B.tileBy[s.s] = T;
  B.eventBay = { side: -1, s, el: bay, tile: T, bridge: br, TK };
  rec.bay = B.eventBay;
}
function phBuildFoot(B) {
  const f = el('div', 'sfoot phfoot', B.body); f.dataset.anchor = 'end'; f.textContent = FOOT_TXT;
  B.spine = el('div', 'sspine phspine', B.body);
}

/* ---------------- spine, station nodes, count badges (placed once the page is laid out) ---------------- */
function phSpineLayout() {
  const body = PH.body; if (!body) return;
  body.querySelectorAll('.phnode,.phncnt').forEach(e => e.remove());
  const sp = body.querySelector('.phspine'); if (!sp) return;
  const yOf = e => { let y = 0; while (e && e !== body) { y += e.offsetTop; e = e.offsetParent; } return y; };
  const mid = e => yOf(e) + e.offsetHeight / 2;
  const nodes = [];
  const add = (key, y, cls, cnt, extra) => {
    const n = el('div', 'node phnode ' + cls, body); css(n, { top: y }); n.dataset.node = key;
    if (cls.includes('beacon')) el('div', 'ring', n);
    let c = null;
    if (cnt != null) { c = phCntBtn(body, cnt, 'list', extra, 'phncnt' + (key.endsWith('setups') ? ' c6' : '')); css(c, { top: y + 9 }); c.setAttribute('aria-label', `${cnt}: open the list`); }
    nodes.push({ key, el: n, y, cnt: c });
  };
  const hdM = body.querySelector('[data-anchor="hd:market"]'), F = PH.flow;
  if (hdM) add('market', mid(hdM), 'beacon');
  // flow: every stock leaves the origin on the zero split; the gate (its contenders) closes the flow station
  if (F) { add('flow', yOf(F.el) + F.Y(F.Gp.yT), 'dia st', M.lanes.length, { filter: 'all' }); add('gate', yOf(F.el) + F.H - 6, 'st gate', M.selected.length, { filter: 'contenders' }); }
  [1, -1].forEach(side => {
    const sd = phSd(side), L = PH.lens[side], hs = body.querySelector(`[data-anchor="hd:${sd}:setups"]`);
    const nC = M.selected.filter(s => s.side === side).length, nP = (side > 0 ? M.buyPicks : M.sellPicks).length;
    if (L) add('lens:' + sd, yOf(L.el) + L.slitY, 'st lens ' + (side > 0 ? 'up' : 'dn'), nC, { filter: 'contenders', side: String(side) });
    if (hs) add(sd + ':setups', mid(hs), 'st set ' + (side > 0 ? 'up' : 'dn'), nP, { filter: 'setups', side: String(side) });
  });
  const ev = body.querySelector('[data-anchor="hd:event"]'); if (ev) add('event', mid(ev), 'st ev');
  const top = nodes.length ? nodes[0].y : 0, last = PH.bays.length ? PH.bays[PH.bays.length - 1].el : null;
  const endEl = PH.eventBay ? PH.eventBay.el : last;
  const bottom = endEl ? yOf(endEl) + endEl.offsetHeight : body.offsetHeight;
  const H = Math.max(1, bottom - top);
  css(sp, { top, height: H });
  // brighter at the setups: gradient stops at the two setup runs
  const at = key => { const n = nodes.find(o => o.key === key); return n ? clamp((n.y - top) / H * 100, 0, 100) : 50; };
  sp.style.setProperty('--s1', at('bull:setups').toFixed(1) + '%'); sp.style.setProperty('--s2', at('lens:bear').toFixed(1) + '%');
  sp.style.setProperty('--s3', at('bear:setups').toFixed(1) + '%');
  PH.spine = { el: sp, top, bottom, nodes };
}

/* ---------------- station nav ---------------- */
function phNavCounts() {
  const n = PH.nav; if (!n || !M) return;
  const set = (k, v) => { const e = n.querySelector(`[data-n="${k}"]`); if (e) e.textContent = v; };
  set('all', M.lanes.length);
  const nb = M.selected.filter(s => s.side > 0).length, nr = M.selected.filter(s => s.side < 0).length;
  set('bull', nb); set('bear', nr);
  const lb = (to, t) => { const e = n.querySelector(`.phn[data-to="${to}"]`); if (e) e.setAttribute('aria-label', t); };
  lb('bull', `Bullish: top ${nb} contenders`); lb('bear', `Bearish: top ${nr} contenders`);
  const b = n.querySelector('.bd .b'), r = n.querySelector('.bd .r');
  if (b) { const f = M.nBullAll / Math.max(1, M.nBullAll + M.nBearAll); b.style.flex = String(f); r.style.flex = String(1 - f); }
}
function phStationEl(k) { return PH.body && PH.body.querySelector(`[data-station="${k}"]`); }
function phScrollToEl(e, off, smooth) {
  if (!e) return;
  const y = window.scrollY + e.getBoundingClientRect().top - phNavBottom() - (off == null ? 6 : off);
  window.scrollTo({ top: Math.max(0, y), behavior: smooth === false ? 'instant' : 'smooth' });
}
/* the lit station: the last one whose top has passed a line ~35% down the view (right after a jump and while
   scrolling); a tapped chip lights at once and holds until the jump's scroll settles */
function phNavLight(to) { if (PH.nav) PH.nav.querySelectorAll('.phn[data-to]').forEach(b => b.classList.toggle('on', b.dataset.to === to)); }
function phNavActive() {
  if (!PH.body || !PH.nav) return;
  if (PH.navHold) { if (performance.now() - PH.lastScroll < 160 && performance.now() - PH.navHold.t < 2500) { phNavLight(PH.navHold.to); return; } PH.navHold = null; }
  const line = phNavBottom() + window.innerHeight * 0.35;
  let act = 'market';
  if (window.scrollY >= 4) PH.body.querySelectorAll('[data-station]').forEach(e => { if (e.getBoundingClientRect().top <= line) act = e.dataset.station; });
  phNavLight(act);
}
function phObserveNav() { phNavActive(); }
let PH_SCROLL_RAF = 0, PH_SAVE_T = 0;
function phOnScrollEv() { PH.lastScroll = performance.now(); phOnScroll(); }   // real scrolls only (a tap right after one is a stop)
function phOnScroll() {
  if (PH_SCROLL_RAF) return;
  PH_SCROLL_RAF = requestAnimationFrame(() => {
    PH_SCROLL_RAF = 0;
    if (!PH.nav || !S.stacked) return;
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight), f = clamp(window.scrollY / max, 0, 1);
    const i = PH.nav.querySelector('.phprog i'); if (i) i.style.transform = `translateX(${(f * (PH.nav.clientWidth - 8)).toFixed(1)}px)`;
    phNavActive();
  });
  clearTimeout(PH_SAVE_T); PH_SAVE_T = setTimeout(() => { phAnchorSave(); phNavActive(); }, 400);
}

/* ---------------- section visibility: on-screen flags (the intros' own trigger is the motion layer's) ---------------- */
function phObserve() {
  phObserveNav();
  if (!window.IntersectionObserver) { PH.secs.forEach(r => { r.vis = true; if (PH.crest) PH.crest.off = false; }); return; }
  const io = new IntersectionObserver(ents => ents.forEach(en => {
    const r = en.target._ph; if (!r) return;
    r.vis = en.isIntersecting;
    if (r.key === 'market' && PH.crest) { PH.crest.off = !r.vis; if (r.vis && typeof obPulseWake === 'function') obPulseWake(PH.crest); }
    if (r.vis) phLoopKick();
  }), { threshold: [0, 0.15] });
  PH.secs.forEach(r => { r.el._ph = r; io.observe(r.el); });
  PH.obs.push(io);
}

/* ---------------- one phone rAF loop (the motion layer adds frames with phFrame) ---------------- */
function phFrame(fn) { PH.frames.add(fn); phLoopKick(); return fn; }
function phLoopKick() { if (PH.looping || !PH.frames.size || document.hidden) return; PH.looping = true; requestAnimationFrame(phLoop); }
function phLoop(now) {
  if (!S.stacked || document.hidden || !PH.frames.size) { PH.looping = false; return; }
  PH.frames.forEach(fn => { let keep = true; try { keep = fn(now) !== false; } catch (e) { console.warn(e); keep = false; } if (!keep) PH.frames.delete(fn); });
  requestAnimationFrame(phLoop);
}

/* ---------------- selection = the desktop brush, touch version ---------------- */
function phSelValid(h) { return h.kind === 'stock' || h.kind === 'anomaly' ? !!M.bySym[h.sym] : h.kind === 'sector' ? M.stocks.some(s => s.sec === h.sec) : false; }
function phSelect(h) { PH.sel = h; phApplySel(); PH.onSelect.forEach(f => { try { f(h); } catch (e) { } }); }
function phApplySel() {
  const root = PH.root, h = PH.sel; if (!root) return;
  root.querySelectorAll('.lit,.hot').forEach(e => e.classList.remove('lit', 'hot'));
  root.classList.toggle('brush', !!h);
  obPulseMark(h ? (h.kind === 'anomaly' ? { kind: 'stock', sym: h.sym } : h) : null);
  let syms = null;
  if (h) {
    syms = h.kind === 'sector' ? new Set(M.stocks.filter(s => s.sec === h.sec).map(s => s.s)) : new Set([h.sym]);
    syms.forEach(sym => root.querySelectorAll(`[data-k="${CSS.escape(sym)}"]`).forEach(e => e.classList.add('lit')));
    const sec = h.kind === 'sector' ? h.sec : (M.bySym[h.sym] || {}).sec;
    if (sec) root.querySelectorAll(`.schips .chip[data-sec="${CSS.escape(sec)}"]`).forEach(e => e.classList.add('hot'));
  }
  [1, -1].forEach(side => { const L = PH.lens[side]; if (L) L.draw(syms); });
  PH.drawOverlay(performance.now());
}
/* the flow overlay: the brushed stock's chain (thread → NOW → its ladder bar → the gate), a sector's threads, or the
   event's crash streak. Drawn in design coords of the phone layout; line widths in css px */
PH.drawOverlay = function (now) {
  const F = PH.flow; if (!F) return;
  const ctx = F.octx, k = S.dpr, fx = F.fx, Gp = F.Gp, u = 1 / fx;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, F.cv.over.width, F.cv.over.height);
  if (PH.overUnder) { ctx.save(); try { PH.overUnder(ctx, now || performance.now(), F); } finally { ctx.restore(); } }   // particles, flashes (motion layer)
  const h = PH.sel; if (!h) return;
  const g0 = G; G = Gp;
  try {
    ctx.setTransform(k * fx, 0, 0, k * fx, k * (F.AX - 66 * fx), k * (F.padT - F.yO * fx));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (h.kind === 'stock') {
      const s = M.bySym[h.sym]; if (!s) return;
      const rgb = s.event ? '255,176,32' : SC[s.side], y = Gp.laneY(s.lane), len = ladderLen(M, s);
      const segs = [threadPts(s, 0), s.sel ? [[590, y], [690, y]] : [[590, y], [592 + len, y]]];
      ctx.save(); ctx.strokeStyle = 'rgba(232,241,255,.28)'; ctx.lineWidth = u; ctx.setLineDash([2 * u, 3 * u]);
      ctx.beginPath(); ctx.moveTo(66, y); ctx.lineTo(690, y); ctx.stroke(); ctx.restore();
      ctx.save();
      segs.forEach(sg => { ctx.strokeStyle = `rgba(${rgb},.55)`; ctx.lineWidth = 4 * u; ctx.shadowColor = `rgba(${rgb},1)`; ctx.shadowBlur = 8 * k; strokePts(ctx, sg); });
      ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4 * u; segs.forEach(sg => strokePts(ctx, sg));
      ctx.setLineDash([5 * u, 7 * u]); ctx.lineDashOffset = -((now || 0) / 1000 * 30 * u) % (12 * u); ctx.strokeStyle = `rgba(${SCHOT[s.side > 0 ? 1 : -1]},.95)`; ctx.lineWidth = 1.2 * u;
      segs.forEach(sg => strokePts(ctx, sg.map(p => [p[0], p[1] - 2.6 * u]))); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(592, y - 1.3 * u, len, 2.6 * u);
      if (!s.sel) {
        // a herd stock stops short of the gate: the desktop's expanding ring at the gate (900 ms)
        const q = ((now || 0) % 900) / 900;
        ctx.strokeStyle = `rgba(255,255,255,${(0.95 * (1 - q)).toFixed(3)})`; ctx.lineWidth = 1.3 * u; ctx.beginPath(); ctx.arc(690, y, (3 + 11 * q) * u, 0, 7); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.beginPath(); ctx.arc(690, y, 2.2 * u, 0, 7); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([u, 3 * u]); ctx.beginPath(); ctx.moveTo(592 + len, y); ctx.lineTo(690, y); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
    } else if (h.kind === 'sector') {
      ctx.save();
      M.stocks.filter(s => s.sec === h.sec).forEach(s => {
        ctx.strokeStyle = `rgba(${SC[s.side]},.9)`; ctx.lineWidth = 1.3 * u; ctx.shadowColor = `rgba(${SC[s.side]},1)`; ctx.shadowBlur = 5 * k; strokePts(ctx, threadPts(s, 0));
        ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.fillRect(592, Gp.laneY(s.lane) - 1.2 * u, ladderLen(M, s), 2.4 * u);
      });
      ctx.restore();
    } else if (h.kind === 'anomaly') {
      const xs = 66 + 126 / NT * 524, y0 = Gp.Q(-1.1), q = ((now || 0) % 700) / 700;   // pulses like the desktop's (700 ms)
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.shadowColor = 'rgba(255,176,32,1)'; ctx.shadowBlur = 12 * k; ctx.fillStyle = `rgba(255,176,32,${(0.9 - 0.6 * q).toFixed(3)})`;
      ctx.fillRect(xs - 1.4 * u, y0, 2.8 * u, Gp.T1 + 8 - y0); ctx.fillRect(xs, Gp.T1 + 2.5, 590 - xs, 2.6 * u); ctx.restore();
    }
  } finally { G = g0; }
};

/* ---------------- the pointer router: every surface opens the right thing ---------------- */
function phRouterBind(root) {
  let st = null;
  const clearHold = () => { if (st && st.hold) { clearTimeout(st.hold); st.hold = 0; } };
  root.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    PH.finger = true;
    // a touch that stops a momentum scroll is not a tap (nor a hold)
    st = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, target: e.target, lock: null, moved: 0, wasScrolling: performance.now() - PH.lastScroll < 120 };
    if (!e.target.closest('.phnav')) PH.navHold = null;
    const crest = e.target.closest('.phcrest');
    if (crest && !e.target.closest('.ptag')) st.crest = crest;
    const pick = e.target.closest('.phpick');
    if (pick && !st.wasScrolling) st.hold = setTimeout(() => { if (!st || st.moved > 10) return; st.held = true; phOpenStock(pick.dataset.k, phCtxSetups(), { from: 'rail' }); }, 480);
  }, { passive: true });
  root.addEventListener('pointermove', e => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y; st.moved = Math.max(st.moved, Math.hypot(dx, dy));
    if (st.moved > 10) clearHold();
    if (!st.lock && st.moved >= 8) st.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    if (st.lock === 'h' && st.crest) { if (!st.scrub && PH.hurry && PH.introBusy()) PH.hurry(); phScrub(st, e); }
  }, { passive: true });
  const end = e => {
    if (!st || e.pointerId !== st.id) return;
    const s0 = st; st = null; PH.finger = false; clearHold();
    if (e.type === 'pointercancel') { if (s0.scrub) phScrubEnd(s0, false); return; }
    if (s0.scrub) { phScrubEnd(s0, true); return; }
    if (s0.held) return;
    if (s0.wasScrolling) { PH.lastTap = performance.now(); return; }   // (lastTap: the click it synthesises is not a keyboard click)
    if (s0.moved < 10 && performance.now() - s0.t < 350) { PH.lastTap = performance.now(); phTap(e, s0.target); }
  };
  root.addEventListener('pointerup', end, { passive: true });
  root.addEventListener('pointercancel', end, { passive: true });
  // keyboard (Enter / Space on a focused control): clicks that no pointer tap produced
  root.addEventListener('click', e => { if (e.detail === 0 && performance.now() - (PH.lastTap || 0) > 400) phTap(e, e.target); });
}
function phTap(e, target) {
  const act = target.closest('[data-act]');
  if (act && PH.root.contains(act)) { phAct(act, e); return; }   // controls (nav, counts, sheet buttons) never wait
  if (target.closest('#sheet')) return;                 // inside the sheet: never closes it
  // a tap that opens something on the page while a section's intro plays waits for it (the build is never disturbed);
  // the intro is asked to finish quickly, so the wait stays short (≤ ~0.8 s)
  if (PH.hurry && PH.introBusy()) PH.hurry();
  const card = target && target.closest ? target.closest('.ticket, .tile, .anom') : null;
  const cardSym = card && card.dataset && card.dataset.k;
  const cardStock = cardSym && PH.body && PH.body.contains(card) && M && M.bySym ? M.bySym[cardSym] : null;
  if (cardStock && !cardStock._anchor) {
    if (e.metaKey) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      openUpstoxStockTab(cardStock, card);
      return;
    }
    if (!e._retried) copyStockCode(cardStock.s, card);
    if (e.pointerType && e.pointerType !== 'touch') return;
  }
  if (performance.now() < PH.holdUntil) { const t = target, cx = e.clientX, cy = e.clientY, mk = !!e.metaKey, pt = e.pointerType || ''; setTimeout(() => phTap({ clientX: cx, clientY: cy, target: t, metaKey: mk, pointerType: pt, _retried: true }, t), PH.holdUntil - performance.now() + 10); return; }
  const k = target.closest('[data-k]');
  if (k && PH.body && PH.body.contains(k) && M.bySym[k.dataset.k]) {
    const s = M.bySym[k.dataset.k];
    if (s._anchor) return;
    if (s.event && (k.classList.contains('anom') || k.closest('.phbay.ev'))) { phOpenStock(s.s, [s.s], { kind: 'anomaly', el: k }); return; }
    const inBay = k.closest('.phbay');
    phOpenStock(s.s, inBay ? phCtxSetups() : phCtxBranch(s.side), { el: k });
    return;
  }
  const sec = target.closest('[data-sec]');
  if (sec) { phOpenSector(sec.dataset.sec); return; }
  const crest = target.closest('.phcrest');
  if (crest) { const h = obPulseHit(crest, e); if (h) { if (h.kind === 'sector') phOpenSector(h.sec); else phOpenLane(M.bySym[h.sym], crest); return; } }
  const F = PH.flow;
  if (F && F.el.contains(target)) {
    const r = F.el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const xd = 66 + (x - F.AX) / F.fx, yd = F.yO + (y - F.padT) / F.fx, Gp = F.Gp;
    if (xd >= 56 && xd <= 704 && yd >= Gp.T0 - 2 && yd < Gp.T1 + 2) {
      const lane = clamp(Math.floor((yd - Gp.T0) / Gp.P), 0, M.lanes.length - 1);
      phOpenLane(M.lanes[lane], target); return;
    }
  }
  // empty space: clears the selection and closes the sheet
  if (PH.sel || PH.sh.open) { phSheetClose(); }
}
function phAct(b, e) {
  const a = b.dataset.act;
  if (a === 'nav') { const to = b.dataset.to, t = to === 'market' ? PH.body && PH.body.firstElementChild : phStationEl(to); PH.navHold = { to, t: performance.now() }; PH.lastScroll = performance.now(); phNavLight(to); if (to === 'market') window.scrollTo({ top: 0, behavior: 'smooth' }); else phScrollToEl(t); return; }
  if (a === 'find') { phOpenList('all', 0); return; }
  if (a === 'list') { phOpenList(b.dataset.filter || 'all', +(b.dataset.side || 0)); return; }
  if (a === 'pick') { const bay = PH.body && PH.body.querySelector(`[data-anchor="${b.dataset.bay}"]`); if (bay) { phScrollToEl(bay, 10); phPulseBay(bay); } return; }
  if (a === 'close') { phSheetClose(); return; }
  if (a === 'step') { phStep(+b.dataset.d); return; }
  if (a === 'jump') { phJump(b.dataset.to); return; }
  if (a === 'sector') { phOpenSector(b.dataset.sec); return; }
  if (a === 'open') { const L = PH.sh.list || [b.dataset.k]; phOpenStock(b.dataset.k, L, { from: 'list' }); return; }
  if (a === 'filter') { PH.sh.filter = b.dataset.f; if (b.dataset.f === 'all' || b.dataset.f === 'event') PH.sh.fside = 0; phSheetRender(false); return; }
  if (a === 'unside') { PH.sh.fside = 0; phSheetRender(false); return; }
  if (a === 'replay') { if (typeof phReplay === 'function') phReplay(b); return; }
}
function phPulseBay(bay) {
  const acc = bay.querySelector('.ticket .acc'); if (acc) { acc.classList.remove('pulse'); void acc.offsetWidth; acc.classList.add('pulse'); }
  bay.classList.remove('phping'); void bay.offsetWidth; bay.classList.add('phping');
}
/* context lists behind ‹ ›: page order for the branch, the six setups, the sector members, lanes for coordinate taps */
function phCtxBranch(side) {
  const mos = M.mos[phSd(side)], out = [];
  ['c4', 'c3', 'c2'].forEach(k => mos[k].forEach(s => out.push(s.s)));
  (side > 0 ? M.buyPicks : M.sellPicks).forEach(s => out.push(s.s));
  return out;
}
function phCtxSetups() { const o = []; M.buyPicks.forEach(s => o.push(s.s)); M.sellPicks.forEach(s => o.push(s.s)); M.mos.bear.c1.filter(s => s.event).forEach(s => o.push(s.s)); return o; }
/* a lane (flow) or a dot (crest): a small rect at its own y, brought above the sheet like any tapped element */
function phLaneRect(s, from) {
  const crest = from && from.closest && from.closest('.phcrest');
  return () => {
    let y = null, r;
    if (crest) {
      r = crest.getBoundingClientRect(); const Z = PH.crest, d = Z && Z.P && Z.P.dots.find(o => o.s === s || (o.s && o.s.s === s.s));
      y = d ? r.top + d.y * r.height / (Z.h || r.height) : r.top + r.height / 2;
    } else if (PH.flow) { r = PH.flow.el.getBoundingClientRect(); y = r.top + PH.flow.lane(s.lane); return { top: y - 10, bottom: y + 10, height: 20, left: r.left + PH.flow.X(560), right: r.right }; }   // NOW, ladder, gate
    else return { top: 0, bottom: 0, height: 0 };
    return { top: y - 10, bottom: y + 10, height: 20 };
  };
}
function phOpenLane(s, from) { if (!s) return; phOpenStock(s.s, M.lanes.map(x => x.s), { el: null, lane: true, rect: phLaneRect(s, from) }); }

/* crest scrub: a horizontal drag moves a loupe over the dots; release opens the stock */
function phScrub(st, e) {
  const Z = PH.crest; if (!Z || !Z.P) return;
  const r = st.crest.getBoundingClientRect(), mx = (e.clientX - r.left) * Z.w / r.width, my = (e.clientY - r.top) * Z.h / r.height;
  let best = null, bd = 1e9;
  Z.P.dots.forEach(d => { const dd = Math.abs(d.x - mx) * 3 + Math.abs(d.y - my) * 0.35; if (dd < bd) { bd = dd; best = d.s; } });
  if (!best) return;
  st.scrub = best.s;
  obPulseMark({ kind: 'stock', sym: best.s });
  const lp = PH.loupe, stt = phStatus(best);
  lp.innerHTML = `<b>${best.s}</b><span class="pc ${best.side > 0 ? 'up' : 'dn'}">${pctStr(best.c)}</span><span class="st ${stt.c}">${stt.t}</span>`;
  lp.classList.add('on');
  const w = lp.offsetWidth, x = clamp(e.clientX - w / 2, 6, window.innerWidth - w - 6);
  css(lp, { left: x, top: Math.max(phNavBottom() + 4, r.top - 40) });
}
function phScrubEnd(st, open) {
  PH.loupe.classList.remove('on');
  if (open && st.scrub) phOpenStock(st.scrub, M.lanes.map(x => x.s), { lane: true, rect: M.bySym[st.scrub] ? phLaneRect(M.bySym[st.scrub], st.crest) : null });
  else phApplySel();
}

/* ---------------- the sheet (the phone's popup = the desktop inspector) ---------------- */
function phSheetBind(sheet) {
  let d = null;
  sheet.addEventListener('pointerdown', e => {
    if (PH.side || !e.target.closest('.shd') || e.target.closest('button,input,a')) return;
    d = { y: e.clientY, t: performance.now(), base: PH.shOff || 0, id: e.pointerId, pts: [[e.clientY, performance.now()]] };
    sheet.classList.add('drag'); try { sheet.setPointerCapture(e.pointerId); } catch (x) { }
  });
  sheet.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    const off = Math.max(0, d.base + e.clientY - d.y); PH.shOff = off;
    sheet.style.transform = `translateY(${off}px)`;
    d.pts.push([e.clientY, performance.now()]); if (d.pts.length > 6) d.pts.shift();
  });
  const up = e => {
    if (!d || e.pointerId !== d.id) return;
    const p = d.pts, a = p[0], b = p[p.length - 1], v = (b[0] - a[0]) / Math.max(1, b[1] - a[1]);   // px/ms, + = down
    const moved = Math.abs(e.clientY - d.y); d = null; sheet.classList.remove('drag');
    if (moved < 6) { if (PH.sh.detent === 'peek') phDetent('half'); else phDetent(PH.sh.detent); return; }
    const order = ['peek', 'half', 'full'], H = PH.shH, off = PH.shOff, vis = H - off;
    const vs = order.map(o => phDetentVis(o)), cur = order.indexOf(PH.sh.detent);
    let i = vs.reduce((bi, x, j) => Math.abs(x - vis) < Math.abs(vs[bi] - vis) ? j : bi, 0);   // nearest by position
    if (v > 0.5) i = Math.min(cur - 1, i); else if (v < -0.5) i = Math.max(cur + 1, i);        // a fling: at least one detent
    if (vis < vs[0] - 40) i = -1;
    if (i < 0) { phSheetClose(); return; }
    phDetent(order[Math.min(2, i)]);
  };
  sheet.addEventListener('pointerup', up); sheet.addEventListener('pointercancel', up);
  // (a scrim tap is "empty space" for the router; no click listener here: the click a tap synthesises would land on
  //  the scrim the same tap just raised and close the sheet again)
}
function phDetentVis(d) {
  const vh = window.innerHeight, H = PH.shH || vh;
  if (d === 'peek') { const hd = PH.sheet.querySelector('.shd'); return Math.min(H, (hd ? hd.offsetHeight : 120) + 8); }
  if (d === 'half') {
    const hd = PH.sheet.querySelector('.shd'), bd = PH.sheet.querySelector('.sbody'), last = bd && bd.lastElementChild;
    const need = hd && last ? hd.offsetHeight + last.offsetTop + last.offsetHeight + 22 : H;
    return Math.min(H, Math.round(vh * 0.62), Math.max(need, phDetentVis('peek') + 60));
  }
  return H;
}
function phDetent(d, anim) {
  const sh = PH.sheet; PH.sh.detent = d;
  const vh = window.innerHeight; PH.navH = PH.nav.offsetHeight || 44;
  if (PH.side) {
    sh.style.transform = ''; sh.style.height = ''; PH.shH = vh; PH.shOff = 0;
    PH.scrim.className = 'phscrim';
  } else {
    const H = PH.shH = vh - PH.navH; sh.style.height = H + 'px';
    const vis = phDetentVis(d), off = PH.shOff = Math.max(0, H - vis);
    if (anim === false) sh.classList.add('noanim');
    sh.style.transform = `translateY(${off}px)`;
    if (anim === false) { void sh.offsetWidth; sh.classList.remove('noanim'); }
    const b = sh.querySelector('.sbody'); if (b) b.style.paddingBottom = (off + 18) + 'px';   // the hidden part never hides the end of the list
    PH.scrim.className = 'phscrim on ' + d;
  }
  // the page gets room under its end for the sheet, so the last bays and the event can scroll up above it
  if (PH.page) PH.page.style.paddingBottom = PH.side || !PH.sh.open ? '' : Math.round(PH.shH - PH.shOff) + 'px';
  sh.setAttribute('aria-modal', d === 'full' && !PH.side ? 'true' : 'false');
}
function phSheetShow(detent) {
  const sh = PH.sheet;
  sh.removeAttribute('aria-hidden');
  if (!PH.sh.open) {
    // start from closed (below the frame, or off the right edge as a side panel) so the opening animates
    PH.navH = PH.nav.offsetHeight || 44; PH.shH = PH.side ? window.innerHeight : window.innerHeight - PH.navH;
    sh.classList.add('noanim');
    if (!PH.side) { sh.style.height = PH.shH + 'px'; sh.style.transform = `translateY(${PH.shH + 30}px)`; } else sh.style.transform = '';
    void sh.offsetWidth; sh.classList.remove('noanim');
  }
  PH.sh.open = true; sh.classList.add('on');
  phDetent(detent || 'half');
}
function phSheetClose() {
  const sh = PH.sheet; if (!sh) return;
  const was = PH.sh.open;
  PH.sh.open = false; PH.sh.kind = ''; sh.classList.remove('on'); sh.setAttribute('aria-hidden', 'true');
  if (!PH.side) sh.style.transform = `translateY(${(PH.shH || window.innerHeight) + 30}px)`;
  PH.scrim.className = 'phscrim';
  if (PH.page) PH.page.style.paddingBottom = '';
  PH.loupe.classList.remove('on');
  if (PH.sel) phSelect(null);
  if (was && document.activeElement && sh.contains(document.activeElement)) document.activeElement.blur();
}
function phSheetScrollTop() { const b = PH.sheet && PH.sheet.querySelector('.sbody'); return b ? b.scrollTop : 0; }
function phSheetW() { return Math.max(160, Math.min(728, (PH.sheet.clientWidth || window.innerWidth) - 32)); }

/* the side panel docks on the side away from its target (the desktop inspector's rule): the side it covers less of,
   else the half the target's centre is not in; an open panel that changes side slides in from the new edge */
function phDockFor(r) {
  if (!PH.side || !r || !PH.sheet || !(r.right > r.left)) return;   // no horizontal extent (a crest dot): the panel stays put
  const sh = PH.sheet, iw = window.innerWidth, pw = Math.min(400, iw);
  const oR = Math.max(0, Math.min(r.right, iw) - Math.max(r.left, iw - pw)), oL = Math.max(0, Math.min(r.right, pw) - Math.max(r.left, 0));
  const left = Math.abs(oR - oL) > 1 ? oR > oL : (r.left + r.right) / 2 > iw / 2;
  if (sh.classList.contains('dockl') === left) return;
  if (!PH.sh.open) { sh.classList.toggle('dockl', left); return; }
  sh.classList.add('noanim'); sh.style.transform = `translateX(${left ? -105 : 105}%)`; sh.classList.toggle('dockl', left);
  void sh.offsetWidth; sh.classList.remove('noanim'); sh.style.transform = '';
}
/* open a stock: brush it, fill the sheet, bring the tapped element above the sheet */
function phOpenStock(sym, list, o) {
  const s = M.bySym[sym]; if (!s) return;
  o = o || {};
  PH.sh.kind = 'stock'; PH.sh.sym = sym; PH.sh.list = list && list.length ? list : [sym]; PH.sh.i = PH.sh.list.indexOf(sym);
  const first = !PH.sh.open;
  phSelect({ kind: o.kind === 'anomaly' ? 'anomaly' : 'stock', sym });
  phSheetRender(false);
  if (PH.side && (o.el || o.rect)) phDockFor(o.el ? o.el.getBoundingClientRect() : o.rect());
  phSheetShow(first || PH.sh.detent === 'peek' ? 'half' : PH.sh.detent);
  if ((o.el || o.rect) && !PH.side) {
    const r = o.el ? o.el.getBoundingClientRect() : o.rect(), vis = phDetentVis(PH.sh.detent), bottom = window.innerHeight - vis - 8;
    if (r.top < phNavBottom() || r.bottom > bottom) {
      const tgt = r.height < bottom - phNavBottom() ? r.bottom - bottom : r.top - phNavBottom() - 8;
      window.scrollTo({ top: Math.max(0, window.scrollY + tgt), behavior: 'smooth' });
    }
  }
}
function phOpenSector(sec) {
  if (!M.stocks.some(s => s.sec === sec)) return;
  PH.sh.kind = 'sector'; PH.sh.sec = sec; PH.sh.list = null;
  phSelect({ kind: 'sector', sec });
  phSheetRender(false); phSheetShow('half');
}
function phOpenList(filter, side) {
  PH.sh.kind = 'list'; PH.sh.filter = filter || 'all'; PH.sh.fside = side || 0; PH.sh.q = '';
  if (PH.sel) phSelect(null);
  phSheetRender(false); phSheetShow('full');
}
function phStep(d) {
  const L = PH.sh.list; if (PH.sh.kind !== 'stock' || !L || L.length < 2) return;
  const i = PH.sh.i + d; if (i < 0 || i >= L.length) return;
  const sym = L[i]; PH.sh.i = i; PH.sh.sym = sym;
  const s = M.bySym[sym]; phSelect({ kind: s && s.event ? 'anomaly' : 'stock', sym }); phSheetRender(false);
}
function phJump(to) {
  const s = M.bySym[PH.sh.sym]; if (!s) return;
  let e = null, y = null;
  if (to === 'flow' && PH.flow) { e = PH.flow.el; y = PH.flow.lane(s.lane); }
  else if (to === 'tile') { const T = PH.tileBy[s.s]; e = T && T.el; }
  else if (to === 'setup') { const b = PH.bays.find(o => o.s.s === s.s) || (PH.eventBay && PH.eventBay.s.s === s.s ? PH.eventBay : null); e = b && (b.TK && b.TK.el || b.el); }
  if (!e) return;
  phDetent('peek');
  const top = phNavBottom(), bottom = window.innerHeight - (PH.side ? 0 : phDetentVis('peek')) - 8, mid = (top + bottom) / 2;
  const r = e.getBoundingClientRect();
  // the flow's stock sits on NOW, its ladder bar and the gate (the right end): the panel docks away from that
  if (PH.side) phDockFor(to === 'flow' ? { left: r.left + PH.flow.X(560), right: r.right } : r);
  const cy = y != null ? r.top + y : r.top + Math.min(r.height, bottom - top) / 2;
  window.scrollTo({ top: Math.max(0, window.scrollY + cy - mid), behavior: 'smooth' });
}

/* sheet contents; refresh = the same selection again after a minute update (detent and scroll kept, the old chart
   stays until the new one has drawn) */
function phSheetRender(refresh, keepTop) {
  const sh = PH.sheet, k = PH.sh.kind; if (!sh || !k) return;
  if (k === 'stock' && !M.bySym[PH.sh.sym]) { phSheetClose(); return; }
  if (k === 'sector' && !M.stocks.some(s => s.sec === PH.sh.sec)) { phSheetClose(); return; }
  // the body on show (a refresh still drawing sits hidden beside it); a newer render retires any older one in flight
  const shown = () => [...sh.querySelectorAll('.sbody')].find(x => x.style.visibility !== 'hidden');
  const tok = PH.sh.tok = (PH.sh.tok || 0) + 1;
  // the stock list keeps its search field (and the keyboard) through a minute update: only the rows redraw
  if (refresh && k === 'list' && PH.sh.redraw && sh.querySelector('.phsearch input')) { const ob = shown(), top = ob ? ob.scrollTop : 0; PH.sh.redraw(); if (ob) ob.scrollTop = top; return; }
  const hd = document.createElement('div'); hd.className = 'shd';
  const bd = document.createElement('div'); bd.className = 'sbody';
  if (k === 'stock') phSheetStock(hd, bd); else if (k === 'sector') phSheetSector(hd, bd); else phSheetList(hd, bd);
  const done = () => {
    if (tok !== PH.sh.tok) { if (bd.parentNode) { phZero(bd); bd.remove(); } return; }   // a newer render owns the sheet
    const ob = shown(), oh = sh.querySelector('.shd');
    const top = refresh ? (ob && ob !== bd ? ob.scrollTop : keepTop || 0) : 0;   // read now: the reader may have scrolled while the chart drew
    if (oh) oh.replaceWith(hd); else sh.insertBefore(hd, sh.firstChild);
    sh.querySelectorAll('.sbody').forEach(x => { if (x !== bd && x !== ob) { phZero(x); x.remove(); } });
    if (ob && ob !== bd) { phZero(ob); ob.replaceWith(bd); } else if (bd.parentNode !== sh) sh.appendChild(bd);
    bd.style.visibility = ''; bd.style.position = '';
    phFitQuote(hd); phFitStats(bd);
    if (PH.sh.open) phDetent(PH.sh.detent, false);
    bd.scrollTop = top;
    const nm = hd.querySelector('.l2 .nm'); if (nm && nm.scrollWidth > nm.clientWidth + 0.5) nm.remove();   // the sector stays whole
    const inp = hd.querySelector('input'); if (inp && !refresh && !('ontouchstart' in window)) inp.focus({ preventScroll: true });
  };
  if (k !== 'stock') { done(); return; }
  // stock: the body is laid out hidden inside the sheet so its chart can draw, then swapped in
  bd.style.visibility = 'hidden'; bd.style.position = 'absolute';
  sh.appendChild(bd);
  const s = M.bySym[PH.sh.sym], w = phSheetW();
  inspectorSpark(bd, s, w, S.dpr, 26, 'phspark');
  obInspectorChart(bd, s, w, 222, 1, S.dpr, true);   // 222: the phone sheet chart (185, the room the two-to-a-line stats freed, then +20%: owner request)
  obLockNote(bd);   // a locked preview: Access Locked on the chart, the Unlock line under it (terminal_locked.js)
  const g2 = bd.querySelector('.g2'); if (g2) bd.appendChild(g2);   // the chart right under the price, the stats below it (owner request)
  const box = bd.querySelector('.ichart');
  if (!refresh || !box || box.firstChild) { done(); return; }
  const t0 = performance.now(), wait = () => { if (tok !== PH.sh.tok || box.firstChild || performance.now() - t0 > 4000 || PH.sh.kind !== 'stock') done(); else setTimeout(wait, 60); };
  wait();
}
function phSheetCtl(hd, steps) {
  const L = PH.sh.list, i = PH.sh.i, n = L ? L.length : 0;
  const c = el('div', 'phctl', hd);
  if (steps && n > 1) {
    c.innerHTML = `<button class="phib" data-act="step" data-d="-1" aria-label="Previous"${i <= 0 ? ' disabled' : ''}><svg viewBox="0 0 20 20"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg></button>` +
      `<button class="phib" data-act="step" data-d="1" aria-label="Next"${i >= n - 1 ? ' disabled' : ''}><svg viewBox="0 0 20 20"><path d="M7.5 4.5L13 10l-5.5 5.5"/></svg></button>`;
  }
  c.insertAdjacentHTML('beforeend', '<button class="phib x" data-act="close" aria-label="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button>');
}
function phSheetStock(hd, bd) {
  const s = M.bySym[PH.sh.sym], sh = PH.sheet, stt = phStatus(s);
  phSideVars(sh, s.side, s.event);
  const tmp = document.createElement('div'); tmp.innerHTML = inspectorHTML(s);
  const px = tmp.querySelector('.row.px'), g2 = tmp.querySelector('.g2'), mgEl = tmp.querySelector('.h .mg');
  el('div', 'grab', hd);
  const h = el('div', 'h phh', hd);
  h.innerHTML = `${mgEl ? mgEl.outerHTML : ''}<div class="tt"><div class="l1"><span class="t">${s.s}</span></div>` +
    `<div class="l2"><span class="phst ${stt.c}">${stt.pk ? PH_TRI[s.side] : ''}${stt.t}</span><button class="n phsecb" data-act="sector" data-sec="${phEsc(s.sec)}" aria-label="Sector ${phEsc(s.sec)}">${phNameOnly(s) ? `<span class="nm">${phEsc(s.n)} ·</span>` : ''}<u>${phEsc(s.sec)}</u></button></div></div>`;
  phSheetCtl(hd, true);
  // one line under the name (owner request): the price and its move, the jump chips, the ‹ › position (phFitQuote)
  const q = el('div', 'phq', hd);
  if (px) { px.className = 'qv'; q.appendChild(px); }
  // jump chips: walk the stock's chain on the page (only the stations it has)
  const T = PH.tileBy[s.s], bay = PH.bays.find(o => o.s.s === s.s) || (PH.eventBay && PH.eventBay.s.s === s.s);
  const j = el('div', 'phjump', q);
  j.innerHTML = `<button data-act="jump" data-to="flow">Flow</button>` + (T && !bay ? `<button data-act="jump" data-to="tile">Tile</button>` : '') +
    (bay ? `<button data-act="jump" data-to="tile">Tile</button><button data-act="jump" data-to="setup">${s.event ? 'Event' : 'Setup'}</button>` : '');
  if (PH.sh.list && PH.sh.list.length > 1) el('span', 'pos', q, `${PH.sh.i + 1}<i>/</i>${PH.sh.list.length}`);
  if (g2) { if ((sh.clientWidth || window.innerWidth) < 430) g2.classList.add('ph2'); bd.appendChild(g2); }
}
/* the quote line fits one row: a line wider than the sheet stacks the move under the price (the row keeps a chip's
   height), then tightens the chips, and only on the narrowest sheets lets the chips take a second line */
function phFitQuote(hd) {
  const q = hd.querySelector('.phq'); if (!q) return;
  // the parts' own boxes, not scrollWidth: the chips' wider tap areas hang past the edge
  const over = () => { const R = q.getBoundingClientRect().right + 0.5; return [...q.children].some(e => e.getBoundingClientRect().right > R); };
  q.classList.remove('stk', 'tight', 'wrap');
  for (const c of ['stk', 'tight', 'wrap']) { if (!over()) break; q.classList.add(c); }
}
/* narrow sheet stats: one value per half, 11px down to 10px when a value is wider than its half; still too wide
   (a stock without a chart keeps the VWAP price beside its Δ): the cell takes the whole line */
function phFitStats(bd) {
  const g = bd.querySelector('.g2.ph2'); if (!g) return;
  g.querySelectorAll('.row:not(.note)>span:last-child').forEach(v => {
    v.style.fontSize = ''; let fs = 11, n = 8;
    while (v.scrollWidth > v.clientWidth + 0.5 && fs > 10 && n--) { fs -= 0.5; v.style.fontSize = fs + 'px'; }
    if (v.scrollWidth > v.clientWidth + 0.5) { v.style.fontSize = ''; v.parentElement.classList.add('full'); }
  });
}
function phSheetSector(hd, bd) {
  const sec = PH.sh.sec, x = (M.D.sectors || []).find(o => o.sec === sec) || { sec, chg: 0 }, mem = M.stocks.filter(s => s.sec === sec).sort((a, b) => b.c - a.c);
  const up = mem.filter(s => s.c > 0).length, dn = mem.length - up;
  phSideVars(PH.sheet, x.chg >= 0 ? 1 : -1);
  el('div', 'grab', hd);
  el('div', 'h phh sec', hd, `<div class="tt"><div class="l1"><span class="t">${phEsc(sec)}</span><span class="phpc ${x.chg >= 0 ? 'up' : 'dn'}">${pctStr(x.chg)}</span></div><div class="n"><span>${mem.length} STOCKS</span><span class="u">${PH_TRI[1]}${up}</span><span class="d">${PH_TRI[-1]}${dn}</span></div></div>`);
  phSheetCtl(hd, false);
  let strip = ''; mem.forEach(s => { strip += `<i class="${s.c > 0 ? 'u' : 'd'}"></i>`; });
  el('div', 'phad', hd, strip);
  PH.sh.list = mem.map(s => s.s);
  phRows(el('div', 'phlist', bd), mem);
}
const phNameOnly = s => s.n.replace(/[^a-z0-9]/gi, '').toUpperCase() === s.s.replace(/[^A-Z0-9]/g, '') ? '' : s.n;   // a name that only repeats the ticker is left out
function phRows(box, list) {
  let html = '';
  list.forEach(s => {
    const stt = phStatus(s), cls = s.c > 0 ? 'up' : s.c < 0 ? 'dn' : '';
    html += `<button class="phli" data-act="open" data-k="${phEsc(s.s)}"><span class="tk">${s.s}</span><span class="nm">${phEsc(phNameOnly(s))}</span><span class="pc ${s.event ? 'ev' : cls}">${pctStr(s.c)}</span><span class="st ${stt.c}">${stt.pk ? PH_TRI[s.side] : ''}${stt.t}</span></button>`;
  });
  box.innerHTML = html || '<div class="phnone">No stocks match</div>';
}
function phListItems() {
  const f = PH.sh.filter, sd = PH.sh.fside, q = PH.sh.q.trim().toUpperCase();
  let list;
  if (f === 'contenders') list = M.bulls.filter(s => s.sel).sort((a, b) => a.rank - b.rank).concat(M.bears.filter(s => s.sel).sort((a, b) => (a.event - b.event) || (a.rank - b.rank)));
  else if (f === 'setups') list = M.buyPicks.concat(M.sellPicks);
  else if (f === 'event') list = M.stocks.filter(s => s.event);
  else list = M.lanes.slice();
  if (sd) list = list.filter(s => s.side === sd);
  if (q) list = list.filter(s => s.s.includes(q) || s.n.toUpperCase().includes(q) || s.sec.toUpperCase().includes(q));
  return list;
}
function phSheetList(hd, bd) {
  ['--sc', '--hi', '--hot'].forEach(p => PH.sheet.style.removeProperty(p));
  el('div', 'grab', hd);
  const sr = el('div', 'phsearch', hd);
  sr.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.6"/><path d="M12.8 12.8L17 17"/></svg><input type="search" inputmode="search" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Search ${OB_LOCK ? '' : M.lanes.length + ' '}stocks" aria-label="Search stocks">`;
  phSheetCtl(hd, false);
  const nEv = M.stocks.filter(s => s.event).length, nC = M.selected.length, nP = M.buyPicks.length + M.sellPicks.length;
  const f = el('div', 'phfilt', hd), cur = PH.sh.filter;
  if (PH.sh.fside) { const b = el('button', 'phf side ' + (PH.sh.fside > 0 ? 'up' : 'dn'), f, `${PH_TRI[PH.sh.fside]}${PH.sh.fside > 0 ? 'BULLISH' : 'BEARISH'} ONLY <i>×</i>`); b.dataset.act = 'unside'; b.setAttribute('aria-label', 'Show both sides'); }
  [['all', 'ALL', M.lanes.length], ['contenders', 'CONTENDERS', nC], ['setups', 'SETUPS', nP], ['event', 'EVENT', nEv]].forEach(([k, t, n]) => {
    const b = el('button', 'phf' + (cur === k ? ' on' : ''), f, `${t} <b>${n}</b>`); b.dataset.act = 'filter'; b.dataset.f = k; if (!n) b.disabled = true;
  });
  const lb = el('div', 'phlist', bd);
  const draw = PH.sh.redraw = () => { const L = phListItems(); PH.sh.list = L.map(s => s.s); phRows(lb, L); };
  draw();
  const inp = sr.querySelector('input'); inp.value = PH.sh.q;
  let t = 0; inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { PH.sh.q = inp.value; draw(); bd.scrollTop = 0; }, 80); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const L = PH.sh.list; if (L && L.length) phOpenStock(L[0], L, { from: 'list' }); } });
}
function phOnKey(e) {
  if (!S.stacked || !PH.sh.open) return;
  if (e.key === 'Escape') { phSheetClose(); return; }
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') phStep(-1); else if (e.key === 'ArrowRight') phStep(1);
}

/* ================= phone motion: the build show and the ambient flow (SPEC §7) =================
   Injected by tools/patch_terminal.py right after tools/terminal_phone.js, in the same scope (the page's main script),
   so it shares PH, M, G, S and the desktop's FX helpers (glowSprite, polyPath, pathAt, threadPts, drawTileCanvas,
   shimmerStep / shimmerUpdate, obPulseDraw, easeInOutCubic / easeOutExpo / easeInv).
   Owner rules kept here: motion is always on (Reduce motion is never consulted); the tile order-book shimmer runs only
   while obState() === 'LIVE' (after the close the real order blocks hold still, decorative flow keeps running); the
   build is never disturbed by the pointer (a tap during an intro waits for it to end on its own, a crest scrub starts
   once the market has played; nothing ever speeds an intro up); a jump (rail chip, sheet Setup / Tile) to a section
   that has not played settles what is above it on that side and plays its own intro at once; nothing competes with
   reading: faint, under the nav and the sheet.

   - Build show: every section plays its intro the first time it comes into view (S.risen keeps the key, so a minute
     update, a resize or a theme change never replays it); ↻ in the FLOW header (or the R key) replays every intro.
     A section that has not played sits in its pre state (class phpre on the intro's element, set on every swap).
     Beats mirror the desktop show: crest burst + counts, rail chips pop, sectors light in order; beacon pop, plume
     clip reveal with the scan head, thermometer opens, walls fade in, the crash column's double flash, NOW flash,
     ladder grows, herd impacts and contender flashes at the gate, 210 / 40 pop; slit lights and the fibre front sweeps
     to the rim; tiers build c4 → c3 → c2 tile by tile (book rows growing); each setup bay: reticle locks on, bridge,
     card entrance, ring fills, % counts up, a packet punches the pill.
   - Ambient, in the phone's one rAF loop (phFrame): DOM motion is transform / opacity only (spine comet, node flares,
     packets, sweep band, reticle bounce); canvas FX (flow particles and flashes, lens fibre particles, tile growth,
     crest burst, shimmer) are drawn at ≤30 fps and only for what is on screen; frame average > 24 ms halves the
     particles; the loop stops while the tab is hidden and sleeps while nothing on screen moves (woken by scroll,
     visibility, selection and intro events, and by a timer for the next comet / sweep); CSS loops pause in
     off-screen sections and spine nodes (class phoff). */
const PX = {
  on: false, runs: new Set(), sprites: null, theme: '', io: null,
  paths: [], parts: [], flowOn: true, lens: {}, lensOn: { 1: true, '-1': true }, flashes: [], zc: null, rev: null,
  last: 0, lastCv: 0, fa: 16, cut: 0, visAt: 0, shimAt: 0, selKey: null, selSet: null,
  comet: { el: null, run: null, next: 0 }, sweep: { el: null, run: null, next: 0 },
  tq: [], tnext: { 1: 0, '-1': 0 }, bq: [], bnext: { 1: 0, '-1': 0 }, tapGo: 0, qw: 0, scrubPend: null,
  awake: false, wakeAt: 0, wt: 0
};
/* the loop sleeps (phFxFrame returns false) while nothing moves; anything that may need frames wakes it */
function phFxWake() {
  if (!PX.on) return;
  PX.wakeAt = performance.now();
  if (PX.awake) { phLoopKick(); return; }
  PX.awake = true; PX.last = 0; phFrame(phFxFrame);
}
const PX_O3 = x => 1 - Math.pow(1 - x, 3);
const phTierKey = t => `tier:${phSd(t.side)}:${t.key}`;

/* ---------------- every swap: sprites, particle paths, layers, pre states, intro triggers ---------------- */
function phFxSwap() {
  const now = performance.now();
  if (!PX.on) {
    PX.on = true; PX.comet.next = now + 2600; PX.sweep.next = now + 6500;
    phFxWake();
    window.addEventListener('keydown', e => {       // R replays the build (the desktop's key)
      if (!S.stacked || e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'r' && e.key !== 'R')) return;
      const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      phReplay();
    });
    window.addEventListener('scroll', phFxWake, { passive: true });
    window.addEventListener('resize', phFxWake, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) phFxWake(); });
    const up = () => { PX.scrubPend = null; };                      // a finger lifted before the market played: no scrub
    document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', up, true);
    phFxHooks();
  }
  phFxSplitReactor();
  if (!PX.sprites || PX.theme !== PH.theme) {         // glow sprites carry the theme's colours (the light layer remaps them as drawn)
    PX.sprites = { 1: glowSprite(SC[1], 5), '-1': glowSprite(SC[-1], 5), w: glowSprite('232,241,255', 6), a: glowSprite('255,176,32', 5) };
    PX.theme = PH.theme;
  }
  PX.flashes = []; PX.zc = null; PX.rev = null; PX.tq = []; PX.tnext = { 1: 0, '-1': 0 }; PX.bq = []; PX.bnext = { 1: 0, '-1': 0 }; PX.selKey = null;
  PX.comet.run = null; PX.sweep.run = null; PX.visAt = now + 300;
  phFxPaths(); phFxLayers(); phFxPrepAll(); phFxObserve();
  if (PH.flow) PH.drawOverlay(now);
  phFxWake();
}
PH.onSwap.push(phFxSwap);
/* the reactor's two dashed rings turn on the compositor: each ring gets its own <svg> (a CSS box), which rotates */
function phFxSplitReactor() {
  if (!PH.body) return;
  PH.body.querySelectorAll('.reactor svg:not(.phr1):not(.phr2)').forEach(s => {
    const g1 = s.querySelector('g.r1'), g2 = s.querySelector('g.r2'); if (!g1 || !g2) return;
    const s2 = s.cloneNode(false); s2.appendChild(g2); s.after(s2);
    s.classList.add('phr1'); s2.classList.add('phr2');
  });
}
/* hooks into the page layer's pointer paths (same script scope): the crest scrub waits for the market's intro, and a
   jump to a section that has not played plays it at once */
function phFxHooks() {
  if (typeof phScrub === 'function') {
    const scrub0 = phScrub;
    phScrub = function (st, e) {
      if (phMarketBusy()) { PX.scrubPend = { st, x: e.clientX, y: e.clientY, go: scrub0 }; return; }   // the finger is kept
      PX.scrubPend = null; return scrub0(st, e);
    };
  }
  const pulse0 = typeof phPulseBay === 'function' ? phPulseBay : null;
  if (pulse0) {                                         // rail chip: the bay plays now; its accent pulses once it has
    phPulseBay = function (bay) { const run = phFxJumpTo(bay); if (run) phRunAfter(run, () => pulse0(bay)); else pulse0(bay); };
  }
  if (typeof phJump === 'function') {                   // sheet Setup / Tile
    const jump0 = phJump;
    phJump = function (to) {
      try {
        const s = M.bySym[PH.sh.sym];
        if (s && (to === 'tile' || to === 'setup')) {
          let e = null;
          if (to === 'tile') { const T = PH.tileBy[s.s]; e = T && T.el; }
          else { const b = PH.bays.find(o => o.s.s === s.s) || (PH.eventBay && PH.eventBay.s.s === s.s ? PH.eventBay : null); e = b && b.el; }
          const run = phFxJumpTo(e);
          if (run && to === 'setup' && pulse0) phRunAfter(run, () => pulse0(e));
        }
      } catch (x) { console.warn(x); }
      return jump0(to);
    };
  }
}
function phMarketBusy() { return [...PX.runs].some(r => r.key === 'market') || (PH.secs.some(s => s.key === 'market') && !PH.risen.has('market')); }
function phRunAfter(run, fn) { const f0 = run.fin; run.fin = () => { if (f0) f0(); try { fn(); } catch (x) { console.warn(x); } }; }

/* particle paths: the contenders' threads (breakout → NOW) and bars in the flow (≤40 particles), one per fibre in
   each lens band (≤20) */
function phFxPaths() {
  PX.paths = []; PX.parts = []; PX.lens = {};
  const F = PH.flow, r = mulberry32(7);
  if (F) {
    const g0 = G; G = F.Gp;
    try {
      const add = (s, kind, n) => {
        let p;
        if (kind === 'thread') p = polyPath(threadPts(s, Math.min(100, Math.floor((s.ubPlume || s.ub || 0) * 125) + 1)));
        else { const y = G.laneY(s.lane); p = polyPath([[592, y], [690, y]]); }
        if (p.L > 8) PX.paths.push({ kind, s, side: s.side > 0 ? 1 : -1, p, v: kind === 'thread' ? 44 : 80, n });
      };
      const picks = M.selected.filter(s => s.pick && !s.event), rest = M.selected.filter(s => !s.pick && !s.event).sort((a, b) => a.rank - b.rank);
      picks.forEach(s => { add(s, 'thread', 2); add(s, 'bar', 1); });
      let room = 40 - PX.paths.reduce((a, p) => a + p.n, 0);
      rest.forEach(s => { if (room-- > 0) add(s, 'thread', 1); });
    } finally { G = g0; }
    PX.paths.forEach((pa, i) => { for (let k = 0; k < pa.n; k++) PX.parts.push({ pi: i, d: r() * pa.p.L, a: 0.55 + 0.45 * r() }); });
    if (PX.parts.length > 40) PX.parts.length = 40;
  }
  [1, -1].forEach(side => {
    const L = PH.lens[side]; if (!L) return;
    const paths = [], h = L.rimY - L.slitY;
    L.list.forEach(s => {
      const x0 = L.notch[s.s], x1 = L.land[s.s]; if (x0 == null || x1 == null) return;
      paths.push({ s, p: polyPath(bezPts([[x0, L.slitY + 2], [x0, L.slitY + h * 0.5], [x1, L.rimY - h * 0.45], [x1, L.rimY]], 20)) });
    });
    PX.lens[side] = { L, paths, parts: paths.slice(0, 20).map((pa, i) => ({ pi: i, d: r() * pa.p.L, a: 0.55 + 0.45 * r() })), fl: [] };
  });
}
/* the motion layer's own elements: the spine comet, the sweep band (persistent, fixed), lens overlays, the scan head */
function phFxLayers() {
  PX.comet.el = el('div', 'phcomet', PH.body, '<i></i><b></b>');
  if (!PX.sweep.el || !PX.sweep.el.isConnected) PX.sweep.el = el('div', 'phsweep', PH.root);
  PX.sweep.el.style.opacity = '0';
  [1, -1].forEach(side => { const L = PH.lens[side]; if (L) L.fx = localCanvas(L.el, L.w, L.h, S.dpr, 'phlensfx'); });
  const F = PH.flow;
  if (F) { F.scan = el('div', 'phscan', F.el); css(F.scan, { left: F.X(66), top: F.Y(F.Gp.T0 - 8), height: (F.Gp.T1 - F.Gp.T0 + 16) * F.fx }); }
}

/* ---------------- pre states (sections that have not played yet) ---------------- */
function phSpNode(key) { return PH.spine ? PH.spine.nodes.find(n => n.key === key) : null; }
function phWait(key) { const n = phSpNode(key); if (!n) return; n.el.classList.add('phwait'); if (n.cnt) { n.cnt.classList.remove('cntpop'); n.cnt.classList.add('phwait'); } }
function phPopNode(key) { const n = phSpNode(key); if (!n) return; phPop(n.el); if (n.cnt) { n.cnt.classList.remove('phwait'); n.cnt.classList.add('cntpop'); } }
function phPop(n) {
  if (!n) return; n.classList.remove('phwait'); n.classList.add('in');
  const d = n.classList.contains('dia') ? ' rotate(45deg)' : '', b = `translate(-50%,-50%)${d}`;
  if (n.animate) n.animate([{ opacity: 0, transform: b + ' scale(.2)' }, { opacity: 1, transform: b + ' scale(1.7)', offset: 0.5 }, { opacity: 1, transform: b + ' scale(1)' }], { duration: 480, easing: 'ease-out' });
}
function phFlare(n) {
  if (!n || !n.animate) return;
  const d = n.classList.contains('dia') ? ' rotate(45deg)' : '', b = `translate(-50%,-50%)${d}`;
  n.animate([{ transform: b + ' scale(1)' }, { transform: b + ' scale(1.7)', offset: 0.45 }, { transform: b + ' scale(1)' }], { duration: 300, easing: 'ease-out' });
}
function phClipX(F, c, x) { if (c) c.style.clipPath = `inset(0 ${(clamp(c._w - (x - c._x), 0, c._w) * F.fx).toFixed(1)}px 0 0)`; }
function phClipZ(F, x) { const c = F.cv.spine; if (c) c.style.clipPath = `inset(0 ${Math.max(0, F.W - F.X(x)).toFixed(1)}px 0 0)`; }
function phClipAxis(F, f) {
  const a = F.cv.axis; if (!a) return;
  const up = (F.Gp.yT - a._y) * F.fx, dn = (a._y + a._h - F.Gp.yT) * F.fx;
  a.style.clipPath = `inset(${(up * (1 - f)).toFixed(1)}px 0 ${(dn * (1 - f)).toFixed(1)}px 0)`;
}
function phPrepBay(b) {
  if (!b) return;
  b.el.classList.add('phpre');
  const T = b.tile; if (T) { T.built = false; T._st = null; if (T.ctx) T.ctx.clearRect(0, 0, T.w, T.h); }
  const d = b.TK && b.TK.el; if (!d) return;
  d.querySelectorAll('circle.fg').forEach(c => { c.style.strokeDashoffset = c.dataset.c; });
  d.querySelectorAll('.pc[data-v]').forEach(p => { p.textContent = pctStr(0); });
}
function phPrepTier(t) {
  t.el.classList.add('phpre');
  t.tiles.forEach(T => { T.built = false; T._st = null; if (T.ctx) T.ctx.clearRect(0, 0, T.w, T.h); });
}
const PX_PREP = {
  market(sec) {
    sec.el.classList.add('phpre');
    if (PH.crest && PULSE === PH.crest) obPulseDraw(0);           // every dot back at zero, the counts at 0
    phWait('market');
  },
  flow() {
    const F = PH.flow; if (!F) return;
    F.el.classList.add('phpre'); PX.flowOn = false;
    phClipX(F, F.cv.plume, 66); phClipX(F, F.cv.walls, 66); F.cv.walls.style.opacity = '0';
    phClipZ(F, 66); phClipX(F, F.cv.ladder, 584); phClipAxis(F, 0);
    if (F.scan) { F.scan.style.opacity = '0'; F.scan.style.transform = ''; }
    phWait('flow'); phWait('gate');
  },
  branch(sec) {
    const L = sec.lens; if (!L) return;
    L.el.classList.add('phpre'); L.cv.style.clipPath = 'inset(0 0 100% 0)'; PX.lensOn[sec.side] = false;
    phWait('lens:' + phSd(sec.side));
  },
  bay(sec) { phPrepBay(sec.bay); if (sec.pick === 1) phWait(phSd(sec.side) + ':setups'); },
  event(sec) { phPrepBay(sec.bay); phWait('event'); }
};
function phFxPrepAll() {
  const body = PH.body; if (!body) return;
  PX.flowOn = true; PX.lensOn = { 1: true, '-1': true };
  if (!window.IntersectionObserver) { PH.secs.forEach(s => PH.risen.add(s.key)); PH.tiers.forEach(t => PH.risen.add(phTierKey(t))); return; }
  body.classList.add('phnoanim');                                   // the pre states land at once (no transition)
  PH.secs.forEach(sec => { if (PH.risen.has(sec.key)) return; try { const f = PX_PREP[sec.kind]; if (f) f(sec); } catch (e) { console.warn(e); } });
  PH.tiers.forEach(t => { if (!PH.risen.has(phTierKey(t))) phPrepTier(t); });
  void body.offsetWidth; body.classList.remove('phnoanim');
}
/* a finished intro: its element back to the page's own styles (no pre state, no entrance classes) */
function phSettle(root) {
  if (!root) return;
  root.classList.remove('phpre', 'go');
  root.querySelectorAll('.in').forEach(e => e.classList.remove('in'));
  root.querySelectorAll('.cntpop').forEach(e => e.classList.remove('cntpop'));
}

/* ---------------- triggers: the first time an intro's element is well in view ---------------- */
function phIntroTarget(sec) {
  if (sec.kind === 'flow') return PH.flow && PH.flow.el;
  if (sec.kind === 'branch') return sec.lens && sec.lens.el;
  if (sec.kind === 'event') return sec.bay && sec.bay.el;
  return sec.el;
}
function phFxObserve() {
  if (!window.IntersectionObserver || !PH.body) return;
  // on-screen flags for what animates on canvas (flow overlay, lens bands, tiles for the shimmer)
  const vo = new IntersectionObserver(ents => ents.forEach(en => { en.target._fxv = en.isIntersecting; phFxWake(); }), { rootMargin: '40px 0px' });
  if (PH.flow) vo.observe(PH.flow.el);
  [1, -1].forEach(s => { if (PH.lens[s]) vo.observe(PH.lens[s].el); });
  PH.tiles.forEach(T => { if (T.el) vo.observe(T.el); });
  PH.obs.push(vo);
  phIntroWatch();
}
function phIntroWatch() {
  if (PX.io) { PX.io.disconnect(); PX.io = null; }
  if (!window.IntersectionObserver || !PH.body) return;
  const tgs = [];
  PH.secs.forEach(sec => { if (PH.risen.has(sec.key)) return; const tg = phIntroTarget(sec); if (tg) { tg._ix = { sec, key: sec.key }; tgs.push(tg); } });
  PH.tiers.forEach(t => { const key = phTierKey(t); if (!PH.risen.has(key)) { t.el._ix = { tier: t, key }; tgs.push(t.el); } });
  if (!tgs.length) return;
  const th = []; for (let i = 0; i <= 20; i++) th.push(i / 20);
  const io = PX.io = new IntersectionObserver(ents => ents.forEach(en => {
    const tg = en.target, rb = en.rootBounds, rh = rb ? rb.height : window.innerHeight, rt = rb ? rb.top : 0;
    // due: most of a short element, or a fifth of the screen of a tall one, is in view; or the reader is already past
    // its start (a restored place, scrolling back up)
    tg._due = en.isIntersecting && (en.intersectionRect.height >= Math.min(en.boundingClientRect.height * 0.85, rh * 0.2) || en.boundingClientRect.top < rt + PH.navH + 8);
    if (tg._due && !tg._dt) tg._dt = setTimeout(() => { tg._dt = 0; if (tg._due) phIntroGo(tg); }, 90);   // not for a fly-past
  }), { threshold: th });
  tgs.forEach(t => io.observe(t));
  PH.obs.push(io);
}
function phIntroGo(tg) {
  const ix = tg._ix; if (!ix || !PH.body || !PH.body.contains(tg) || PH.risen.has(ix.key)) return;
  tg._ix = null; if (PX.io) PX.io.unobserve(tg);
  PH.risen.add(ix.key);
  if (ix.tier) { PX.tq.push(ix.tier); phFxWake(); return; }
  const sec = ix.sec; sec.risen = true;
  if (sec.kind === 'bay' || sec.kind === 'event') { PX.bq.push(sec); phFxWake(); return; }   // after the tiers above them
  const f = PH.intro[sec.kind];
  try { if (f) f(sec); } catch (e) { console.warn(e); phUnPre(sec); }
}
/* an intro that could not run: the section is shown final */
function phUnPre(sec) {
  if (sec.kind === 'flow') { phSettleFlow(); return; }
  if (sec.kind === 'branch' && sec.lens) { sec.lens.cv.style.clipPath = ''; phSettle(sec.lens.el); PX.lensOn[sec.side] = true; return; }
  if (sec.bay) { if (sec.bay.tile) phGrowDone([sec.bay.tile]); phSettle(sec.bay.el); return; }
  phSettle(sec.el);
}
/* a jump to a tier or a setup bay that has not played: everything above it on that side settles at once (final state,
   off the queue) and its own intro starts now, so the jump never lands on a section still waiting its turn. Returns
   the target's run (null when it has already played) */
function phFxJumpTo(elm) {
  if (!elm || !PH.body || !PH.body.contains(elm)) return null;
  let tg = null;
  const t0 = PH.tiers.find(t => t.el.contains(elm));
  if (t0) tg = { key: phTierKey(t0), side: t0.side > 0 ? 1 : -1, el: t0.el, tier: t0 };
  else {
    const sec = PH.secs.find(s => (s.kind === 'bay' || s.kind === 'event') && s.bay && s.bay.el.contains(elm));
    if (sec) tg = { key: sec.key, side: (sec.side || -1) > 0 ? 1 : -1, el: sec.bay.el, sec };
  }
  if (!tg) return null;
  const runOf = key => [...PX.runs].find(r => r.key === key);
  const queued = tg.tier ? PX.tq.includes(tg.tier) : PX.bq.includes(tg.sec);
  const own = runOf(tg.key); if (own) return own;
  if (PH.risen.has(tg.key) && !queued) return null;
  const above = n => !!(n.compareDocumentPosition(tg.el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const drop = n => { n._ix = null; clearTimeout(n._dt); n._dt = 0; if (PX.io) PX.io.unobserve(n); };
  const unwait = key => { const n = phSpNode(key); if (!n) return; n.el.classList.remove('phwait'); if (n.cnt) n.cnt.classList.remove('phwait'); };
  const settle = (key, n, fin) => {
    const r = runOf(key); if (r) { phRunEnd(r); return; }
    PH.risen.add(key); drop(n); fin();
  };
  PH.secs.forEach(sec => {
    const side = (sec.side || -1) > 0 ? 1 : -1;
    if (side !== tg.side || !(sec.kind === 'branch' || sec.kind === 'bay' || sec.kind === 'event') || sec.key === tg.key) return;
    const n = phIntroTarget(sec); if (!n || !above(n)) return;
    const q = PX.bq.indexOf(sec); if (q >= 0) PX.bq.splice(q, 1);
    if (PH.risen.has(sec.key) && q < 0 && !runOf(sec.key)) return;
    sec.risen = true;
    settle(sec.key, n, () => {
      phUnPre(sec);
      unwait(sec.kind === 'branch' ? 'lens:' + phSd(side) : sec.kind === 'event' ? 'event' : sec.pick === 1 ? phSd(side) + ':setups' : '');
    });
  });
  PH.tiers.forEach(t => {
    if ((t.side > 0 ? 1 : -1) !== tg.side || t === tg.tier || !above(t.el)) return;
    const key = phTierKey(t), q = PX.tq.indexOf(t); if (q >= 0) PX.tq.splice(q, 1);
    if (PH.risen.has(key) && q < 0 && !runOf(key)) return;
    settle(key, t.el, () => { phGrowDone(t.tiles); phSettle(t.el); });
  });
  // the target itself: off the queue, its intro now
  const now = performance.now();
  PH.risen.add(tg.key);
  if (tg.tier) { const q = PX.tq.indexOf(tg.tier); if (q >= 0) PX.tq.splice(q, 1); drop(tg.el); phTierIntro(tg.tier, now); }
  else {
    const sec = tg.sec, q = PX.bq.indexOf(sec); if (q >= 0) PX.bq.splice(q, 1);
    drop(phIntroTarget(sec)); sec.risen = true; PX.bnext[tg.side] = now + 90;
    try { PH.intro[sec.kind](sec); } catch (e) { console.warn(e); phUnPre(sec); }
  }
  phFxWake();
  return runOf(tg.key) || null;
}

/* ---------------- the intro runner: timed beats + tweens (always at their own pace) ---------------- */
function phRun(key, dur, build, fin) {
  const run = { key, dur, t0: performance.now(), base: 0, rate: 1, t: 0, ev: [], tw: [], fired: 0, frame: null, fin };
  build((t, fn) => run.ev.push({ t, fn }), (t0, d, fn, ease, cv) => run.tw.push({ t0, d, fn, ease: ease || (x => x), cv: !!cv, done: false }), run);
  run.ev.sort((a, b) => a.t - b.t);
  PX.runs.add(run); phFxWake();
  phRunStep(run, run.t0, true);                                    // the first beat lands at once
  return run;
}
function phRunStep(run, now, cv) {
  const t = run.t = run.base + (now - run.t0) * run.rate;
  while (run.fired < run.ev.length && run.ev[run.fired].t <= t) { const e = run.ev[run.fired++]; try { e.fn(e.t); } catch (x) { console.warn(x); } }
  run.tw.forEach(w => {
    if (w.done || t < w.t0) return;
    const f = clamp((t - w.t0) / w.d, 0, 1); if (f < 1 && w.cv && !cv) return;   // canvas tweens: ≤30 fps
    try { w.fn(w.ease(f)); } catch (x) { console.warn(x); } if (f >= 1) w.done = true;
  });
  if (run.frame) { try { run.frame(t, cv); } catch (x) { console.warn(x); } }
  if (t >= run.dur) phRunEnd(run);
}
function phRunEnd(run) {
  if (!PX.runs.has(run)) return;
  PX.runs.delete(run);
  while (run.fired < run.ev.length) { const e = run.ev[run.fired++]; try { e.fn(e.t); } catch (x) { console.warn(x); } }
  run.tw.forEach(w => { if (!w.done) { try { w.fn(w.ease(1)); } catch (x) { } w.done = true; } });
  if (run.fin) { try { run.fin(); } catch (x) { console.warn(x); } }
}
PH.introBusy = () => { const b = PX.runs.size > 0 || PX.tq.length > 0 || PX.bq.length > 0; if (b) phFxWake(); return b; };
/* a tap during an intro waits (PH.holdUntil) for the intros playing now to end on their own: nothing is sped up. It
   waits once: when it comes back it goes, even if the cascade has started the next intro. Only queued intros (about
   to start): it looks again shortly, for ≤ ~0.9 s */
PH.hurry = () => {
  const now = performance.now();
  if (now < PX.tapGo) return;                                        // this tap has had its wait
  let end = 0;
  PX.runs.forEach(run => { end = Math.max(end, run.t0 + (run.dur - run.base) / run.rate); });
  if (end > now) { PX.qw = 0; PH.holdUntil = Math.max(PH.holdUntil, end + 40); PX.tapGo = PH.holdUntil + 300; return; }
  if (!PX.tq.length && !PX.bq.length) return;
  if (!PX.qw || now - PX.qw > 2500) PX.qw = now;
  if (now - PX.qw < 900) PH.holdUntil = Math.max(PH.holdUntil, now + 120); else { PX.qw = 0; PX.tapGo = now + 300; }
};

/* tile book rows grow like the desktop column build (6 ms a row + a 220 ms ease), drawn at ≤30 fps */
function phGrow(Ts, t) {
  Ts.forEach(T => {
    if (T.built || T._st == null || !T.ctx) return;
    const ms = t - T._st;
    if (ms > 6 * (T.rd ? T.rd.rows : 20) + 400) { T.built = true; drawTileCanvas(T, 1e9); } else drawTileCanvas(T, Math.max(0, ms));
  });
}
function phGrowDone(Ts) { Ts.forEach(T => { if (T.built) return; T.built = true; T._st = null; if (T.ctx) drawTileCanvas(T, 1e9); }); }

/* ---------------- the intros ---------------- */
PH.intro.market = sec => {
  const root = sec.el, Z = PH.crest, chips = [...root.querySelectorAll('.phpick')], sch = [...root.querySelectorAll('.schips .chip')];
  const react = root.querySelector('.phreact'), badge = root.querySelector('.phrailhd .phcnt');
  phRun('market', Math.max(1500, 560 + sch.length * 28 + 380), (at, tw) => {
    at(0, () => phPopNode('market'));
    if (Z) tw(0, 1250, f => { if (PULSE === Z) obPulseDraw(f); }, easeInOutCubic, true);   // dots burst out of zero, counts count up, callouts fade in
    at(180, () => { if (react) react.classList.add('in'); if (badge) badge.classList.add('cntpop'); });
    chips.forEach((c, i) => at(280 + i * 55, () => c.classList.add('in')));
    sch.forEach((c, i) => at(560 + i * 28, () => c.classList.add('in')));
  }, () => {
    if (Z && PULSE === Z) obPulseDraw(1); phSettle(root);
    const p = PX.scrubPend; PX.scrubPend = null;                    // a finger that came during the show scrubs now
    if (p && PH.finger && p.st.crest && p.st.crest.isConnected) { try { p.go(p.st, { clientX: p.x, clientY: p.y }); } catch (e) { console.warn(e); } }
  });
};
PH.intro.flow = sec => {
  const F = PH.flow; if (!F) return;
  const Gp = F.Gp, cv = F.cv, box = F.el, X = F.X, Y = F.Y, T0 = 150, TD = 1600, xOf = f => 66 + 524 * f;
  const fl = (x, y, r, rgb, dur, a, dl) => PX.flashes.push({ x, y, r, rgb, t0: performance.now() + (dl || 0), dur, a });
  const rect = (rc, rgb, dur, a) => PX.flashes.push({ rect: rc, rgb, t0: performance.now(), dur, a });
  const ax = cv.axis, yz = Y(Gp.yT), up = (Gp.yT - ax._y) * F.fx, dn = (ax._y + ax._h - Gp.yT) * F.fx;
  const pb = M.lanes[M.lanes.length - 1], xs = 66 + 126 / NT * 524;
  phRun('flow', 2950, (at, tw) => {
    at(0, () => { phPop(F.node.beacon); fl(66, Gp.yT, 40, '232,241,255', 600, 1); });
    // the replay: plume, walls and the zero split open left → right behind the scan head (09:15 → NOW)
    tw(T0, TD, f => { const x = xOf(f); phClipX(F, cv.plume, x); phClipX(F, cv.walls, x); phClipZ(F, x); if (F.scan) F.scan.style.transform = `translate3d(${(X(x) - X(66)).toFixed(1)}px,0,0)`; }, easeInOutCubic);
    tw(T0, 160, f => { if (F.scan) F.scan.style.opacity = f.toFixed(3); });
    tw(T0 + TD - 120, 260, f => { if (F.scan) F.scan.style.opacity = (1 - f).toFixed(3); });
    tw(T0, TD, f => phClipAxis(F, f), easeOutExpo);                  // the thermometer opens outward from zero
    tw(T0, 700, f => { cv.walls.style.opacity = f.toFixed(3); });
    box.querySelectorAll('.phaxis .lb').forEach(l => {
      const ly = parseFloat(l.style.top) + 6, d = clamp(ly < yz ? (yz - ly) / Math.max(1, up) : (ly - yz) / Math.max(1, dn), 0, 0.999);
      at(T0 + TD * easeInv(easeOutExpo, d), () => l.classList.add('in'));
    });
    at(T0 + 700, () => { const s = box.querySelector('.phaxis svg'); if (s) s.classList.add('in'); });
    // hour labels appear as the scan head passes them
    const x0 = X(66), x1 = X(590);
    box.querySelectorAll('.phhours i').forEach(tk => {
      const x = parseFloat(tk.style.left), lb = tk.previousElementSibling;
      at(T0 + TD * easeInv(easeInOutCubic, clamp((x - x0) / (x1 - x0), 0, 0.999)), () => { tk.classList.add('in'); if (lb) lb.classList.add('in'); });
    });
    if (pb && pb.event) {                                           // the event's crash column: amber double flash
      const t = T0 + TD * easeInv(easeInOutCubic, (xs - 66) / 524), rc = [xs - 2, Gp.Q(-1.1), 4, Gp.T1 + 8 - Gp.Q(-1.1)];
      at(t, () => rect(rc, '255,176,32', 180, 0.9)); at(t + 260, () => rect(rc, '255,176,32', 180, 0.9));
      at(t + 300, () => { const c = box.querySelector('.phcrash'); if (c) c.classList.add('in'); });
    }
    at(1650, () => {                                                // NOW
      F.nowline.classList.add('in'); F.nowglow.classList.add('in'); phPop(F.node.now);
      rect([586, Gp.T0 - 8, 9, Gp.T1 - Gp.T0 + 8], '232,241,255', 420, PH.theme === 'light' ? 0.26 : 0.5);   // light: the additive white lands as indigo, so softer
      F.cnt.all.classList.add('cntpop'); phPopNode('flow');
    });
    tw(1750, 600, f => { phClipX(F, cv.ladder, 584 + 118 * f); phClipZ(F, 590 + 100 * f); }, PX_O3);   // the ladder grows
    at(2070, () => {                                                // herd ghost impacts settle into the gate strip
      const r = mulberry32(11);
      M.lanes.forEach((s, k) => { if (s.sel || r() > 0.35) return; fl(686, Gp.laneY(k), 6, s.side > 0 ? '30,158,110' : '194,58,82', 220, 0.55, r() * 260); });
    });
    at(2300, () => {                                                // the contenders flash at their windows: the gate
      M.selected.forEach((s, i) => fl(690, Gp.laneY(s.lane), 8, s.event ? '255,176,32' : SC[s.side], 160, 1, i * 4));
      phPop(F.node.gate); F.cnt.gate.classList.add('cntpop'); phPopNode('gate');
      box.querySelectorAll('.gwin, .phwin').forEach(w => w.classList.add('in'));
    });
  }, phSettleFlow);
};
function phSettleFlow() {
  const F = PH.flow; if (!F) return;
  [F.cv.plume, F.cv.walls, F.cv.ladder, F.cv.axis, F.cv.spine].forEach(c => { if (c) { c.style.clipPath = ''; c.style.opacity = ''; } });
  if (F.scan) F.scan.style.opacity = '0';
  phSettle(F.el); PX.flowOn = true;
}
PH.intro.branch = sec => {
  const L = sec.lens, side = sec.side; if (!L) return;
  const P = PX.lens[side], slitB = L.h - (L.slitY + 7);
  phRun(sec.key, 820, (at, tw) => {
    at(0, () => {                                                   // the slit lights
      L.cv.style.clipPath = `inset(0 0 ${slitB.toFixed(1)}px 0)`; phPopNode('lens:' + phSd(side));
      if (P) P.fl.push({ slit: true, t0: performance.now(), dur: 460, a: 1 });
    });
    tw(90, 520, f => { L.cv.style.clipPath = `inset(0 0 ${(slitB * (1 - f)).toFixed(1)}px 0)`; }, PX_O3);   // the fibre front sweeps to the rim
    at(560, () => {                                                 // and lands
      if (P) P.paths.forEach((pa, i) => { const e = pa.p.pts[pa.p.pts.length - 1]; P.fl.push({ x: e[0], y: e[1], r: pa.s.pick ? 9 : 6, rgb: pa.s.event ? '255,176,32' : SC[side], t0: performance.now() + i * 8, dur: 280, a: 0.8 }); });
    });
  }, () => { L.cv.style.clipPath = ''; phSettle(L.el); PX.lensOn[side] = true; });
};
/* each branch builds in funnel order, like the desktop show: the fibre front reaches the rim, then the tiers
   c4 → c3 → c2, then the setup bays (#1 → #3, 90 ms apart) and the event; whatever is on screen together cascades */
function phLensBusy(side) {
  const L = PH.lens[side], lk = 'branch:' + phSd(side);
  return [...PX.runs].some(r => r.key === lk) || !!(L && L.el._due && !PH.risen.has(lk));
}
function phPump(now) {
  for (let i = 0; i < PX.tq.length; i++) {
    const t = PX.tq[i];
    if (phLensBusy(t.side) || now < PX.tnext[t.side]) continue;      // the fibres still sweep / the tier above still builds
    PX.tq.splice(i--, 1);
    phTierIntro(t, now);
  }
  const held = new Set();                                            // one side's bays start in page order
  for (let i = 0; i < PX.bq.length; i++) {
    const sec = PX.bq[i], side = sec.side || -1;
    if (held.has(side)) continue;
    const tiersDue = PX.tq.some(t => t.side === side) || PH.tiers.some(t => t.side === side && t.el._due && !PH.risen.has(phTierKey(t)));
    if (phLensBusy(side) || tiersDue || now < PX.tnext[side] || now < PX.bnext[side]) { held.add(side); continue; }
    PX.bq.splice(i--, 1); held.add(side);
    PX.bnext[side] = now + 90;
    try { PH.intro[sec.kind](sec); } catch (e) { console.warn(e); phUnPre(sec); }
  }
}
function phTierIntro(t, now) {
  const Ts = t.tiles, n = Ts.length, rows = Math.max(20, ...Ts.map(T => T.rd ? T.rd.rows : 20));
  PX.tnext[t.side] = now + 60 + (n - 1) * 25 + 170;
  phRun(phTierKey(t), 60 + (n - 1) * 25 + 6 * rows + 520, (at, tw, run) => {
    at(0, () => t.el.classList.add('go'));                           // the tier's header and echo brackets
    Ts.forEach((T, i) => at(60 + i * 25, ts => { T.el.classList.add('in'); T._st = ts; }));   // rank order, 25 ms apart
    run.frame = (tt, cv) => { if (cv) phGrow(Ts, tt); };
  }, () => { phGrowDone(Ts); phSettle(t.el); });
}
PH.intro.bay = sec => {
  const b = sec.bay; if (!b) return;
  const T = b.tile, card = b.TK && b.TK.el, pcs = card ? [...card.querySelectorAll('.pc[data-v]')] : [];
  phRun(sec.key, 1560, (at, tw, run) => {
    if (b.pick === 1) at(0, () => phPopNode(phSd(b.side) + ':setups'));
    at(0, ts => { if (T) { T.el.classList.add('in'); T._st = ts; } });
    run.frame = (t, cv) => { if (cv && T) phGrow([T], t); };
    at(260, () => { if (b.ret) b.ret.classList.add('in'); phLock(T); });          // the reticle locks on
    at(380, () => { if (b.bridge) b.bridge.classList.add('in'); });                // the bridge
    at(470, () => {                                                                // the card, its ring, a packet punches the pill
      if (!card) return;
      card.classList.add('in');
      card.querySelectorAll('circle.fg').forEach(c => { const C = +c.dataset.c, v = +c.dataset.v; c.style.strokeDashoffset = (C * (1 - v / 100)).toFixed(2); });
      phPacket(b, 60, () => { const p = card.querySelector('.pill'); if (p && p.animate) p.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)', offset: 0.5 }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' }); });
    });
    tw(570, 500, f => pcs.forEach(p => { p.textContent = pctStr(+p.dataset.v * f); }), PX_O3);   // % counts up
  }, () => { if (T) phGrowDone([T]); phSettle(b.el); });
};
PH.intro.event = sec => {
  const b = sec.bay; if (!b) return;
  const T = b.tile, an = b.el.querySelector('.anom');
  phRun('event', 1250, (at, tw, run) => {
    at(0, ts => { phPopNode('event'); if (T) { T.el.classList.add('in'); T._st = ts; } });
    run.frame = (t, cv) => { if (cv && T) phGrow([T], t); };
    at(220, () => { if (b.bridge) b.bridge.classList.add('in'); });
    at(320, () => { if (an) an.classList.add('in'); });
    at(560, () => { if (an) { an.classList.remove('flick'); void an.offsetWidth; an.classList.add('flick'); } });   // blinks twice
  }, () => { if (T) phGrowDone([T]); phSettle(b.el); });
};
function phLock(T) {
  if (!T || !T.el) return;
  const f = el('i', 'phlock', T.el);
  if (!f.animate) { f.remove(); return; }
  f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 340, easing: 'ease-out' }).onfinish = () => f.remove();
}
/* a packet runs down a bay's bridge into its card; the card's accent pulses when it lands */
function phPacket(b, delay, onLand) {
  const br = b.bridge, card = b.TK && b.TK.el; if (!br || !br.isConnected || !br.animate) return;
  const r = br.getBoundingClientRect(); if (r.bottom < -40 || r.top > window.innerHeight + 40) return;
  const hz = br.classList.contains('h'), len = hz ? r.width : r.height, pk = el('i', 'phpk', br);
  const a = pk.animate([{ transform: 'translate3d(0,0,0)', opacity: 0 }, { opacity: 1, offset: 0.25 }, { transform: hz ? `translate3d(${len}px,0,0)` : `translate3d(0,${len}px,0)`, opacity: 1 }],
    { duration: 220, delay: delay || 0, easing: 'ease-in', fill: 'backwards' });
  a.onfinish = () => {
    pk.remove();
    const acc = card && card.querySelector('.acc'); if (acc && acc.animate) acc.animate([{ opacity: 0.5 }, { opacity: 1, offset: 0.5 }, { opacity: 0.75 }], { duration: 900, easing: 'ease-in-out' });
    if (onLand) onLand();
  };
}

/* ---------------- replay: every section plays its intro again (those in view now, the rest on the way down) ---------------- */
function phReplay(btn) {
  if (!PH.body || !S.stacked) return;
  if (btn && btn.animate) { const s = btn.querySelector('svg'); if (s) s.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-360deg)' }], { duration: 700, easing: 'cubic-bezier(.3,.7,.2,1)' }); }
  [...PX.runs].forEach(phRunEnd);
  if (PH.sh.open) phSheetClose(); else if (PH.sel) phSelect(null);
  PH.risen.clear(); PH.secs.forEach(s => { s.risen = false; });
  PX.tq = []; PX.tnext = { 1: 0, '-1': 0 }; PX.bq = []; PX.bnext = { 1: 0, '-1': 0 }; PX.flashes = []; PX.zc = null; PX.comet.run = null;
  if (PX.comet.el) PX.comet.el.style.opacity = '0';
  phFxPrepAll(); phIntroWatch();
  if (PH.flow) PH.drawOverlay(performance.now());
}

/* ---------------- the frame: intros, then the ambient flow of what is on screen ---------------- */
function phFxFrame(now) {
  let need = true;
  try {
    if (!PH.body || !S.stacked) { PX.awake = false; return false; }
    const dt = Math.min(64, now - (PX.last || now)); PX.last = now;
    PX.fa = PX.fa * 0.95 + dt * 0.05;
    const cv = now - PX.lastCv >= 30, cdt = cv ? Math.min(100, now - (PX.lastCv || now)) : 0;
    if (cv) PX.lastCv = now;
    PX.runs.forEach(run => phRunStep(run, now, cv));
    if (PX.tq.length || PX.bq.length) phPump(now);
    if (now > PX.visAt) { PX.visAt = now + 250; phFxVisSync(); }
    phComet(now); phSweep(now);
    // what still moves: intros (running or queued), the comet / sweep, a scroll's tail (visibility settles), the flow
    // and lens layers in view with particles, flashes, a brush or a reverse pulse, the LIVE shimmer on tiles in view
    const F = PH.flow, fv = !!(F && F.el._fxv);
    const flowNeed = fv && ((PX.flowOn && PX.parts.length > 0) || PX.flashes.length > 0 || !!PX.zc || !!PX.rev || !!PH.sel);
    const lensNeed = {};
    [1, -1].forEach(side => { const P = PX.lens[side]; lensNeed[side] = !!(P && P.L.el._fxv && ((PX.lensOn[side] && P.parts.length > 0) || P.fl.length > 0 || (PX.rev && PX.rev.side === side))); });
    const live = obState() === 'LIVE';
    need = PX.runs.size > 0 || PX.tq.length > 0 || PX.bq.length > 0 || !!PX.comet.run || !!PX.sweep.run || now - PX.wakeAt < 400 ||
      flowNeed || lensNeed[1] || lensNeed[-1] || (live && PX.shimOn);
    if (cv) {
      phGuard(now);
      if (fv && (flowNeed || PX.flowDirty)) {                          // one more draw after the last moving frame clears it
        if (PX.flowOn) PX.parts.forEach(pt => { const pa = PX.paths[pt.pi]; if (!pa) return; pt.d += pa.v * cdt / 1000; if (pt.d >= pa.p.L) pt.d -= pa.p.L; });
        PH.drawOverlay(now); PX.flowDirty = flowNeed;
      }
      [1, -1].forEach(side => { const P = PX.lens[side]; if (P && P.L.el._fxv && (lensNeed[side] || P.dirty)) { phLensStep(P, side, cdt, now); P.dirty = lensNeed[side]; } });
      PX.shimOn = live && phShimmer(now);                                // the real order blocks hold still after the close
      if (PX.shimOn) need = true;
    }
  } catch (e) { console.warn(e); }
  const F = PH.flow;
  if (need || (F && F.el._fxv && PX.flowDirty) || [1, -1].some(side => { const P = PX.lens[side]; return P && P.dirty && P.L.el._fxv; })) return true;
  // asleep until something moves again: scroll, visibility, selection, an intro, or the next comet / sweep
  PX.awake = false; PX.last = 0;
  clearTimeout(PX.wt);
  PX.wt = setTimeout(phFxWake, Math.max(50, Math.min(PX.comet.next, PX.sweep.next) - now + 5));
  return false;
}
/* CSS loops (NOW glow, motes, reactor, sheen, chart ripples, the market beacon's ring) pause in sections and spine
   nodes that are off screen */
function phFxVisSync() {
  PH.secs.forEach(sec => { const off = !sec.vis; if (sec._off !== off) { sec._off = off; sec.el.classList.toggle('phoff', off); } });
  const sp = PH.spine; if (!sp || !PH.body) return;
  const top = PH.body.getBoundingClientRect().top, vh = window.innerHeight;
  sp.nodes.forEach(n => { const y = top + n.y, off = y < -60 || y > vh + 60; if (n._off !== off) { n._off = off; n.el.classList.toggle('phoff', off); } });
}
function phGuard(now) {
  if (PX.fa <= 24 || now - PX.cut < 2500) return;                  // a slow phone: half the particles
  PX.cut = now;
  if (PX.parts.length > 8) PX.parts.length = Math.ceil(PX.parts.length / 2);
  [1, -1].forEach(s => { const P = PX.lens[s]; if (P && P.parts.length > 5) P.parts.length = Math.ceil(P.parts.length / 2); });
}
function phHot() {
  const h = PH.sel; if (!h) return null;
  if (PX.selKey !== h) { PX.selKey = h; PX.selSet = h.kind === 'sector' ? new Set(M.stocks.filter(s => s.sec === h.sec).map(s => s.s)) : new Set([h.sym]); }
  return PX.selSet;
}
/* the flow overlay, under the brush chain: particles along the contenders' threads and bars, the comet's run along
   the zero split, flashes, the reverse pulse of a newly selected stock (design coords of the phone layout) */
PH.overUnder = (ctx, now, F) => {
  const sp = PX.sprites; if (!sp) return;
  const k = S.dpr, fx = F.fx;
  ctx.setTransform(k * fx, 0, 0, k * fx, k * (F.AX - 66 * fx), k * (F.padT - F.yO * fx));
  ctx.globalCompositeOperation = 'lighter';                          // set before any style: the light layer maps additive light
  const hot = phHot();
  if (PX.flowOn) PX.parts.forEach(pt => {
    const pa = PX.paths[pt.pi]; if (!pa) return;
    const q = pathAt(pa.p, pt.d), sz = pa.kind === 'bar' ? 11 : 13, fade = Math.min(1, pt.d / 14, (pa.p.L - pt.d) / 14);
    ctx.globalAlpha = Math.max(0, pt.a * fade * (pa.kind === 'thread' ? 0.62 : 0.85) * (hot && !hot.has(pa.s.s) ? 0.28 : 1));
    ctx.drawImage(sp[pa.side], q[0] - sz / 2, q[1] - sz / 2, sz, sz);
  });
  if (PX.zc) {
    const q = (now - PX.zc.t0) / 1100;
    if (q > 1) PX.zc = null;
    else {
      const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2, hx = 66 + 624 * e, y = F.Gp.yT;
      if (!PX.zc.n && hx >= 590) { PX.zc.n = 1; phFlare(F.node.now); }
      if (!PX.zc.g && hx >= 688) { PX.zc.g = 1; phFlare(F.node.gate); }
      for (let i = 0; i < 18; i++) { const x = hx - i * 5; if (x < 66) break; ctx.globalAlpha = (1 - i / 18) * 0.9 * (hot ? 0.45 : 1); const s = 17 - i * 0.55; ctx.drawImage(sp.w, x - s / 2, y - s / 2, s, s); }
    }
  }
  PX.flashes = PX.flashes.filter(f => {
    const q = (now - f.t0) / f.dur; if (q > 1) return false; if (q < 0) return true;
    ctx.globalAlpha = f.a * (1 - q);
    if (f.rect) { ctx.fillStyle = `rgba(${f.rgb},1)`; ctx.fillRect(f.rect[0], f.rect[1], f.rect[2], f.rect[3]); return true; }
    const r = f.r * (0.6 + 0.8 * q), g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, `rgba(${f.rgb},.8)`); g.addColorStop(1, `rgba(${f.rgb},0)`);
    ctx.fillStyle = g; ctx.fillRect(f.x - r, f.y - r, 2 * r, 2 * r); return true;
  });
  const rv = PX.rev;
  if (rv) {
    const q = (now - rv.t0) / 500;
    if (q > 1) { if (q > 2) PX.rev = null; }
    else { const p = pathAt(rv.p, rv.p.L * q); ctx.globalAlpha = 1; ctx.drawImage(sp.w, p[0] - 12, p[1] - 12, 24, 24); ctx.drawImage(sp[rv.side], p[0] - 14, p[1] - 14, 28, 28); }
  }
  ctx.globalAlpha = 1;
};
/* a newly selected stock: a bright pulse runs its chain backwards (the desktop's reverse pulse): NOW → 09:15 in the
   flow, and its fibre from the rim back up to the slit */
PH.onSelect.push(h => {
  PX.rev = null; const F = PH.flow; phFxWake();
  if (!h || h.kind !== 'stock' || !F) return;
  const s = M.bySym[h.sym]; if (!s) return;
  const g0 = G; G = F.Gp;
  try {
    const y = G.laneY(s.lane), pts = threadPts(s, 0).concat([[590, y], [s.sel ? 690 : 592 + ladderLen(M, s), y]]);
    PX.rev = { sym: s.s, side: s.side > 0 ? 1 : -1, t0: performance.now(), p: polyPath(pts.slice().reverse()) };
  } finally { G = g0; }
  phFxWake();
});
/* a lens band's own layer: one particle per fibre (slit → rim, a small landing flash), the slit's flashes */
function phLensStep(P, side, dt, now) {
  const L = P.L, o = L.fx, sp = PX.sprites; if (!o || !sp || !o.cv.isConnected) return;
  const ctx = o.ctx, k = S.dpr, hot = phHot(), rgb = SC[side];
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, o.cv.width, o.cv.height); ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  if (PX.lensOn[side]) P.parts.forEach(pt => {
    const pa = P.paths[pt.pi]; if (!pa) return;
    pt.d += 44 * dt / 1000;
    if (pt.d >= pa.p.L) {
      pt.d -= pa.p.L;
      if (!hot || hot.has(pa.s.s)) { const e = pa.p.pts[pa.p.pts.length - 1]; P.fl.push({ x: e[0], y: e[1], r: 5, rgb: pa.s.event ? '255,176,32' : rgb, t0: now, dur: 240, a: 0.45 }); }
    }
    const q = pathAt(pa.p, pt.d), fade = Math.min(1, pt.d / 8, (pa.p.L - pt.d) / 8), sz = pa.s.pick ? 8.5 : 7;
    ctx.globalAlpha = Math.max(0, pt.a * fade * 0.85 * (hot && !hot.has(pa.s.s) ? 0.25 : 1));
    ctx.drawImage(pa.s.event ? sp.a : sp[side], q[0] - sz / 2, q[1] - sz / 2, sz, sz);
  });
  P.fl = P.fl.filter(f => {
    const q = (now - f.t0) / f.dur; if (q > 1) return false; if (q < 0) return true;
    ctx.globalAlpha = f.a * (1 - q);
    if (f.slit) {
      const g = ctx.createLinearGradient(L.sx0 - 8, 0, L.sx1 + 8, 0);
      g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(0.5, 'rgba(255,255,255,.9)'); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.fillRect(L.sx0 - 8, L.slitY - 3, L.sx1 - L.sx0 + 16, 6); return true;
    }
    const r = f.r * (0.6 + 0.8 * q), g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, `rgba(${f.rgb},.8)`); g.addColorStop(1, `rgba(${f.rgb},0)`);
    ctx.fillStyle = g; ctx.fillRect(f.x - r, f.y - r, 2 * r, 2 * r); return true;
  });
  const rv = PX.rev;
  if (rv && rv.side === side) {
    const q = (now - rv.t0) / 420, pa = q <= 1 && P.paths.find(x => x.s.s === rv.sym);
    if (pa) { const p = pathAt(pa.p, pa.p.L * (1 - q)); ctx.globalAlpha = 1; ctx.drawImage(sp.w, p[0] - 7, p[1] - 7, 14, 14); ctx.drawImage(sp[side], p[0] - 9, p[1] - 9, 18, 18); }
  }
  ctx.globalAlpha = 1;
}
/* the order-book shimmer (the desktop's, on the phone's own tiles): only while LIVE, only the tiles in view */
function phShimmer(now) {
  if (!G) return false;
  const list = PH.tiles.filter(T => T.built && T.rd && T.mul && !T.s.event && T.el && T.el._fxv);
  if (!list.length) return false;
  const g0 = G.tiles; G.tiles = list;
  try { if (now - PX.shimAt > 100) { PX.shimAt = now; shimmerStep(now); } shimmerUpdate(now); } finally { G.tiles = g0; }
  return true;
}
/* a comet runs down the visible stretch of the spine every ~7 s; each node flares as it passes (the flow node sends a
   light along the zero split to the gate, a lens node lights its slit, a setups node sends packets into its cards) */
function phComet(now) {
  const C = PX.comet, sp = PH.spine; if (!C.el || !sp) return;
  if (!C.run) {
    if (now < C.next) return;
    C.next = now + 7000;
    if (PX.runs.size) { C.next = now + 1500; return; }              // never during an intro
    const br = PH.body.getBoundingClientRect(), top = phNavBottom() - br.top, bot = window.innerHeight - br.top;
    const y0 = Math.max(sp.top, top + 10), y1 = Math.min(sp.bottom, bot - 16);
    if (y1 - y0 < 140) return;
    C.run = { t0: now, y0, y1, dur: clamp((y1 - y0) * 2.4, 1300, 2600), hit: new Set() };
  }
  const R = C.run, f = clamp((now - R.t0) / R.dur, 0, 1), e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2, y = R.y0 + (R.y1 - R.y0) * e;
  C.el.style.transform = `translate3d(0,${y.toFixed(1)}px,0)`;
  C.el.style.opacity = Math.min(1, f * 10, (1 - f) * 10).toFixed(3);
  sp.nodes.forEach(n => {
    if (R.hit.has(n.key) || n.y < R.y0 - 2 || y < n.y) return;
    R.hit.add(n.key); phFlare(n.el); phCometAt(n.key, now);
  });
  if (f >= 1) { C.run = null; C.el.style.opacity = '0'; }
}
function phCometAt(key, now) {
  const F = PH.flow;
  if (key === 'flow' && F && PX.flowOn && F.el._fxv) PX.zc = { t0: now };
  if (key.startsWith('lens:')) { const side = key.endsWith('bull') ? 1 : -1, P = PX.lens[side]; if (P && PX.lensOn[side]) P.fl.push({ slit: true, t0: now, dur: 420, a: 0.8 }); }
  if (key.endsWith(':setups')) { const side = key.startsWith('bull') ? 1 : -1; PH.bays.filter(b => b.side === side && !b.el.classList.contains('phpre')).forEach((b, i) => phPacket(b, i * 90)); }
}
/* a faint band sweeps down the screen every ~12 s; each setup's reticle bounces as it passes and a packet goes into
   its card (never while the sheet is open, never during an intro) */
function phSweep(now) {
  const W = PX.sweep; if (!W.el) return;
  if (!W.run) {
    if (now < W.next) return;
    W.next = now + 12000;
    if (PX.runs.size || PH.sh.open) { W.next = now + 3000; return; }
    W.run = { t0: now, top: phNavBottom(), bot: window.innerHeight, dur: 2400, hit: new Set() };
  }
  const R = W.run, f = clamp((now - R.t0) / R.dur, 0, 1), e = -(Math.cos(Math.PI * f) - 1) / 2, y = R.top + (R.bot - R.top) * e;
  W.el.style.transform = `translate3d(0,${y.toFixed(1)}px,0)`;
  W.el.style.opacity = (PH.sh.open ? 0 : Math.min(1, f * 6, (1 - f) * 6)).toFixed(3);
  PH.bays.forEach(b => {
    if (!b.ret || R.hit.has(b.s.s) || b.el.classList.contains('phpre')) return;
    const r = b.ret.getBoundingClientRect(); if (r.bottom < R.top || r.top > R.bot) return;
    if (y < r.top + r.height / 2) return;
    R.hit.add(b.s.s);
    if (b.ret.animate) b.ret.animate([{ transform: 'scale(1)' }, { transform: 'scale(.88)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 380, easing: 'ease-out' });
    phPacket(b, 0);
  });
  if (f >= 1) { W.run = null; W.el.style.opacity = '0'; }
}
