/* ================= locked preview removed (unlocked, crystal clear) ================= */
const OB_LOCK = false;
function oblPerDay() { return ''; }
function obLockNote() {}
const OB_FIND_BAND = 38;                   // the row above the stage that holds the field (computeScale keeps it clear)
const FIND = { root: null, inp: null, box: null, open: false, q: '', items: [], at: -1, pv: null, prev: null, wait: 0, pt: 0 };
const OB_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

function obFindMount() {
  if (FIND.root || OB_PEEK) return;
  const host = document.getElementById("obFindHost") || document.body;
  const r = FIND.root = el('div', '', host); r.id = 'obFind';
  r.innerHTML = '<div class="obf-f"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.6"/><path d="M12.8 12.8L17 17"/></svg>' +
    '<input type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="obFindList" aria-label="Search stocks" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
    `<kbd aria-hidden="true">${OB_MAC ? '⌘K' : 'Ctrl K'}</kbd></div><div class="obf-l" id="obFindList" role="listbox" aria-label="Stocks" hidden></div>`;
  const inp = FIND.inp = r.querySelector('input'), box = FIND.box = r.querySelector('.obf-l');
  // a click into the field selects its text, so typing replaces the last search (the click's own mouseup would undo it)
  let fresh = false;
  inp.addEventListener('pointerdown', () => { fresh = document.activeElement !== inp; });
  inp.addEventListener('mouseup', e => { if (fresh) { fresh = false; e.preventDefault(); } });
  inp.addEventListener('focus', () => { obFindShow(); inp.select(); });
  inp.addEventListener('input', () => { FIND.q = inp.value; obFindRender(); box.scrollTop = 0; });
  inp.addEventListener('keydown', e => {
    e.stopPropagation();                   // the page's own keys stay out of the field (R replays the build, Esc unpins)
    const k = e.key, n = FIND.items.length;
    if ((e.metaKey || e.ctrlKey) && /^[kf]$/i.test(k)) { e.preventDefault(); inp.select(); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'PageDown' || k === 'PageUp') {
      e.preventDefault(); if (!FIND.open) obFindShow(); if (!n) return;
      const d = k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : k === 'PageDown' ? 8 : -8;
      obFindMove(FIND.at < 0 ? (d > 0 ? 0 : n - 1) : clamp(FIND.at + d, 0, n - 1), true);
    } else if (k === 'Enter') { e.preventDefault(); if (FIND.at >= 0) obFindPick(FIND.at); }
    else if (k === 'Escape') { e.preventDefault(); obFindClose(); inp.blur(); }
    else if (k === 'Tab') obFindClose();
  });
  // the list: the mouse chooses (and lights) a row, a click or tap opens it; pressing a row keeps the keyboard in the field
  box.addEventListener('pointerdown', e => { if (e.target.closest('.obf-r')) e.preventDefault(); });
  box.addEventListener('pointermove', e => { const row = e.pointerType === 'mouse' && e.target.closest('.obf-r'); if (row && +row.dataset.i !== FIND.at) obFindMove(+row.dataset.i, false); });
  box.addEventListener('click', e => { const row = e.target.closest('.obf-r'); if (row) obFindPick(+row.dataset.i); });
  // it closes like every floating layer: a press outside it, a resize, the frame losing focus. A tablet's on-screen
  // keyboard only changes the height: the list stays open (the re-render keeps it)
  let lw = window.innerWidth;
  document.addEventListener('pointerdown', e => { if (FIND.open && !r.contains(e.target)) obFindClose(); }, true);
  window.addEventListener('resize', () => { if (window.innerWidth !== lw) { lw = window.innerWidth; obFindClose(); } });
  window.addEventListener('blur', () => { if (FIND.open) { obFindClose(); inp.blur(); } });
}
// where it sits: above the stage's top-left corner, its left edge on the market picture's
function obFindPlace() {
  const r = FIND.root; if (!r) return;
  if (S.stacked) { obFindClose(); return; }
  const host = document.getElementById("obFindHost");
  if (!host) {
    const top = Math.round(S.top - OB_FIND_BAND + 4);
    css(r, { left: Math.round(S.left + 24 * S.s), top });
  }
  FIND.box.style.maxHeight = Math.max(160, Math.min(388, window.innerHeight - 52)) + 'px';
  FIND.inp.placeholder = OB_LOCK ? 'Search stocks' : `Search ${M.lanes.length} stocks`;   // the locked preview shows no figures
  if (!r.classList.contains('in')) { void r.offsetWidth; r.classList.add('in'); }
}
/* the matches, best first: the ticker itself, a ticker starting with it, a word of the company name starting with
   it, a ticker containing it, the sector, then a name containing it; each group strongest first (the page's lane
   order, as the phone's list). Matches inside a word need 3 letters ("SB" is SBIN, not AXISBANK), a sector 2 ("IT") */
function obFindItems(q) {
  q = q.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!q) return M.lanes.slice();
  const key = q.replace(/[^A-Z0-9]/g, ''), mid = key.length >= 3, out = [];
  M.lanes.forEach((s, i) => {
    const tk = s.s.toUpperCase().replace(/[^A-Z0-9]/g, ''), nm = ' ' + s.n.toUpperCase(), sec = ' ' + (s.sec || '').toUpperCase();
    const r = key && tk === key ? 0 : key && tk.startsWith(key) ? 1 : nm.includes(' ' + q) ? 2 : mid && tk.includes(key) ? 3
      : q.length >= 2 && sec.includes(' ' + q) ? 4 : mid && nm.includes(q) ? 5 : -1;
    if (r >= 0) out.push([r, i, s]);
  });
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.map(o => o[2]);
}
function obFindRows() {
  if (!FIND.items.length) return '<div class="obf-none">No stocks match</div>';
  let h = '';
  FIND.items.forEach((s, i) => {
    const st = phStatus(s), nm = phNameOnly(s), on = i === FIND.at;
    h += `<div class="obf-r ${s.event ? 'ev' : s.side > 0 ? 'up' : 'dn'}${on ? ' on' : ''}" id="obf${i}" role="option" aria-selected="${on}" data-i="${i}">` +
      `<span class="tk">${phEsc(s.s)}</span><span class="nm">${nm ? phEsc(nm) + ' · ' : ''}<em>${phEsc(s.sec || '')}</em></span>` +
      `<span class="pc ${s.event ? 'ev' : s.c > 0 ? 'up' : s.c < 0 ? 'dn' : ''}">${pctStr(s.c)}</span>` +
      `<span class="st ${st.c}">${st.pk ? PH_TRI[s.side] : ''}${st.t}</span></div>`;
  });
  return h;
}
// the rows for the field's text: typing marks the best match (Enter opens it) and lights it once typing pauses; an
// empty field marks nothing and puts back what was lit before
function obFindRender() {
  FIND.items = obFindItems(FIND.q);
  FIND.at = FIND.q.trim() && FIND.items.length ? 0 : -1;
  FIND.box.innerHTML = obFindRows();
  obFindAria();
  clearTimeout(FIND.pt);
  if (FIND.at < 0) obFindUnpreview(); else FIND.pt = setTimeout(() => obFindPreview(FIND.at), 260);
}
function obFindAria() { const r = FIND.at >= 0 && FIND.box.children[FIND.at]; if (r) FIND.inp.setAttribute('aria-activedescendant', r.id); else FIND.inp.removeAttribute('aria-activedescendant'); }
function obFindMove(i, scroll) {
  const rows = FIND.box.children, was = FIND.at >= 0 && rows[FIND.at];
  if (was) { was.classList.remove('on'); was.setAttribute('aria-selected', 'false'); }
  FIND.at = i;
  const r = rows[i]; if (!r || !r.classList.contains('obf-r')) return;
  r.classList.add('on'); r.setAttribute('aria-selected', 'true'); obFindAria();
  if (scroll) r.scrollIntoView({ block: 'nearest' });
  obFindPreview(i);
}
function obFindShow() {
  if (FIND.open || S.stacked || !M) return;
  FIND.open = true; FIND.root.classList.add('open'); FIND.inp.setAttribute('aria-expanded', 'true');
  FIND.q = FIND.inp.value; obFindRender(); FIND.box.hidden = false; FIND.box.scrollTop = 0;
}
function obFindClose() {
  if (!FIND.open) return;
  FIND.open = false; FIND.root.classList.remove('open'); FIND.box.hidden = true;
  FIND.inp.setAttribute('aria-expanded', 'false'); FIND.inp.removeAttribute('aria-activedescendant');
  obFindUnpreview();
}
// opened by a key or by the page around the frame; the phone layout opens its own stock list with the field ready
function obFindOpen() {
  if (OB_PEEK || !M) return;
  if (S.stacked) {
    if (typeof phOpenList !== 'function' || !PH.root) return;
    phOpenList('all', 0);
    const i = document.querySelector('#sheet .phsearch input'); if (i) i.focus({ preventScroll: true });
    return;
  }
  if (FIND.inp) FIND.inp.focus();
}
/* the lit stock while choosing: lit as a hover lights it (no popup), held as a pin so the page's own hover can't
   take it; what was pinned before comes back when the list closes without a pick, its popup where it stood */
function obFindPreview(i) {
  clearTimeout(FIND.pt);
  const s = FIND.open && i >= 0 ? FIND.items[i] : null;
  if (!s || FX.show || !G) { obFindUnpreview(); return; }   // the build show plays untouched
  if (FIND.pv && FIND.pv.sym === s.s) return;
  if (!FIND.pv) FIND.prev = obFindCopy(FX.pinned);
  const h = FIND.pv = { kind: 'stock', sym: s.s, find: 2 };
  FX.pinned = h; applyBrush(h);
}
function obFindUnpreview() {
  clearTimeout(FIND.pt);
  if (!FIND.pv) return;
  const p = FIND.prev; FIND.pv = null; FIND.prev = null;
  if (FX.show) return;                     // a replay of the build cleared the page itself
  obFindApply(p);
}
// a pin put (back) on the page: a stock gets its popup where it stood, else where a click on it would open it. A
// stock or sector the new minute no longer has is let go
function obFindApply(h, opts) {
  const s = h && h.kind === 'stock' ? M.bySym[h.sym] : null;
  if (h && (h.kind === 'stock' ? !s : h.kind === 'sector' && !M.stocks.some(x => x.sec === h.sec))) h = null;
  FX.pinned = h || null; applyBrush(h || null, s ? obFindAt(s, h.at) : undefined, opts);
}
/* the point a click on the stock would come from: where its popup stood (beside its setup card, or the same point of
   the flow, now on the stock's lane, or of the market picture), else its tile's centre, else its lane at NOW */
function obFindAt(s, at) {
  const st = $('#stage'), r = st.getBoundingClientRect(), k = r.width / 1920, T = G.tileBy[s.s], K = G.ticketBy[s.s];
  const pt = (x, y, target) => ({ clientX: r.left + x * k, clientY: r.top + y * k, target });
  if (at && at.how === 'k' && K && K.el && !K.event) return pt(K.x + K.w / 2, K.cy, K.el);
  if (at && at.how === 'p') return pt(at.x, at.dy != null ? G.laneY(s.lane) + at.dy : at.y, st);
  if (T && T.el) return pt(T.x + T.w / 2, T.cy, T.el);
  return pt(G.nowX, G.laneY(s.lane), st);
}
function obFindPick(i) {
  const s = FIND.items[i]; if (!s) return;
  FIND.pv = null; FIND.prev = null;        // the pick replaces whatever was lit
  obFindClose(); FIND.inp.blur();
  obFindPin(s.s, true);
}
function obFindPin(sym, pulse, opts) {
  clearTimeout(FIND.wait);
  if (FX.show) { FIND.wait = setTimeout(() => obFindPin(sym, pulse, opts), 150); return; }   // the build show plays untouched: the pick waits for its end
  if (!M || !G || !M.bySym[sym]) return;
  const h = { kind: 'stock', sym, find: 1 };
  if (pulse) h.rev = performance.now();    // a light runs the stock's path back to the market picture
  FX.hover = null; obFindApply(h, opts);
}
/* a re-render (the minute update, a resize) rebuilds the page and drops what was lit. The pins come back: the
   search's own, and a stock or sector pinned with a click on the page, its popup where it stood. An open list keeps
   its text, its place and its lit stock with the new minute's figures. */
/* a pin in a fresh object (a lit path caches the layout it was drawn on). A stock whose popup is open notes where it
   stands, as placeInspector placed it: beside its setup card ('k'), around its tile ('t') or at a point of the stage
   ('p'; on a lane of the flow, its offset in the lane, so it rides along when the stock changes lanes). The lane is
   read on the layout the popup was placed on (the page may since have been the phone's, which has its own G) */
function obFindCopy(p) {
  if (!p) return null;
  const i = $('#inspector'), c = { kind: p.kind, sym: p.sym, sec: p.sec, find: p.find, t0: p.t0, at: p.at };
  if (p.kind === 'stock' && i && i.classList.contains('on') && i._sym === p.sym && i._at && i._atG) {
    const [x, y] = i._at, g = i._atG, lane = !i._fixed && x >= 66 && x <= 696 && y >= g.T0 && y < g.T1;
    c.at = { how: i._fixed ? i._fixed[0] : 'p', x, y, dy: lane ? y - g.T0 - (Math.floor((y - g.T0) / g.P) + 0.5) * g.P : null };
  }
  return c;
}
function obFindKeep() {
  const p = FX.pinned;
  return {
    pin: p && p.find === 1 ? p.sym : '', pv: FIND.pv ? FIND.pv.sym : '', prev: obFindCopy(FIND.prev),
    held: p && !p.find && (p.kind === 'stock' || p.kind === 'sector') ? obFindCopy(p) : null,   // pinned with a click
  };
}
function obFindRestore(k) {
  if (OB_PEEK) return;
  obFindMount(); obFindPlace();
  if (!k || S.stacked) return;
  FIND.pv = null; FIND.prev = null;
  if (FIND.open) {
    const sym = FIND.items[FIND.at] ? FIND.items[FIND.at].s : '', top = FIND.box.scrollTop;
    FIND.items = obFindItems(FIND.q); FIND.at = sym ? FIND.items.findIndex(s => s.s === sym) : -1;
    FIND.box.innerHTML = obFindRows(); FIND.box.scrollTop = top; obFindAria();
  }
  const keepOpts = { preserveInspector: true, keepBrushClass: true };
  if (k.pv && FIND.open && FIND.at >= 0) { FX.pinned = k.prev; obFindPreview(FIND.at); }
  else if (k.pv && k.prev) obFindApply(k.prev, keepOpts);
  else if (k.pin) obFindPin(k.pin, false, keepOpts);
  else if (k.held && !FX.show) obFindApply(k.held, keepOpts);   // the build show plays untouched
}
if (!OB_PEEK) {
  window.addEventListener('keydown', e => {
    if (!M || e.defaultPrevented || e.isComposing) return;
    if (FIND.open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); obFindClose(); FIND.inp.blur(); return; }
    const t = e.target; if (t && t.closest && t.closest('input,textarea,select,[contenteditable],dialog')) return;
    const k = (e.key || '').toLowerCase(), mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    if ((mod && (k === 'k' || k === 'f')) || (k === '/' && !e.metaKey && !e.ctrlKey && !e.altKey)) { e.preventDefault(); e.stopPropagation(); obFindOpen(); }
  }, true);
  window.addEventListener('message', e => { if (e.origin === location.origin && e.data && e.data.t === 'ob-find') obFindOpen(); });
}


function obControlsMount() {

  // Bind Left Sidebar Rail expand/collapse & theme toggle
  const rail = document.getElementById("obSideRail");
  if (rail && !rail._mounted) {
    rail._mounted = true;
    const syncRailW = () => {
      const targetW = document.body.classList.contains("rail-expanded") ? 190 : 54;
      document.documentElement.style.setProperty("--rail-w", targetW + "px");
    };
    syncRailW();
    const toggleBtn = document.getElementById("obRailToggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const exp = document.body.classList.toggle("rail-expanded");
        toggleBtn.textContent = exp ? "«" : "»";
        syncRailW();
        requestAnimationFrame(() => {
          if (typeof rerender === "function") rerender(true);
        });
      });
    }
    const themeBtns = [...rail.querySelectorAll(".rt-btn")];
    const syncThemeBtns = (theme) => {
      themeBtns.forEach(b => {
        const active = b.dataset.themeSet === theme;
        b.classList.toggle("on", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
    };
    const browserDefaultTheme = () => {
      if (!window.matchMedia) return "dark";
      if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      return "dark";
    };
    const curTheme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    syncThemeBtns(curTheme);
    themeBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const nextTheme = btn.dataset.themeSet === "light" ? "light" : "dark";
        const rendered = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
        if (nextTheme === rendered) return;
        const sys = browserDefaultTheme();
        if (nextTheme !== sys) {
          document.cookie = "ob_theme=" + nextTheme + "; path=/; max-age=31536000; SameSite=Lax";
        } else {
          document.cookie = "ob_theme=; path=/; max-age=0; SameSite=Lax";
        }
        syncThemeBtns(nextTheme);
        window.postMessage({ t: "ob-theme", theme: nextTheme }, location.origin);
      });
    });
  }

  const bar = document.getElementById("obTopBar");
  if (!bar || bar._mounted || OB_PEEK) return;
  bar._mounted = true;

  const secSel = bar.querySelector("#obSecSel");
  const sortSel = bar.querySelector("#obSortSel");
  const pills = [...bar.querySelectorAll(".obc-pill")];
  const syncBtn = bar.querySelector("#obSyncBtn");

  if (secSel) {
    secSel.addEventListener("change", () => {
      OBF_FEED.load({ sector: secSel.value });
    });
  }
  if (sortSel) {
    sortSel.addEventListener("change", () => {
      OBF_FEED.load({ sort: sortSel.value });
    });
  }
  pills.forEach(btn => {
    btn.addEventListener("click", () => {
      const nextSide = btn.dataset.side;
      const prevSide = (OBF_FEED.filter && OBF_FEED.filter.side) || "ALL";
      if (nextSide === prevSide) return;
      pills.forEach(p => p.classList.toggle("on", p === btn));
      if (window.gsap) {
        gsap.fromTo("#tickets, #ladderWrap, #plumeWrap", { opacity: 0.52 }, { opacity: 1, duration: 0.24, ease: "power2.out", overwrite: "auto" });
      }
      OBF_FEED.load({ side: nextSide });
    });
  });
  if (syncBtn) {
    syncBtn.addEventListener("click", () => {
      syncBtn.style.transform = "rotate(360deg)";
      OBF_FEED.load();
      setTimeout(() => { syncBtn.style.transform = "none"; }, 400);
    });
  }

  const applyFxPaused = (paused, persist = false) => {
    FX.userPaused = Boolean(paused);
    if (persist) {
      try { localStorage.setItem("ob_fx_paused", FX.userPaused ? "1" : "0"); } catch (e) {}
    }
    if (document.body && document.body.classList) document.body.classList.toggle("fx-paused", FX.userPaused);
    if (typeof PULSE !== "undefined" && PULSE) {
      PULSE.dirty = true;
      if (FX.userPaused) obPulseRenderFrame(PULSE, performance.now());
      else obPulseWake(PULSE);
    }
    wakeFx(true);
  };
  let initPaused = FX && FX.userPaused;
  try { initPaused = localStorage.getItem("ob_fx_paused") === "1"; } catch (e) {}
  applyFxPaused(initPaused, false);
  window.addEventListener("storage", (e) => {
    if (e && e.key === "ob_fx_paused") {
      applyFxPaused(e.newValue === "1", false);
    }
  });

  // Live clock ticker + real Upstox connection state + NSE market open/close countdown
  const clockEl = document.getElementById("obLiveClock");
  const mktWrap = document.getElementById("obMarketStatus");
  const mktStateEl = document.getElementById("obMarketState");
  const mktCountEl = document.getElementById("obMarketCount");
  if (clockEl || mktWrap) {
    let lastMktShort = "";
    const updateStatusAndClk = () => {
      if (document.hidden) return;
      const now = new Date();
      if (clockEl) {
        const hrs = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const sec = String(now.getSeconds()).padStart(2, '0');
        const st = (window.OBF_FEED && window.OBF_FEED.status) || {};
        const prefix = st.tokenExpired ? "TOKEN EXPIRED" : (st.state || "LIVE");
        const nextClk = `${prefix} ${hrs}:${min}:${sec}`;
        if (clockEl.textContent !== nextClk) clockEl.textContent = nextClk;
      }
      if (mktWrap && window.NSEMarketHours && typeof window.NSEMarketHours.getMarketStatus === "function") {
        const ms = window.NSEMarketHours.getMarketStatus(now);
        if (ms.shortText !== lastMktShort) {
          lastMktShort = ms.shortText;
          mktWrap.classList.toggle("is-open", Boolean(ms.open));
          mktWrap.classList.toggle("is-closed", !ms.open);
          if (mktStateEl) mktStateEl.textContent = ms.statusLabel;
          if (mktCountEl) mktCountEl.textContent = `${ms.countdownAction} ${ms.countdownText}`;
          mktWrap.setAttribute("title", ms.detailText);
          mktWrap.setAttribute("aria-label", ms.detailText);
        }
      }
    };
    if (window.OBF_FEED) {
      window.OBF_FEED.onStatus = () => updateStatusAndClk();
    }
    updateStatusAndClk();
    setInterval(updateStatusAndClk, 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateStatusAndClk();
    });
  }
}

function obControlsPlace() {
  obControlsMount();
  const meta = (M && M.D && M.D.meta) || {};
  const counts = meta.counts || { all: M ? M.lanes.length : 218, bull: M ? M.nBullAll : 0, bear: M ? M.nBearAll : 0 };
  const cAll = document.getElementById("obCntAll"), cBull = document.getElementById("obCntBull"), cBear = document.getElementById("obCntBear");
  if (cAll) cAll.textContent = counts.all;
  if (cBull) cBull.textContent = counts.bull;
  if (cBear) cBear.textContent = counts.bear;

  const secSel = document.getElementById("obSecSel");
  if (secSel && Array.isArray(meta.allSectors)) {
    const cur = (OBF_FEED.filter && OBF_FEED.filter.sector) || "ALL";
    let htmlOpts = `<option value="ALL">All Sectors (${counts.universeTotal || counts.all})</option>`;
    meta.allSectors.forEach(s => {
      const sign = s.chg >= 0 ? "+" : "−";
      htmlOpts += `<option value="${s.sec}">${s.sec} (${s.n} · ${sign}${Math.abs(s.chg).toFixed(2)}%)</option>`;
    });
    if (secSel._lastHtml !== htmlOpts) {
      secSel.innerHTML = htmlOpts;
      secSel._lastHtml = htmlOpts;
    }
    secSel.value = cur;
  }
  const sortSel = document.getElementById("obSortSel");
  if (sortSel) {
    sortSel.value = (OBF_FEED.filter && OBF_FEED.filter.sort) || "MAX_GAINS";
  }
}

/* ================= main ================= */
let M = null, G = null;
const TX_REAL = 11.6, TX_MAX = 1.39;
const FOOT_TXT = '';
function computeScale() {
  const W = window.innerWidth, H = window.innerHeight;
  S.stacked = W < 800 || W / H < 1.05;
  S.crest2 = false;
  S.dpr = Math.min(2, window.devicePixelRatio || 1);
  S.reduced = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!S.stacked) {
    const railEl = document.getElementById('obSideRail');
    const LEFT_RAIL_W = railEl ? (document.body.classList.contains('rail-expanded') ? 190 : 54) : 0;
    const TOP_BAR_H = 36;
    const availH = Math.max(400, H - TOP_BAR_H);
    const availW = Math.max(600, W - LEFT_RAIL_W);
    if (availW / 1920 <= availH / 1080) {
      S.s = availW / 1920;
      S.W = 1920;
      S.Hd = Math.max(920, Math.round(availH / S.s));
    } else {
      S.s = availH / 1080;
      S.Hd = 1080;
      S.W = Math.max(1920, Math.round(availW / S.s));
    }
    S.tx = S.s >= 0.95 ? 1 : Math.min(1.18, 1 / Math.sqrt(S.s));
    S.k = S.s * S.dpr;
    S.tier3 = S.s >= 0.8;
    S.crest2 = S.tx >= 1.15;
    S.left = LEFT_RAIL_W;
    S.top = TOP_BAR_H;
  }
}
function renderStage() {
  const st = $('#stage'), obKeep = obFindKeep();
  const prevHover = typeof FX !== 'undefined' && !FX.pinned && FX.hover ? obFindCopy(FX.hover) : null;
  if (prevHover && typeof FX !== 'undefined' && FX.hover && FX.hover.rev) prevHover.rev = FX.hover.rev;
  if (typeof FX !== 'undefined') { FX.hover = null; FX.pinned = null; }
  if (typeof PH !== 'undefined') PH.gen++;
  if (typeof FX !== 'undefined' && FX.show) {
    st.classList.remove('brush'); const ins = $('#inspector'); if (ins) { ins.classList.remove('on'); ins._at = null; }
  }
  G = layout(S.Hd, M);
  css(st, { width: G.W, height: S.Hd, left: S.left, top: S.top }); st.style.transform = `scale(${S.s})`;
  st.classList.toggle('t3off', !S.tier3); st.style.setProperty('--tx', S.tx); st.style.setProperty('--txc', S.crest2 ? Math.min(S.tx, 1.3) : Math.min(S.tx, 1.08)); st.classList.toggle('crest2', !!S.crest2);
  document.documentElement.style.setProperty('--tx', S.tx);
  buildCrest(M, G, $('#crest'));
  const pw = $('#plumeWrap'); pw.innerHTML = ''; pw._lens = null;
  drawAxis(M, G, pw); drawPlume(M, G, pw); drawWalls(M, G, pw);
  buildChips(M, G, $('#chips'));
  const lw = $('#ladderWrap'); lw.innerHTML = ''; lw._lens = null;
  drawLadder(M, G, lw); drawLens(M, G, lw, null); drawSpine(M, G, lw);
  buildNodes(M, G, $('#nodes'));
  buildTiles(M, G, $('#tiles'));
  buildBridges(M, G, $('#bridges'));
  buildTickets(M, G, $('#tickets'));
  const f = $('#footer'); if (f) { css(f, { top: S.Hd - 21 }); f.textContent = FOOT_TXT; }
  if (typeof afterRender === 'function') afterRender();
  obFindRestore(obKeep); obControlsPlace();   // the field placed over the new stage, the pin and the list back (terminal_find.js)
  obRestoreHoverAfterRender(prevHover);
}
function obSnapDigest(d) {
  if (!d || !Array.isArray(d.stocks)) return '';
  const m = d.meta || {}, f = m.filter || {}, ct = m.counts || {};
  const parts = [
    m.status || '', f.sector || 'ALL', f.side || 'ALL', f.sort || 'MAX_GAINS',
    ct.all || 0, ct.bull || 0, ct.bear || 0,
    (d.sectors || []).map(x => `${x.sec}:${x.chg}:${x.n}`).join(','),
  ];
  for (let i = 0; i < d.stocks.length; i++) {
    const s = d.stocks[i], x = s.x;
    parts.push(
      `${s.s}:${s.l}:${s.c}:${s.top ? 1 : 0}:${s.g}:${s.bu || ''}:${s.setupScore || 0}:${s.strengthScore || 0}:${x && x.ob ? x.ob.join(',') : ''}:${x && x.k && x.k.c ? x.k.c.length : 0}`
    );
  }
  return parts.join('|');
}
function boot() {
  if (OB_PEEK) { obPeekBoot(); return; }
  try {
    M = buildModel(OBF_FEED.data);
    if (M) M._sig = obSnapDigest(OBF_FEED.data);
  } catch (e) { console.warn('model failed', e); return; }
  computeScale();
  document.body.classList.toggle('stacked', S.stacked); document.documentElement.classList.toggle('stacked', S.stacked);
  let started = false;
  const go = () => {
    if (started) return;
    if (!window.innerWidth || !window.innerHeight) return;   // no size yet: the resize handler starts it
    started = true; computeScale(); document.body.classList.toggle('stacked', S.stacked); document.documentElement.classList.toggle('stacked', S.stacked);
    try {
      if (S.stacked) { if (typeof renderStack === 'function') renderStack(); }
      else renderStage();
    } catch (e) { console.warn('render failed', e); }
    if (!S.stacked) {
      try {
        finalState();
      } catch (e) {
        console.warn('show failed', e);
        $('#stage').classList.remove('pre');
      }
    }
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!started) go(); else lateFonts(); });
  setTimeout(go, 20);
  let to = null; window.addEventListener('resize', () => { clearTimeout(to); to = setTimeout(() => { if (started) rerender(true); else go(); }, 75); });
}
let LATE_FONTS = false;
function lateFonts() {
  if (LATE_FONTS) return; LATE_FONTS = true;
  const doIt = () => { if (FX.show) { setTimeout(doIt, 300); return; } rerender(); };
  doIt();
}
function rerender(resize) {
  if (!window.innerWidth || !window.innerHeight) return;   // hidden / unsized frame: the next resize renders
  const was = S.stacked; computeScale();
  if (resize && was && S.stacked && typeof phKeep === 'function' && phKeep()) return;   // phone: same width and theme, nothing to rebuild
  document.body.classList.toggle('stacked', S.stacked); document.documentElement.classList.toggle('stacked', S.stacked);
  try {
    if (S.stacked) { if (typeof renderStack === 'function') renderStack(); }
    else {
      const wasShowing = typeof FX !== 'undefined' && FX.show;
      renderStage();
      if (typeof settleShow === 'function') settleShow();
      if (wasShowing && typeof obHoverAfterShow === 'function') obHoverAfterShow();
    }
  } catch (e) { console.warn('rerender failed', e); }
}
OBF_FEED.onUpdate = function (d) { if (FX.show) { setTimeout(() => { if (OBF_FEED.data === d) OBF_FEED.onUpdate(d); }, 300); return; }
  const sig = obSnapDigest(d);
  if (M && !OB_PEEK && sig && M._sig === sig) {
    M.D = d;
    const ck = $('#clockT'); if (ck) ck.textContent = obClock();
    return;
  }
  let m2; try { m2 = buildModel(d); } catch (e) { console.warn('model failed', e); return; }
  m2._sig = sig;
  M = m2;
  if (OB_PEEK) { if (PEEK) obPeek(PEEK); } else rerender();
};
OBF_FEED.ready.then(function () { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot(); });

