/* global EventSource */
'use strict';

(() => {
  let appState = null;
  const detailCache = new Map(); // symbol -> full detail from /api/stock/:symbol
  const pendingFetches = new Map();

  let hoveredSymbol = null;
  let hoveredSector = null;
  let selectedSector = 'ALL';
  let filterMode = 'ALL'; // ALL | BULL | BEAR
  let sortOrder = 'FLOW_SCORE'; // FLOW_SCORE (Strongest Flow) | OB_STRENGTH (Strongest Order Block)
  let searchQuery = '';
  let screenerViewMode = 'TABLE'; // TABLE | GRID
  let stageCollapsed = false;
  let lockedSymbol = null;
  let trackerOnlyFilter = false;
  let showHoverPopup = true;
  let animPaused = false;
  let lastPointer = { x: 0, y: 0, zone: 'none' };

  // Smooth animated split state for Flow Stream Canvas (0.5 = All Split, 1.0 = Bullish Full, 0.0 = Bearish Full)
  let currentSplitRatio = 0.5;
  let targetSplitRatio = 0.5;
  let currentBullStreamStocks = [];
  let currentBearStreamStocks = [];

  const els = {
    searchInput: document.getElementById('hudSearchInput'),
    searchDropdown: document.getElementById('searchDropdown'),
    hoverBanner: document.getElementById('hudHoverBanner'),
    hoverText: document.getElementById('hudHoverText'),
    syncMeta: document.getElementById('hudSyncMeta'),
    liveConnDot: document.getElementById('liveConnDot'),
    intradayWaveSvg: document.getElementById('intradayWaveSvg'),
    bullCountStat: document.getElementById('bullCountStat'),
    bearCountStat: document.getElementById('bearCountStat'),
    lbBullBar: document.getElementById('lbBullBar'),
    lbBearBar: document.getElementById('lbBearBar'),
    streamBody: document.getElementById('streamBody'),
    flowCanvas: document.getElementById('flowStreamCanvas'),
    sectorNodesTop: document.getElementById('sectorNodesTop'),
    sectorNodesBottom: document.getElementById('sectorNodesBottom'),
    spineBullVal: document.getElementById('spineBullVal'),
    spineBearVal: document.getElementById('spineBearVal'),
    bullMatrix: document.getElementById('bullMatrix'),
    bearMatrix: document.getElementById('bearMatrix'),
    bullChartsStack: document.getElementById('bullChartsStack'),
    bearChartsStack: document.getElementById('bearChartsStack'),
    stageOverlaySvg: document.getElementById('stageOverlaySvg'),
    hoverChartPopover: document.getElementById('hoverChartPopover'),
    toastStack: document.getElementById('obToastStack'),
    toggleAnimBtn: document.getElementById('toggleAnimBtn'),
    filterTrackerBtn: document.getElementById('filterTrackerBtn'),
    toggleHoverPopupBtn: document.getElementById('toggleHoverPopupBtn'),
    quickRemindActiveBtn: document.getElementById('quickRemindActiveBtn'),
    quickTrackActiveBtn: document.getElementById('quickTrackActiveBtn'),
    pinLockBtn: document.getElementById('pinLockBtn'),
    obSyncNowBtn: document.getElementById('obSyncNowBtn'),
    obZoomOut: document.getElementById('obZoomOut'),
    obZoomReset: document.getElementById('obZoomReset'),
    obZoomIn: document.getElementById('obZoomIn'),
    sectorSelect: document.getElementById('sectorSelect'),
    sortOrderSelect: document.getElementById('sortOrderSelect'),
    toggleStageCollapseBtn: document.getElementById('toggleStageCollapseBtn'),
    obStage: document.getElementById('obStage'),
    screenerResultCount: document.getElementById('screenerResultCount'),
    screenerFilterSummary: document.getElementById('screenerFilterSummary'),
    screenerTableWrapper: document.getElementById('screenerTableWrapper'),
    screenerTableBody: document.getElementById('screenerTableBody'),
    screenerGridContainer: document.getElementById('screenerGridContainer'),
    stickyInspectorBody: document.getElementById('stickyInspectorBody'),
    resetFiltersBtn: document.getElementById('resetFiltersBtn'),
    viewModeTableBtn: document.getElementById('viewModeTableBtn'),
    viewModeGridBtn: document.getElementById('viewModeGridBtn'),
    countAllBadge: document.getElementById('countAllBadge'),
    countBullBadge: document.getElementById('countBullBadge'),
    countBearBadge: document.getElementById('countBearBadge'),
  };

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }

  function fmtNum(n, digits = 2) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-IN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  }

  function showToast(msg) {
    const div = document.createElement('div');
    div.className = 'ob-toast';
    div.textContent = msg;
    els.toastStack.appendChild(div);
    setTimeout(() => div.remove(), 4200);
  }

  // Ensure clean 100% native viewport scale so the full-screen stage is never clipped
  document.documentElement.style.zoom = '';

  // Fetch & cache full 3-minute candle detail for any symbol on hover
  async function ensureStockDetail(symbol) {
    if (!symbol) return null;
    const sym = symbol.toUpperCase();
    if (detailCache.has(sym)) return detailCache.get(sym);
    if (pendingFetches.has(sym)) return pendingFetches.get(sym);

    const p = fetch(`/api/stock/${encodeURIComponent(sym)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        pendingFetches.delete(sym);
        if (d && d.stock) {
          detailCache.set(sym, d);
        }
        return d;
      })
      .catch(() => {
        pendingFetches.delete(sym);
        return null;
      });
    pendingFetches.set(sym, p);
    return p;
  }

  function getStockCardFromUniverse(symbol) {
    if (!symbol || !appState) return null;
    const sym = symbol.toUpperCase();
    return (
      (appState.universe || []).find(s => s.symbol === sym) ||
      (appState.topBull || []).find(s => s.symbol === sym) ||
      (appState.topBear || []).find(s => s.symbol === sym) ||
      null
    );
  }

  // Compute Support (S1/S2), Order Block Zone, Resistance (R1/R2), and Risk:Reward for a card
  function computeCardLevels(card, detail) {
    const ltp = card.ltp || 0;
    const isBull = card.side !== 'BEAR';
    const ob =
      detail?.obInfo?.primaryOB ||
      card.primaryOB ||
      (isBull ? card.bestBullOB : card.bestBearOB);

    const zBot = ob?.bot ?? Number((ltp * (isBull ? 0.994 : 1.002)).toFixed(2));
    const zTop = ob?.top ?? Number((ltp * (isBull ? 0.998 : 1.006)).toFixed(2));

    const levels = detail?.levels || card.levels || [];
    const sLevels = levels.filter(l => l.kind === 's').map(l => l.price).sort((a, b) => b - a);
    const rLevels = levels.filter(l => l.kind === 'r').map(l => l.price).sort((a, b) => a - b);

    const s1 = sLevels[0] ?? card.val ?? Number((ltp * 0.988).toFixed(2));
    const s2 = sLevels[1] ?? Number((s1 * 0.991).toFixed(2));
    const r1 = rLevels[0] ?? card.vah ?? Number((ltp * 1.012).toFixed(2));
    const r2 = rLevels[1] ?? Number((r1 * 1.011).toFixed(2));

    const riskPts = isBull
      ? Math.max(0.25, Math.abs(ltp - Math.min(s1, zBot)))
      : Math.max(0.25, Math.abs(Math.max(r1, zTop) - ltp));
    const rewardPts = isBull
      ? Math.max(0.5, Math.abs(r2 - ltp))
      : Math.max(0.5, Math.abs(ltp - s2));
    const rr = Math.min(9.9, Math.max(0.8, rewardPts / riskPts)).toFixed(1);
    const riskPct = ltp > 0 ? ((riskPts / ltp) * 100).toFixed(2) : '0.80';

    const span = Math.max(0.01, r2 - s2);
    const posPct = Math.max(4, Math.min(96, ((ltp - s2) / span) * 100));

    return {
      zBot,
      zTop,
      s1,
      s2,
      r1,
      r2,
      rr: `1:${rr}`,
      riskPct: `${riskPct}%`,
      posPct,
      hasRealOB: Boolean(ob),
      obStatus: ob?.status || 'UNTESTED',
    };
  }

  // Render Top-Left Intraday Bull/Bear Wave Histogram driven by real chart 3m candles & order flow
  function renderIntradayWave(universe = []) {
    const bulls = universe.filter(s => s.side === 'BULL');
    const bears = universe.filter(s => s.side === 'BEAR');
    els.bullCountStat.textContent = String(bulls.length);
    els.bearCountStat.textContent = String(bears.length);

    const total = Math.max(1, bulls.length + bears.length);
    const rawBullRatio = Math.max(0.18, Math.min(0.82, bulls.length / total));
    if (els.lbBullBar && els.lbBearBar) {
      if (filterMode === 'BULL') {
        els.lbBullBar.style.flex = '1';
        els.lbBearBar.style.flex = '0.0001';
      } else if (filterMode === 'BEAR') {
        els.lbBullBar.style.flex = '0.0001';
        els.lbBearBar.style.flex = '1';
      } else {
        els.lbBullBar.style.flex = String(rawBullRatio);
        els.lbBearBar.style.flex = String(1 - rawBullRatio);
      }
    }

    const W = 460;
    const H = 56;
    const midY = 30;
    const barsCount = 52;
    const stepX = W / barsCount;
    const parts = [
      `<line x1="0" x2="${W}" y1="${midY}" y2="${midY}" stroke="rgba(255,255,255,0.18)" stroke-width="0.8"/>`,
    ];

    const activeSym = lockedSymbol || hoveredSymbol;
    const activeDetail = activeSym ? detailCache.get(activeSym) : null;
    const candles = activeDetail?.candles || [];

    if (candles.length >= 12) {
      // Driven directly by the active chart's real 3-minute candle deltas & volume!
      const slice = candles.slice(-barsCount);
      const impulses = slice.map(c => {
        const open = Number(c[1] || c[4] || 1);
        const high = Number(c[2] || open);
        const low = Number(c[3] || open);
        const close = Number(c[4] || open);
        const vol = Math.max(1, Number(c[5] || 1));
        const body = close - open;
        const range = Math.max(0.0001, high - low);
        const signed = body !== 0 ? body : close >= (high + low) / 2 ? range * 0.35 : -range * 0.35;
        return signed * Math.sqrt(vol);
      });
      const maxImp = Math.max(0.0001, ...impulses.map(v => Math.abs(v)));
      let nexusX = 22 * stepX;

      for (let i = 0; i < barsCount; i++) {
        const idx = Math.min(impulses.length - 1, Math.floor((i / barsCount) * impulses.length));
        const imp = impulses[idx] || 0;
        const norm = Math.min(1, Math.abs(imp) / maxImp);
        const h = Math.max(2.8, norm * 24);
        const x = i * stepX + 3;
        const isUp = filterMode === 'BULL' ? true : filterMode === 'BEAR' ? false : imp >= 0;
        if (idx > 0 && impulses[idx - 1] < 0 && imp >= 0) {
          nexusX = x;
        }
        if (isUp) {
          parts.push(
            `<rect x="${x.toFixed(1)}" y="${(midY - h).toFixed(1)}" width="3.2" height="${h.toFixed(1)}" rx="1" fill="#19f59e" opacity="${(0.45 + norm * 0.5).toFixed(2)}"/>`
          );
        } else {
          parts.push(
            `<rect x="${x.toFixed(1)}" y="${midY}" width="3.2" height="${h.toFixed(1)}" rx="1" fill="#ff4769" opacity="${(0.45 + norm * 0.5).toFixed(2)}"/>`
          );
        }
      }
      parts.push(`<circle cx="${nexusX.toFixed(1)}" cy="${midY}" r="3.5" fill="#ffffff"/>`);
    } else {
      // Driven by the real sorted Bearish & Bullish stock flow intensities
      const bearPool = (currentBearStreamStocks.length ? currentBearStreamStocks : bears).slice(0, 26);
      const bullPool = (currentBullStreamStocks.length ? currentBullStreamStocks : bulls).slice(0, 30);
      const splitIdx = filterMode === 'BULL' ? 0 : filterMode === 'BEAR' ? barsCount : 22;

      for (let i = 0; i < barsCount; i++) {
        const x = i * stepX + 3;
        if (i < splitIdx) {
          const st = bearPool[i % Math.max(1, bearPool.length)];
          const score = st ? (st.strengthScore || 55) / 100 : 0.55;
          const h = Math.max(3.5, score * 22);
          parts.push(
            `<rect x="${x.toFixed(1)}" y="${midY}" width="3.2" height="${h.toFixed(1)}" rx="1" fill="#ff4769" opacity="${(0.42 + score * 0.48).toFixed(2)}"/>`
          );
        } else {
          const k = i - splitIdx;
          const st = bullPool[k % Math.max(1, bullPool.length)];
          const score = st ? (st.strengthScore || 60) / 100 : 0.6;
          const h = Math.max(3.5, score * 24);
          parts.push(
            `<rect x="${x.toFixed(1)}" y="${(midY - h).toFixed(1)}" width="3.2" height="${h.toFixed(1)}" rx="1" fill="#19f59e" opacity="${(0.45 + score * 0.5).toFixed(2)}"/>`
          );
        }
      }
      parts.push(`<circle cx="${(splitIdx * stepX).toFixed(1)}" cy="${midY}" r="3.5" fill="#ffffff"/>`);
    }
    els.intradayWaveSvg.innerHTML = parts.join('');
  }

  // Compute enriched sectors ordered by net flow
  function getOrderedSectors(sectors = [], universe = []) {
    const countsBySec = new Map();
    for (const s of universe) {
      const sec = s.sector || 'Other';
      const cur = countsBySec.get(sec) || { bullCount: 0, bearCount: 0 };
      if (s.side === 'BEAR') cur.bearCount += 1;
      else cur.bullCount += 1;
      countsBySec.set(sec, cur);
    }

    const enriched = sectors.map(sec => {
      const c = countsBySec.get(sec.sector) || { bullCount: 0, bearCount: 0 };
      return {
        ...sec,
        bullCount: c.bullCount,
        bearCount: c.bearCount,
      };
    });

    enriched.sort((a, b) => b.flowCr - a.flowCr);
    return enriched;
  }

  // Render Left Sector Stack Nodes (Both stacks stay populated so Bearish smoothly slides down on Bullish click)
  function renderSectorStacks(sectors = [], universe = []) {
    const ordered = getOrderedSectors(sectors, universe);

    let bullSectors = ordered.filter(s => s.flowCr >= 0);
    let bearSectors = [...ordered].filter(s => s.flowCr < 0).reverse();

    if (bullSectors.length < 4 && ordered.length >= 6) {
      const half = Math.ceil(ordered.length / 2);
      bullSectors = ordered.slice(0, half);
      bearSectors = ordered.slice(half).reverse();
    } else if (bearSectors.length < 4 && ordered.length >= 6) {
      const half = Math.ceil(ordered.length / 2);
      bullSectors = ordered.slice(0, half);
      bearSectors = ordered.slice(half).reverse();
    }

    const bullLimit = filterMode === 'BULL' ? 12 : 8;
    const bearLimit = filterMode === 'BEAR' ? 12 : 8;
    const displayBullSectors = (filterMode === 'BULL' && bullSectors.length < 10 ? ordered : bullSectors).slice(0, bullLimit);
    const displayBearSectors = (filterMode === 'BEAR' && bearSectors.length < 10 ? [...ordered].reverse() : bearSectors).slice(0, bearLimit);

    const totalBullCr = displayBullSectors.reduce((a, s) => a + Math.abs(s.flowCr), 0);
    const totalBearCr = displayBearSectors.reduce((a, s) => a + Math.abs(s.flowCr), 0);
    els.spineBullVal.textContent = `+${totalBullCr.toFixed(0)} Cr`;
    els.spineBearVal.textContent = `-${totalBearCr.toFixed(0)} Cr`;

    const activeSec = selectedSector !== 'ALL' ? selectedSector : hoveredSector;

    const buildSectorNodeHtml = (sec, isBull, pool) => {
      const maxCr = Math.max(1, ...pool.map(x => Math.abs(x.flowCr)));
      const ratio = Math.max(0.2, Math.min(1, Math.abs(sec.flowCr) / maxCr));
      const litCount = Math.max(2, Math.round(ratio * 7));
      let segs = '';
      for (let i = 0; i < 7; i++) {
        const cls = i < litCount ? (isBull ? 'on-up' : 'on-dn') : '';
        segs += `<span class="shn-seg ${cls}"></span>`;
      }
      const isAct = activeSec === sec.sector;
      return `
        <div class="sector-hud-node ${isBull ? 'bull' : 'bear'} ${isAct ? 'active' : ''}"
             data-sector="${escapeHtml(sec.sector)}"
             data-side="${isBull ? 'BULL' : 'BEAR'}">
          <div class="shn-top">
            <span class="shn-name">${escapeHtml(sec.sector.toUpperCase())}</span>
            <span class="shn-pct ${isBull ? 'up' : 'dn'}">${sec.avgChgPct >= 0 ? '+' : ''}${sec.avgChgPct.toFixed(1)}%</span>
          </div>
          <div class="shn-bars">${segs}</div>
        </div>
      `;
    };

    els.sectorNodesTop.innerHTML = displayBullSectors.map(s => buildSectorNodeHtml(s, true, displayBullSectors)).join('');
    els.sectorNodesBottom.innerHTML = displayBearSectors.map(s => buildSectorNodeHtml(s, false, displayBearSectors)).join('');
  }

  // Helper: get best Order Block object + impulse strength + distance % for a stock card
  function getCardOrderBlockMeta(card) {
    const detail = detailCache.get(card.symbol);
    const ob =
      detail?.obInfo?.primaryOB ||
      card.primaryOB ||
      (card.side === 'BEAR' ? card.bestBearOB : card.bestBullOB) ||
      card.bestBullOB ||
      card.bestBearOB ||
      null;
    const str = Number(ob?.str ?? 0);
    const distPct = ob?.distPct !== null && ob?.distPct !== undefined ? Number(ob.distPct) : 99;
    const status = ob?.status || (distPct <= 0.15 ? 'IN_ZONE' : distPct <= 0.65 ? 'APPROACHING' : 'UNTESTED');
    return { ob, str, distPct, status };
  }

  // Filter and sort the 218-stock universe according to Sector, Side (All/Bullish/Bearish), Search, and Sort (Strongest Flow / Strongest Order Block)
  function getFilteredAndSortedStocks(universe = [], { ignoreSidePill = false } = {}) {
    const trackerSet = new Set((appState?.tracker || []).map(t => t.symbol));
    const activeSec = selectedSector !== 'ALL' ? selectedSector : hoveredSector;

    let list = [...universe];

    if (trackerOnlyFilter) {
      list = list.filter(s => trackerSet.has(s.symbol));
    }

    if (activeSec) {
      list = list.filter(s => s.sector === activeSec);
    }

    if (searchQuery) {
      const q = searchQuery.toUpperCase();
      list = list.filter(
        s =>
          s.symbol.includes(q) ||
          (s.name || '').toUpperCase().includes(q) ||
          (s.sector || '').toUpperCase().includes(q) ||
          (s.buildup || '').toUpperCase().includes(q)
      );
    }

    if (!ignoreSidePill && filterMode === 'BULL') {
      list = list.filter(s => s.side === 'BULL');
    } else if (!ignoreSidePill && filterMode === 'BEAR') {
      list = list.filter(s => s.side === 'BEAR');
    }

    list.sort((a, b) => {
      if (sortOrder === 'OB_STRENGTH') {
        const sa = getCardOrderBlockMeta(a).str;
        const sb = getCardOrderBlockMeta(b).str;
        if (sb !== sa) return sb - sa;
      }
      if ((b.strengthScore || 0) !== (a.strengthScore || 0)) {
        return (b.strengthScore || 0) - (a.strengthScore || 0);
      }
      return Math.abs(b.rupeeFlowCr || 0) - Math.abs(a.rupeeFlowCr || 0);
    });

    return list;
  }

  // Render Middle Stock Matrix (Smoothly shifts Bearish down off screen on Bullish click, or shifts Bullish up on Bearish click)
  function renderStockMatrices(universe = []) {
    const isBullOnly = filterMode === 'BULL';
    const isBearOnly = filterMode === 'BEAR';

    // Update target split ratio for the Flow Stream Canvas smooth animation
    targetSplitRatio = isBullOnly ? 1.0 : isBearOnly ? 0.0 : 0.5;

    if (els.obStage) {
      els.obStage.classList.toggle('side-only-bull', isBullOnly);
      els.obStage.classList.toggle('side-only-bear', isBearOnly);
    }

    // Keep both sides populated from the sorted pool so the sliding half animates smoothly
    const sortedBothSides = getFilteredAndSortedStocks(universe, { ignoreSidePill: true });
    const maxBullTiles = isBullOnly ? 32 : 16;
    const maxBearTiles = isBearOnly ? 32 : 16;

    let bulls = sortedBothSides.filter(s => s.side === 'BULL').slice(0, maxBullTiles);
    let bears = sortedBothSides.filter(s => s.side === 'BEAR').slice(0, maxBearTiles);

    if (bulls.length < 4 && selectedSector === 'ALL' && !searchQuery && !trackerOnlyFilter) {
      const seen = new Set(bulls.map(x => x.symbol));
      for (const s of universe.filter(x => x.side === 'BULL')) {
        if (!seen.has(s.symbol)) bulls.push(s);
        if (bulls.length >= maxBullTiles) break;
      }
    }
    if (bears.length < 4 && selectedSector === 'ALL' && !searchQuery && !trackerOnlyFilter) {
      const seen = new Set(bears.map(x => x.symbol));
      for (const s of universe.filter(x => x.side === 'BEAR')) {
        if (!seen.has(s.symbol)) bears.push(s);
        if (bears.length >= maxBearTiles) break;
      }
    }

    // Store active stream stocks so #flowStreamCanvas strands are directly driven by the chart & stock flow
    currentBullStreamStocks = bulls;
    currentBearStreamStocks = bears;

    const renderTile = (card, idx, isBull) => {
      const colIdx = idx % 4;
      const isHovered = (lockedSymbol || hoveredSymbol) === card.symbol;
      const detail = detailCache.get(card.symbol);
      const lvls = computeCardLevels(card, detail);
      const obMeta = getCardOrderBlockMeta(card);
      const stars = '•'.repeat(Math.max(1, card.agree || 4));
      const barCount = colIdx === 3 ? 6 : colIdx === 2 ? 4 : 3;

      // Profile bars inside each tile driven by real chart volume profile or flow metrics
      const prof = detail?.profile;
      const flowMetrics = [
        Math.min(98, Math.max(25, Math.round(card.strengthScore || 65))),
        Math.min(98, Math.max(25, Math.round(isBull ? (card.buyPct || 60) : 100 - (card.buyPct || 40)))),
        Math.min(98, Math.max(25, Math.round(((card.agree || 3) / Math.max(1, card.totalChecks || 5)) * 100))),
        Math.min(98, Math.max(25, Math.round(Math.min(1, (obMeta.str || 1.2) / 2.8) * 96))),
        Math.min(98, Math.max(25, Math.round(Math.min(1, Math.abs(card.rupeeFlowCr || 80) / 350) * 95))),
        Math.min(98, Math.max(25, Math.round(Math.min(1, Math.abs(card.chgPct || 1.5) / 5) * 95))),
      ];

      let barsHtml = '';
      for (let b = 0; b < barCount; b++) {
        let w = flowMetrics[b % flowMetrics.length];
        if (prof && Array.isArray(prof.buy) && prof.buy.length) {
          const pIdx = Math.min(prof.buy.length - 1, Math.floor((b / barCount) * prof.buy.length));
          const sideArr = isBull ? prof.buy : prof.sell || prof.buy;
          const maxV = Math.max(1, ...sideArr);
          w = Math.min(98, Math.max(24, Math.round(((sideArr[pIdx] || 0) / maxV) * 96)));
        }
        barsHtml += `
          <div class="mt-pbar-wrap">
            <div class="mt-pbar ${isBull ? 'up' : 'dn'}" style="width:${w}%"></div>
          </div>
        `;
      }

      const zoneLabel = lvls.hasRealOB
        ? `OB ₹${fmtNum(lvls.zBot, 0)}–${fmtNum(lvls.zTop, 0)}${obMeta.str ? ` (${obMeta.str}×)` : ''}`
        : `Z ₹${fmtNum(lvls.zBot, 0)}`;

      return `
        <article class="m-tile ${isBull ? 'bull' : 'bear'} col-${colIdx} ${isHovered ? 'is-hovered' : ''}"
                 data-symbol="${escapeHtml(card.symbol)}"
                 data-side="${isBull ? 'BULL' : 'BEAR'}"
                 data-row="${Math.floor(idx / 4)}"
                 data-col="${colIdx}">
          <div class="mt-head">
            <span class="mt-sym">${escapeHtml(card.symbol)}</span>
            <span class="mt-chg ${isBull ? 'up' : 'dn'}">${fmtPct(card.chgPct)}</span>
          </div>
          <div class="mt-price-row">
            <span>₹${fmtNum(card.ltp, 1)}</span>
            <span>Buy ${Math.round(card.buyPct ?? 50)}%</span>
          </div>
          ${
            colIdx >= 2
              ? `<div class="mt-buildup-row">
                   <span class="mt-buildup-tag">${escapeHtml(card.buildup || (isBull ? 'LONG BUILD-UP' : 'SHORT BUILD-UP'))}</span>
                   <span class="mt-stars ${isBull ? 'up' : 'dn'}">${stars}</span>
                 </div>`
              : ''
          }
          <div class="mt-profile-bars">${barsHtml}</div>
          <div class="mt-foot">
            <span class="mt-ob-chip ${lvls.obStatus === 'IN_ZONE' ? 'in-zone' : ''}">${zoneLabel}</span>
            <span class="mt-stars ${isBull ? 'up' : 'dn'}">${colIdx < 2 ? stars : `${card.agree}/${card.totalChecks}`}</span>
          </div>
        </article>
      `;
    };

    els.bullMatrix.innerHTML = bulls.map((c, i) => renderTile(c, i, true)).join('');
    els.bearMatrix.innerHTML = bears.map((c, i) => renderTile(c, i, false)).join('');
  }

  // Build the Intraday Order-Block SVG Chart inside each Right-Hand Card & Hover Popover (matches screenshot)
  function buildHudChartSvg(card, detail, isBull) {
    const candles = detail?.candles || [];
    const ltp = card.ltp || 100;
    const lvls = computeCardLevels(card, detail);
    const W = 320;
    const H = 94;
    const padL = 6;
    const padR = 46;
    const padT = 8;
    const padB = 8;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Synthesize smooth fallback curve if detail candles are still loading
    let pts = [];
    if (candles.length >= 4) {
      pts = candles.slice(-48);
    } else {
      const startP = card.prev || ltp * (isBull ? 0.985 : 1.015);
      for (let i = 0; i < 28; i++) {
        const t = i / 27;
        const wave = Math.sin(t * Math.PI * 2.5) * (ltp * 0.0022);
        const c = startP + (ltp - startP) * Math.pow(t, 0.85) + wave;
        pts.push([0, c - ltp * 0.001, c + ltp * 0.0018, c - ltp * 0.0018, c, 1000]);
      }
    }

    const lows = pts.map(c => c[3]);
    const highs = pts.map(c => c[2]);
    const minP = Math.min(ltp, lvls.zBot, lvls.s1, ...lows) * 0.9985;
    const maxP = Math.max(ltp, lvls.zTop, lvls.r1, ...highs) * 1.0015;
    const rangeP = Math.max(0.01, maxP - minP);

    const yOf = p => padT + ((maxP - p) / rangeP) * plotH;
    const xOf = i => padL + (i / Math.max(1, pts.length - 1)) * plotW;

    const strokeCol = isBull ? '#19f59e' : '#ff4769';
    const gradId = `grad_${card.symbol.replace(/[^A-Z0-9]/gi, '')}_${isBull ? 'u' : 'd'}_${Math.random().toString(36).slice(2, 6)}`;

    // Subtle background grid
    const svgParts = [
      `<defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${strokeCol}" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="${strokeCol}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>`,
    ];

    for (let g = 1; g <= 3; g++) {
      const gy = padT + (plotH * g) / 4;
      svgParts.push(
        `<line x1="${padL}" x2="${W - padR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="0.6"/>`
      );
    }

    // Order Block Shaded Zone (Z)
    const obY1 = Math.max(padT, Math.min(H - padB, yOf(lvls.zTop)));
    const obY2 = Math.max(padT, Math.min(H - padB, yOf(lvls.zBot)));
    const obH = Math.max(3, Math.abs(obY2 - obY1));
    svgParts.push(
      `<rect x="${padL + plotW * 0.22}" y="${Math.min(obY1, obY2).toFixed(1)}" width="${(plotW * 0.78).toFixed(1)}" height="${obH.toFixed(1)}" fill="${strokeCol}" fill-opacity="0.18" stroke="${strokeCol}" stroke-opacity="0.55" stroke-dasharray="2 2" stroke-width="0.7"/>`
    );

    // Horizontal Volume Profile on right edge
    const prof = detail?.profile || card.profile;
    if (prof && Array.isArray(prof.buy) && prof.buy.length) {
      const totals = prof.buy.map((b, i) => b + (prof.sell?.[i] || 0));
      const maxV = Math.max(1, ...totals);
      for (let i = 0; i < totals.length; i += 2) {
        const priceLvl = prof.lo + (i + 0.5) * prof.step;
        const py = yOf(priceLvl);
        if (py < padT || py > H - padB) continue;
        const bw = (totals[i] / maxV) * (padR - 8);
        svgParts.push(
          `<rect x="${(W - padR + 2).toFixed(1)}" y="${(py - 1.5).toFixed(1)}" width="${bw.toFixed(1)}" height="2.6" fill="${strokeCol}" opacity="0.42"/>`
        );
      }
    }

    // Dashed Support / Resistance / Zone Labels (R2, R1, Z, S1, S2) on right side of plot
    const drawLevelLine = (price, label, col) => {
      const py = yOf(price);
      if (py < padT + 2 || py > H - padB - 2) return;
      svgParts.push(
        `<line x1="${(padL + plotW * 0.52).toFixed(1)}" x2="${(W - 4).toFixed(1)}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${col}" stroke-dasharray="2 2" stroke-width="0.65" opacity="0.75"/>`,
        `<text x="${(padL + plotW * 0.54).toFixed(1)}" y="${(py - 2).toFixed(1)}" fill="${col}" font-size="6.2" font-weight="700">${label}</text>`
      );
    };
    drawLevelLine(lvls.r2, 'R2', '#38bdf8');
    drawLevelLine(lvls.r1, 'R1', '#19f59e');
    drawLevelLine((lvls.zBot + lvls.zTop) / 2, 'Z', '#f5b82e');
    drawLevelLine(lvls.s1, 'S1', '#f5b82e');
    drawLevelLine(lvls.s2, 'S2', '#ff4769');

    // Price Polyline + Area Fill + Mini Wicks
    const coords = pts.map((c, idx) => [xOf(idx), yOf(c[4])]);
    const pathD = coords
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`)
      .join(' ');
    const areaD = `${pathD} L${coords[coords.length - 1][0].toFixed(1)},${(H - padB).toFixed(1)} L${coords[0][0].toFixed(1)},${(H - padB).toFixed(1)} Z`;

    svgParts.push(
      `<path d="${areaD}" fill="url(#${gradId})"/>`,
      `<path d="${pathD}" fill="none" stroke="${strokeCol}" stroke-width="1.45"/>`
    );

    // Glowing Target Reticle on latest LTP point (matches screenshot crosshair)
    const lastPt = coords[coords.length - 1];
    svgParts.push(
      `<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="6.5" fill="none" stroke="#ffffff" stroke-width="0.9" opacity="0.85"/>`,
      `<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2.6" fill="#ffffff"/>`
    );

    // Floating LONG BUILD-UP / SHORT BUILD-UP Callout Box inside Chart (matches screenshot)
    const boxX = padL + 8;
    const boxY = isBull ? padT + 3 : H - 30;
    const buildupTxt = card.buildup || (isBull ? 'LONG BUILD-UP' : 'SHORT BUILD-UP');
    const flowStr = `${card.rupeeFlowCr >= 0 ? '+' : ''}${card.rupeeFlowCr.toFixed(1)}Cr`;
    svgParts.push(
      `<g transform="translate(${boxX}, ${boxY})">
        <rect x="0" y="0" width="96" height="22" rx="3" fill="rgba(3,9,12,0.86)" stroke="${strokeCol}" stroke-opacity="0.65" stroke-width="0.8"/>
        <text x="5" y="9" fill="#ffffff" font-size="6.4" font-weight="800">${escapeHtml(buildupTxt)}</text>
        <text x="5" y="18" fill="#94b8a8" font-size="5.8">OI ${card.agree}/${card.totalChecks} · Δ ${escapeHtml(flowStr)}</text>
      </g>`
    );

    return `<svg class="hcc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svgParts.join('')}</svg>`;
  }

  // Build HTML for one Right-Hand Live Order-Block Chart Card
  function buildRightChartCardHtml(card, slotIdx, isBull, isHoveredTarget) {
    const detail = detailCache.get(card.symbol);
    const lvls = computeCardLevels(card, detail);
    const isTopCard = slotIdx === 0;

    return `
      <article class="hud-chart-card ${isBull ? 'bull' : 'bear'} ${isHoveredTarget ? 'is-active-hover' : ''}"
               data-symbol="${escapeHtml(card.symbol)}"
               data-side="${isBull ? 'BULL' : 'BEAR'}">
        <div class="hcc-main">
          <div class="hcc-info">
            <div>
              <div class="hcc-sym-row">
                <span class="hcc-rank-dot ${isBull ? 'bull' : 'bear'}"></span>
                <span class="hcc-sym">${escapeHtml(card.symbol)}</span>
              </div>
              <div class="hcc-name">${escapeHtml(card.name || card.sector || '')}</div>
            </div>

            <div class="hcc-side-row">
              <span class="hcc-side-pill ${isBull ? 'bull' : 'bear'}">${isBull ? 'BULLISH' : 'BEARISH'}</span>
              <span class="hcc-radar-ring ${isBull ? 'bull' : 'bear'}"><span class="hcc-radar-core"></span></span>
            </div>

            <div class="hcc-price-line">
              <span class="hcc-ltp">₹${fmtNum(card.ltp)}</span>
              <span class="hcc-chg ${isBull ? 'up' : 'dn'}">${fmtPct(card.chgPct)}</span>
            </div>

            <div class="hcc-quick-btns">
              <a href="/app/journal?symbol=${encodeURIComponent(card.symbol)}&amp;action=new" class="hcc-qbtn" title="Log ${escapeHtml(card.symbol)} in your Investment Booklet">💼 Booklet</a>
              <button type="button" class="hcc-qbtn" data-action="track" data-symbol="${escapeHtml(card.symbol)}" data-side="${isBull ? 'BULL' : 'BEAR'}">📌 Track</button>
              <button type="button" class="hcc-qbtn" data-action="remind" data-symbol="${escapeHtml(card.symbol)}">⏰ +15m</button>
            </div>
          </div>

          <div class="hcc-chart-wrap">
            ${buildHudChartSvg(card, detail, isBull)}
          </div>
        </div>

        <div class="hcc-footer">
          ${
            isTopCard
              ? `<div class="hcc-levels-grid">
                   <div class="hcc-lvl-cell">
                     <span class="hcc-lvl-lbl">${isBull ? 'SUPPORT' : 'RESISTANCE'}</span>
                     <span class="hcc-lvl-val gold">${fmtNum(isBull ? lvls.s1 : lvls.r1)}</span>
                   </div>
                   <div class="hcc-lvl-cell">
                     <span class="hcc-lvl-lbl">ZONE</span>
                     <span class="hcc-lvl-val">${fmtNum(lvls.zBot, 1)}–${fmtNum(lvls.zTop, 1)}</span>
                   </div>
                   <div class="hcc-lvl-cell">
                     <span class="hcc-lvl-lbl">${isBull ? 'RESISTANCE' : 'SUPPORT'}</span>
                     <span class="hcc-lvl-val ${isBull ? 'up' : 'dn'}">${fmtNum(isBull ? lvls.r1 : lvls.s1)}</span>
                   </div>
                   <div class="hcc-lvl-cell">
                     <span class="hcc-lvl-lbl">${isBull ? 'RESISTANCE 2' : 'SUPPORT 2'}</span>
                     <span class="hcc-lvl-val ${isBull ? 'up' : 'dn'}">${fmtNum(isBull ? lvls.r2 : lvls.s2)}</span>
                   </div>
                   <div class="hcc-lvl-cell">
                     <span class="hcc-lvl-lbl">RISK / R:R</span>
                     <span class="hcc-lvl-val">${lvls.riskPct} · ${lvls.rr}</span>
                   </div>
                 </div>
                 <div class="hcc-range-track">
                   <div class="hcc-range-fill ${isBull ? 'bull' : 'bear'}" style="width:${lvls.posPct.toFixed(0)}%"></div>
                   <div class="hcc-range-thumb" style="left:${lvls.posPct.toFixed(0)}%"></div>
                 </div>`
              : `<div class="hcc-levels-grid">
                   <div class="hcc-lvl-cell"><span class="hcc-lvl-lbl">Z</span><span class="hcc-lvl-val">${fmtNum(lvls.zBot, 1)}–${fmtNum(lvls.zTop, 1)}</span></div>
                   <div class="hcc-lvl-cell"><span class="hcc-lvl-lbl">${isBull ? 'S1' : 'R1'}</span><span class="hcc-lvl-val gold">${fmtNum(isBull ? lvls.s1 : lvls.r1)}</span></div>
                   <div class="hcc-lvl-cell"><span class="hcc-lvl-lbl">${isBull ? 'R1' : 'S1'}</span><span class="hcc-lvl-val ${isBull ? 'up' : 'dn'}">${fmtNum(isBull ? lvls.r1 : lvls.s1)}</span></div>
                   <div class="hcc-lvl-cell"><span class="hcc-lvl-lbl">${isBull ? 'R2' : 'S2'}</span><span class="hcc-lvl-val ${isBull ? 'up' : 'dn'}">${fmtNum(isBull ? lvls.r2 : lvls.s2)}</span></div>
                   <div class="hcc-lvl-cell"><span class="hcc-lvl-lbl">R:R</span><span class="hcc-lvl-val">${lvls.rr}</span></div>
                 </div>`
          }
        </div>
      </article>
    `;
  }

  // Render the Sticky Live Chart Inspector Dock beside the All-218-Stocks Screener
  function renderStickyInspector(activeCard) {
    if (!els.stickyInspectorBody || !activeCard) return;
    const isBull = activeCard.side !== 'BEAR';
    const obMeta = getCardOrderBlockMeta(activeCard);
    els.stickyInspectorBody.innerHTML = `
      ${buildRightChartCardHtml(activeCard, 0, isBull, true)}
      <div style="margin-top:0.45rem;padding:0.45rem 0.55rem;border-radius:6px;background:rgba(0,0,0,0.45);border:1px solid rgba(148,184,168,0.16);font-size:0.64rem;display:flex;flex-direction:column;gap:0.26rem;">
        <div style="display:flex;justify-content:space-between;">
          <span style="color:var(--text-mid)">Sector &amp; Rank:</span>
          <strong>#${activeCard.rank} · ${escapeHtml(activeCard.sector || 'NSE F&O')}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span style="color:var(--text-mid)">Flow Score &amp; Checks:</span>
          <strong style="color:${isBull ? 'var(--up)' : 'var(--dn)'}">${activeCard.strengthScore}/100 · ${activeCard.agree}/${activeCard.totalChecks} ${activeCard.side} (Buy ${Math.round(activeCard.buyPct ?? 50)}%)</strong>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span style="color:var(--text-mid)">Order Block Impulse:</span>
          <strong style="color:var(--gold)">${obMeta.str ? `${obMeta.str.toFixed(2)}× Impulse` : 'Volume Zone'} · ${obMeta.distPct < 90 ? `${obMeta.distPct.toFixed(2)}% away` : '—'}</strong>
        </div>
        <div style="display:flex;gap:0.35rem;margin-top:0.25rem;">
          <a href="/app/journal?symbol=${encodeURIComponent(activeCard.symbol)}&amp;action=new" class="hud-mini-btn gold-btn" style="flex:1;text-align:center;">💼 Log in Journal Booklet</a>
          <button type="button" class="hud-mini-btn accent hcc-qbtn" data-action="track" data-symbol="${escapeHtml(activeCard.symbol)}" data-side="${isBull ? 'BULL' : 'BEAR'}" style="flex:1;">📌 Add to Tracker</button>
        </div>
      </div>
    `;
  }

  // Render the Right-Hand Chart Cards (3 Bull + 3 Bear in Split Mode, OR 6 Bullish / 6 Bearish in Full-Screen Side Mode!)
  function renderRightChartStacks() {
    if (!appState) return;
    const universe = appState.universe || [];
    const isBullOnly = filterMode === 'BULL';
    const isBearOnly = filterMode === 'BEAR';
    const bullSlotCount = isBullOnly ? 6 : 3;
    const bearSlotCount = isBearOnly ? 6 : 3;

    let activeSym = lockedSymbol || hoveredSymbol;
    let activeCard = activeSym ? getStockCardFromUniverse(activeSym) : universe[0] || null;
    if (isBullOnly && activeCard && activeCard.side === 'BEAR') {
      activeCard = currentBullStreamStocks[0] || universe.find(s => s.side === 'BULL') || activeCard;
    } else if (isBearOnly && activeCard && activeCard.side !== 'BEAR') {
      activeCard = currentBearStreamStocks[0] || universe.find(s => s.side === 'BEAR') || activeCard;
    }

    // Keep both bullCards and bearCards populated so the off-side stack smoothly slides down/up
    const sortedBothSides = getFilteredAndSortedStocks(universe, { ignoreSidePill: true });
    let bullCards = (sortedBothSides.filter(s => s.side === 'BULL').length >= bullSlotCount
      ? sortedBothSides.filter(s => s.side === 'BULL')
      : universe.filter(s => s.side === 'BULL')
    ).slice(0, bullSlotCount);
    let bearCards = (sortedBothSides.filter(s => s.side === 'BEAR').length >= bearSlotCount
      ? sortedBothSides.filter(s => s.side === 'BEAR')
      : universe.filter(s => s.side === 'BEAR')
    ).slice(0, bearSlotCount);

    if (activeCard) {
      if (activeCard.side !== 'BEAR') {
        bullCards = [activeCard, ...bullCards.filter(c => c.symbol !== activeCard.symbol)].slice(0, bullSlotCount);
      } else {
        bearCards = [activeCard, ...bearCards.filter(c => c.symbol !== activeCard.symbol)].slice(0, bearSlotCount);
      }
    }

    // Kick off background detail fetch for visible chart cards
    const visibleCards = isBullOnly ? bullCards : isBearOnly ? bearCards : [...bullCards, ...bearCards];
    for (const c of visibleCards) {
      if (!detailCache.has(c.symbol)) {
        ensureStockDetail(c.symbol).then(() => {
          renderIntradayWave(appState?.universe || []);
          renderRightChartStacks();
        });
      }
    }

    els.bullChartsStack.innerHTML = bullCards
      .map((c, idx) =>
        buildRightChartCardHtml(c, idx, true, Boolean(activeCard && activeCard.symbol === c.symbol))
      )
      .join('');

    els.bearChartsStack.innerHTML = bearCards
      .map((c, idx) =>
        buildRightChartCardHtml(c, idx, false, Boolean(activeCard && activeCard.symbol === c.symbol))
      )
      .join('');

    renderStickyInspector(activeCard);
    updateHoverPopover(activeCard);
    drawStageConnectorOverlay(activeCard);
  }

  // Render All-218-Stocks Real-Time Order-Block & Flow Screener (Table + Tile Grid + Counts + Sectors)
  function renderAll218Screener(universe = [], sectors = []) {
    if (!els.screenerTableBody) return;
    const trackerSet = new Set((appState?.tracker || []).map(t => t.symbol));
    const journalSet = new Set((appState?.journal || []).map(j => j.symbol));
    const orderedSectors = getOrderedSectors(sectors, universe);

    // Populate sector select dropdown while preserving current selection
    if (els.sectorSelect && orderedSectors.length) {
      const currentVal = selectedSector;
      const opts = [
        `<option value="ALL">All Sectors (${universe.length})</option>`,
        ...orderedSectors.map(
          sec =>
            `<option value="${escapeHtml(sec.sector)}" ${sec.sector === currentVal ? 'selected' : ''}>${escapeHtml(sec.sector)} (${sec.stocksCount} · ${sec.flowCr >= 0 ? '+' : ''}${sec.flowCr.toFixed(0)}Cr · ${sec.avgChgPct >= 0 ? '+' : ''}${sec.avgChgPct.toFixed(1)}%)</option>`
        ),
      ];
      els.sectorSelect.innerHTML = opts.join('');
    }

    // Update filter badge counts (All, Bullish, Bearish)
    if (els.countAllBadge) els.countAllBadge.textContent = String(universe.length);
    if (els.countBullBadge) {
      els.countBullBadge.textContent = String(universe.filter(s => s.side === 'BULL').length);
    }
    if (els.countBearBadge) {
      els.countBearBadge.textContent = String(universe.filter(s => s.side === 'BEAR').length);
    }

    const filtered = getFilteredAndSortedStocks(universe);
    if (els.screenerResultCount) {
      els.screenerResultCount.textContent = `${filtered.length} of ${universe.length} stocks`;
    }

    const activeSec = selectedSector !== 'ALL' ? selectedSector : hoveredSector;
    if (els.screenerFilterSummary) {
      const modeLabel =
        filterMode === 'BULL' ? '🟢 Bullish Only' : filterMode === 'BEAR' ? '🔴 Bearish Only' : 'All Stocks';
      const sortLabel =
        sortOrder === 'OB_STRENGTH' ? '🧱 Strongest Order Block' : '⚡ Strongest Flow';
      const parts = [
        `Sector: ${activeSec || 'All 22 Sectors'}`,
        `View: ${modeLabel}`,
        `Sort: ${sortLabel}`,
      ];
      if (searchQuery) parts.push(`Search: "${searchQuery}"`);
      els.screenerFilterSummary.textContent = `${parts.join(' · ')} — Hover any stock to inspect its live 3-minute Order-Block chart`;
    }

    const activeSym = lockedSymbol || hoveredSymbol;

    // 1. Table Rows
    els.screenerTableBody.innerHTML = filtered
      .map((card, i) => {
        const isBull = card.side !== 'BEAR';
        const detail = detailCache.get(card.symbol);
        const lvls = computeCardLevels(card, detail);
        const obMeta = getCardOrderBlockMeta(card);
        const inBooklet = journalSet.has(card.symbol);
        const inTracker = trackerSet.has(card.symbol);
        const isHov = activeSym === card.symbol;

        const obText = lvls.hasRealOB
          ? `${isBull ? 'Bull' : 'Bear'} OB ₹${fmtNum(lvls.zBot, 1)}–₹${fmtNum(lvls.zTop, 1)}`
          : `Zone ₹${fmtNum(lvls.zBot, 1)}–₹${fmtNum(lvls.zTop, 1)}`;

        const distText =
          obMeta.distPct <= 0.12
            ? '⚡ IN ZONE'
            : obMeta.distPct < 90
            ? `${obMeta.distPct.toFixed(2)}%`
            : '—';

        return `
          <tr class="ob-screener-row ${isBull ? 'bull-row' : 'bear-row'} ${isHov ? 'is-hovered' : ''}"
              data-symbol="${escapeHtml(card.symbol)}">
            <th scope="row">
              <div class="sc-sym-wrap">
                <div class="sc-sym-top">
                  <span class="sc-rank">#${i + 1}</span>
                  <span class="sc-sym">${escapeHtml(card.symbol)}</span>
                  ${inBooklet ? '<span class="sc-booklet-tag" title="In your Investment Booklet">📖 Booklet</span>' : ''}
                  ${inTracker ? '<span class="sc-booklet-tag" title="In your Stock Tracker">📌 Tracked</span>' : ''}
                </div>
                <span class="sc-sec">${escapeHtml(card.sector || 'NSE F&O')}</span>
              </div>
            </th>
            <td class="num">
              <div><strong>₹${fmtNum(card.ltp)}</strong></div>
              <div style="color:${isBull ? 'var(--up)' : 'var(--dn)'};font-weight:700">${fmtPct(card.chgPct)}</div>
            </td>
            <td>
              <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <span class="sc-badge ${isBull ? 'bull' : 'bear'}">${card.agree}/${card.totalChecks} ${card.side}</span>
                <span style="font-size:0.6rem;color:var(--text-mid)">Score ${card.strengthScore}</span>
              </div>
              <div style="font-size:0.58rem;color:var(--text-hi);margin-top:2px;">${escapeHtml(card.buildup || (isBull ? 'LONG BUILD-UP' : 'SHORT BUILD-UP'))}</div>
            </td>
            <td class="num">
              <div style="color:${isBull ? 'var(--up)' : 'var(--dn)'};font-weight:700">Buy ${Math.round(card.buyPct ?? 50)}%</div>
              <div style="font-size:0.6rem;color:var(--text-mid)">${card.rupeeFlowCr >= 0 ? '+' : ''}${card.rupeeFlowCr.toFixed(1)} Cr</div>
            </td>
            <td>
              <div style="font-weight:700;color:${isBull ? 'var(--up)' : 'var(--dn)'}">${obText}</div>
              <div style="font-size:0.56rem;color:var(--text-mid)">${escapeHtml(card.referencePlan?.action || (isBull ? 'BUY Pullback OB' : 'SELL Rally OB'))}</div>
            </td>
            <td class="num">
              ${
                obMeta.str > 0
                  ? `<span class="sc-badge ${obMeta.str >= 1.8 ? 'gold' : isBull ? 'bull' : 'bear'}">${obMeta.str.toFixed(2)}×</span>`
                  : '<span style="color:var(--text-lo)">1.0×</span>'
              }
            </td>
            <td class="num">
              <span class="sc-badge ${obMeta.distPct <= 0.25 ? 'gold' : isBull ? 'bull' : 'bear'}">${distText}</span>
            </td>
            <td class="num" style="font-size:0.6rem;">
              <div>S1: <span style="color:var(--gold)">₹${fmtNum(lvls.s1, 0)}</span> · R1: <span style="color:var(--up)">₹${fmtNum(lvls.r1, 0)}</span></div>
              <div style="color:var(--text-mid)">Risk ${lvls.riskPct} · ${lvls.rr}</div>
            </td>
            <td>
              <div class="sc-actions">
                <a href="/app/journal?symbol=${encodeURIComponent(card.symbol)}&amp;action=new" class="sc-act-btn booklet-btn" title="Log ${escapeHtml(card.symbol)} in Journal Booklet">💼 Booklet</a>
                <button type="button" class="sc-act-btn hcc-qbtn" data-action="track" data-symbol="${escapeHtml(card.symbol)}" data-side="${isBull ? 'BULL' : 'BEAR'}">📌 Track</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    // 2. Tile Grid View for All 218 Stocks
    if (els.screenerGridContainer) {
      els.screenerGridContainer.innerHTML = filtered
        .map((card, i) => {
          const isBull = card.side !== 'BEAR';
          const detail = detailCache.get(card.symbol);
          const lvls = computeCardLevels(card, detail);
          const obMeta = getCardOrderBlockMeta(card);
          const isHov = activeSym === card.symbol;
          return `
            <article class="m-tile ${isBull ? 'bull' : 'bear'} col-3 ${isHov ? 'is-hovered' : ''}"
                     data-symbol="${escapeHtml(card.symbol)}"
                     data-side="${isBull ? 'BULL' : 'BEAR'}">
              <div class="mt-head">
                <span class="mt-sym">#${i + 1} ${escapeHtml(card.symbol)}</span>
                <span class="mt-chg ${isBull ? 'up' : 'dn'}">${fmtPct(card.chgPct)}</span>
              </div>
              <div class="mt-price-row">
                <span>₹${fmtNum(card.ltp, 1)}</span>
                <span>Buy ${Math.round(card.buyPct ?? 50)}% · ${escapeHtml(card.sector)}</span>
              </div>
              <div class="mt-buildup-row">
                <span class="mt-buildup-tag">${escapeHtml(card.buildup || card.side)}</span>
                <span class="mt-stars ${isBull ? 'up' : 'dn'}">${obMeta.str ? `${obMeta.str.toFixed(1)}× OB` : `${card.agree}/5`}</span>
              </div>
              <div class="mt-foot">
                <span class="mt-ob-chip ${obMeta.distPct <= 0.25 ? 'in-zone' : ''}">OB ₹${fmtNum(lvls.zBot, 0)}–${fmtNum(lvls.zTop, 0)}</span>
                <a href="/app/journal?symbol=${encodeURIComponent(card.symbol)}&amp;action=new" class="sc-act-btn booklet-btn" style="padding:1px 4px;font-size:0.52rem;">💼 Booklet</a>
              </div>
            </article>
          `;
        })
        .join('');
    }
  }

  // Floating Hover Live Chart Magnifier next to cursor when hovering Left Stream or Middle Matrix
  function updateHoverPopover(activeCard) {
    if (
      !showHoverPopup ||
      !activeCard ||
      lastPointer.zone === 'charts' ||
      lastPointer.zone === 'screener' ||
      lastPointer.zone === 'none'
    ) {
      els.hoverChartPopover.classList.add('hidden');
      return;
    }

    const isBull = activeCard.side !== 'BEAR';
    els.hoverChartPopover.className = `hover-chart-popover ${isBull ? 'bull' : 'bear'}`;
    els.hoverChartPopover.innerHTML = buildRightChartCardHtml(activeCard, 0, isBull, true);

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popW = 470;
    const popH = 235;
    let left = lastPointer.x + 22;
    let top = lastPointer.y - popH / 2;
    if (left + popW > vw - 16) left = Math.max(16, lastPointer.x - popW - 22);
    if (top < 54) top = 54;
    if (top + popH > vh - 16) top = vh - popH - 16;

    els.hoverChartPopover.style.left = `${Math.round(left)}px`;
    els.hoverChartPopover.style.top = `${Math.round(top)}px`;
  }

  // Draw glowing neural Bezier connector line from hovered Matrix Tile to Right-Hand Live Chart Card
  function drawStageConnectorOverlay(activeCard) {
    if (!els.stageOverlaySvg) return;
    if (!activeCard) {
      els.stageOverlaySvg.innerHTML = '';
      return;
    }
    const stageEl = document.getElementById('obStage');
    if (!stageEl) return;
    const stageRect = stageEl.getBoundingClientRect();
    const tileEl = document.querySelector(`#obStage .m-tile[data-symbol="${CSS.escape(activeCard.symbol)}"]`);
    const chartEl = document.querySelector(
      `#obStage .hud-chart-card[data-symbol="${CSS.escape(activeCard.symbol)}"]`
    );
    if (!tileEl || !chartEl) {
      els.stageOverlaySvg.innerHTML = '';
      return;
    }

    const tRect = tileEl.getBoundingClientRect();
    const cRect = chartEl.getBoundingClientRect();
    if (tRect.height < 8 || cRect.height < 8) {
      els.stageOverlaySvg.innerHTML = '';
      return;
    }
    const x1 = tRect.right - stageRect.left;
    const y1 = tRect.top + tRect.height / 2 - stageRect.top;
    const x2 = cRect.left - stageRect.left;
    const y2 = cRect.top + cRect.height / 2 - stageRect.top;
    const cx1 = x1 + (x2 - x1) * 0.45;
    const cx2 = x1 + (x2 - x1) * 0.55;
    const col = activeCard.side === 'BEAR' ? '#ff4769' : '#19f59e';

    els.stageOverlaySvg.innerHTML = `
      <path d="M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}"
            fill="none" stroke="${col}" stroke-width="2.2" stroke-opacity="0.85"/>
      <circle cx="${x1}" cy="${y1}" r="4" fill="#ffffff" stroke="${col}" stroke-width="2"/>
      <circle cx="${x2}" cy="${y2}" r="4" fill="#ffffff" stroke="${col}" stroke-width="2"/>
    `;
  }

  // Trigger Live Chart inspection on hover over ANY stock or sector
  function setHoveredStock(symbol, zone = 'matrix') {
    if (!symbol) return;
    const sym = symbol.toUpperCase();
    lastPointer.zone = zone;
    if (hoveredSymbol === sym && detailCache.has(sym)) {
      updateHoverPopover(getStockCardFromUniverse(sym));
      return;
    }
    hoveredSymbol = sym;
    const card = getStockCardFromUniverse(sym);
    if (card && els.hoverBanner && els.hoverText) {
      const pip = els.hoverBanner.querySelector('.pulse-pip');
      if (pip) pip.className = `pulse-pip ${card.side === 'BEAR' ? 'dn' : 'up'}`;
      const obMeta = getCardOrderBlockMeta(card);
      els.hoverText.textContent = `${lockedSymbol ? '🔒 PINNED' : '⚡ LIVE HOVER'}: ${card.symbol} (₹${fmtNum(card.ltp)} · ${fmtPct(card.chgPct)}) — ${card.buildup || card.side} · ${card.agree}/${card.totalChecks} Flow${obMeta.str ? ` · OB ${obMeta.str.toFixed(1)}×` : ''}`;
    }

    document
      .querySelectorAll('.m-tile.is-hovered, .ob-screener-row.is-hovered')
      .forEach(el => el.classList.remove('is-hovered'));
    document
      .querySelectorAll(`[data-symbol="${CSS.escape(sym)}"]`)
      .forEach(el => el.classList.add('is-hovered'));

    renderIntradayWave(appState?.universe || []);
    renderRightChartStacks();
    ensureStockDetail(sym).then(() => {
      if ((lockedSymbol || hoveredSymbol) === sym) {
        renderIntradayWave(appState?.universe || []);
        renderRightChartStacks();
        renderStockMatrices(appState?.universe || []);
      }
    });
  }

  function refreshFilteredViews() {
    if (!appState) return;
    renderIntradayWave(appState.universe || []);
    renderSectorStacks(appState.sectors || [], appState.universe || []);
    renderStockMatrices(appState.universe || []);
    renderAll218Screener(appState.universe || [], appState.sectors || []);
    renderRightChartStacks();
  }

  function renderAll(state) {
    appState = state;
    const total = state.orderflowMeta?.totalStocks || (state.universe || []).length;
    if (els.syncMeta) {
      els.syncMeta.textContent = `● ${state.sourceMode === 'LIVE' ? 'LIVE' : 'SESSION'} · ${total} F&O`;
    }

    // Pre-seed initial hoveredSymbol with #1 Bullish stock if none active yet
    if (!hoveredSymbol && state.topBull?.length) {
      hoveredSymbol = state.topBull[0].symbol;
    }

    refreshFilteredViews();
  }

  // ============================================================================
  // High-DPI Chart-Flow Driven Order-Flow Sankey & Particle Stream Canvas (#flowStreamCanvas)
  // Smoothly shifts Bearish down off screen when clicking Bullish (and vice versa)
  // ============================================================================
  let canvasW = 420;
  let canvasH = 680;
  const particles = [];
  for (let i = 0; i < 144; i++) {
    particles.push({
      bull: i < 72,
      lane: i % 24,
      t: Math.random(),
      baseSpeed: 0.0018 + (i % 9) * 0.00028,
      amp: ((i % 7) - 3) * 2.4,
    });
  }

  function resizeStreamCanvas() {
    if (!els.flowCanvas || !els.streamBody) return;
    const rect = els.streamBody.getBoundingClientRect();
    canvasW = Math.max(240, Math.floor(rect.width));
    canvasH = Math.max(280, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    els.flowCanvas.width = canvasW * dpr;
    els.flowCanvas.height = canvasH * dpr;
    const ctx = els.flowCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeStreamCanvas);

  // Extract normalized chart-flow curve inflection from a stock's 3m candles or order-flow telemetry
  function getStockChartFlowMetrics(stock, isBull) {
    if (!stock) {
      return {
        scoreNorm: 0.6,
        pressureNorm: 0.6,
        obNorm: 0.45,
        midInfl: 0,
        endSlope: 0,
        flowWeight: 0.6,
      };
    }
    const scoreNorm = Math.max(0.22, Math.min(1, (stock.strengthScore || 60) / 100));
    const buyPct = Number(stock.buyPct ?? (isBull ? 62 : 38));
    const pressureNorm = isBull
      ? Math.max(0.25, Math.min(1, buyPct / 100))
      : Math.max(0.25, Math.min(1, (100 - buyPct) / 100));
    const obStr = Number(getCardOrderBlockMeta(stock).str || 1.0);
    const obNorm = Math.max(0.2, Math.min(1, obStr / 2.8));

    let midInfl = Math.max(-1, Math.min(1, (stock.chgPct || 0) / 4.5));
    let endSlope = Math.max(-1, Math.min(1, (stock.rupeeFlowCr || 0) / 250));

    const detail = detailCache.get(stock.symbol);
    const candles = detail?.candles;
    if (Array.isArray(candles) && candles.length >= 8) {
      const firstC = Number(candles[0][4] || stock.ltp || 1);
      const midC = Number(candles[Math.floor(candles.length * 0.5)][4] || firstC);
      const preEndC = Number(candles[Math.floor(candles.length * 0.78)][4] || midC);
      const lastC = Number(candles[candles.length - 1][4] || stock.ltp || 1);
      const span = Math.max(firstC * 0.004, Math.abs(lastC - firstC), 0.01);
      midInfl = Math.max(-1.2, Math.min(1.2, (midC - (firstC + lastC) * 0.5) / span));
      endSlope = Math.max(-1.2, Math.min(1.2, (lastC - preEndC) / span));
    }

    const flowWeight = Math.max(0.25, Math.min(1, scoreNorm * 0.5 + pressureNorm * 0.3 + obNorm * 0.2));
    return { scoreNorm, pressureNorm, obNorm, midInfl, endSlope, flowWeight };
  }

  function renderStreamFrame(nowMs) {
    const ctx = els.flowCanvas?.getContext('2d');
    if (ctx && canvasW > 0 && canvasH > 0) {
      ctx.clearRect(0, 0, canvasW, canvasH);

      // Smoothly interpolate currentSplitRatio toward targetSplitRatio (0.5 = All, 1.0 = Bullish Full, 0.0 = Bearish Full)
      const diff = targetSplitRatio - currentSplitRatio;
      if (Math.abs(diff) > 0.0008) {
        currentSplitRatio += diff * 0.105;
        if (Math.abs(diff) > 0.005) {
          const activeSym = lockedSymbol || hoveredSymbol;
          if (activeSym) drawStageConnectorOverlay(getStockCardFromUniverse(activeSym));
        }
      } else {
        currentSplitRatio = targetSplitRatio;
      }

      const topBound = 14;
      const botBound = canvasH - 14;
      const totalSpan = Math.max(100, botBound - topBound);
      const midY = topBound + totalSpan * currentSplitRatio;
      const bullRegionH = Math.max(0, midY - topBound);
      const bearRegionH = Math.max(0, botBound - midY);

      const originX = 7;
      const spineX = canvasW * 0.69;
      const rightEdgeX = canvasW;

      const activeSym = lockedSymbol || hoveredSymbol;
      const activeDetail = activeSym ? detailCache.get(activeSym) : null;
      const activeProfile = activeDetail?.profile;

      const bullPool = currentBullStreamStocks.length
        ? currentBullStreamStocks
        : (appState?.universe || []).filter(s => s.side === 'BULL').slice(0, 24);
      const bearPool = currentBearStreamStocks.length
        ? currentBearStreamStocks
        : (appState?.universe || []).filter(s => s.side === 'BEAR').slice(0, 24);

      // 1. Central Vertical Volume Profile Spine driven by real Chart Volume Profile + Stock Order Flow
      const barsN = 86;
      const barStepY = totalSpan / barsN;
      let maxBuyProf = 1;
      let maxSellProf = 1;
      if (activeProfile && Array.isArray(activeProfile.buy) && activeProfile.buy.length) {
        maxBuyProf = Math.max(1, ...activeProfile.buy);
        maxSellProf = Math.max(1, ...(activeProfile.sell || activeProfile.buy));
      }

      for (let i = 0; i < barsN; i++) {
        const y = topBound + i * barStepY;
        const isTop = y <= midY;
        if (isTop && bullRegionH < 4) continue;
        if (!isTop && bearRegionH < 4) continue;

        const localFrac = isTop
          ? (y - topBound) / Math.max(1, bullRegionH)
          : (y - midY) / Math.max(1, bearRegionH);

        const pool = isTop ? bullPool : bearPool;
        const st = pool[Math.min(pool.length - 1, Math.floor(localFrac * Math.max(1, pool.length)))];
        const m = getStockChartFlowMetrics(st, isTop);

        let profRatio = m.flowWeight;
        if (activeProfile && Array.isArray(activeProfile.buy) && activeProfile.buy.length) {
          const pIdx = Math.min(
            activeProfile.buy.length - 1,
            Math.floor((1 - localFrac) * activeProfile.buy.length)
          );
          const rawP = isTop
            ? (activeProfile.buy[pIdx] || 0) / maxBuyProf
            : ((activeProfile.sell || activeProfile.buy)[pIdx] || 0) / maxSellProf;
          profRatio = rawP * 0.62 + m.flowWeight * 0.38;
        }

        const edgeBell = isTop
          ? localFrac < 0.35
            ? 1.25
            : 0.72 + (1 - localFrac) * 0.35
          : localFrac > 0.65
          ? 1.25
          : 0.72 + localFrac * 0.35;

        const len = Math.max(6, (10 + profRatio * 34) * edgeBell);
        const alpha = Math.min(0.68, 0.22 + profRatio * 0.42);
        ctx.fillStyle = isTop
          ? `rgba(25, 245, 158, ${alpha.toFixed(2)})`
          : `rgba(255, 71, 105, ${alpha.toFixed(2)})`;
        ctx.fillRect(spineX - len * 0.65, y, len, 2.2);
      }

      // Vertical spine core line
      ctx.strokeStyle = 'rgba(226, 241, 255, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spineX, topBound);
      ctx.lineTo(spineX, botBound);
      ctx.stroke();

      // 2. Helper to draw Chart-Flow Strands for Bullish (topBound..midY) and Bearish (midY..botBound)
      let highlightedStrandMeta = null;

      const drawRegionStrands = (isBull, regionStartY, regionH, pool) => {
        if (regionH < 6 || !pool.length) return;
        const regionRatio = regionH / totalSpan;
        const maxLanes = Math.min(32, Math.max(8, Math.round(32 * regionRatio)));
        const lanesCount = Math.min(maxLanes, Math.max(pool.length, 12));
        const matrixRows = regionRatio > 0.72 ? 8 : 4;

        for (let l = 0; l < lanesCount; l++) {
          const stock = pool[l % pool.length];
          const m = getStockChartFlowMetrics(stock, isBull);
          const frac = (l + 0.5) / lanesCount;
          const pad = Math.min(10, regionH * 0.06);
          const targetSpineY = regionStartY + pad + frac * Math.max(2, regionH - pad * 2);

          // Control points shaped by the stock's actual intraday chart trajectory (midInfl & endSlope)
          const cp1x = originX + (spineX - originX) * 0.34;
          const baseCp1y = isBull
            ? midY - (midY - targetSpineY) * (0.78 + m.pressureNorm * 0.16)
            : midY + (targetSpineY - midY) * (0.78 + m.pressureNorm * 0.16);
          const cp1y = baseCp1y - m.midInfl * 14 * regionRatio;

          const cp2x = originX + (spineX - originX) * 0.68;
          const waveOffset = Math.sin(l * 0.85 + nowMs * (0.0009 + m.flowWeight * 0.0008)) * (4 + m.obNorm * 5);
          const cp2y = targetSpineY - m.endSlope * 10 * regionRatio + waveOffset;

          const isActiveStock = Boolean(activeSym && stock && stock.symbol === activeSym && l < pool.length);
          const alpha = Math.min(0.55, (0.12 + m.flowWeight * 0.28) * Math.min(1, regionRatio * 1.8));
          ctx.strokeStyle = isBull
            ? `rgba(25, 245, 158, ${alpha.toFixed(2)})`
            : `rgba(255, 71, 105, ${alpha.toFixed(2)})`;
          ctx.lineWidth = 0.65 + m.flowWeight * 1.15;

          ctx.beginPath();
          ctx.moveTo(originX, midY);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, spineX, targetSpineY);
          ctx.stroke();

          // Spine to Right Matrix rows fan-out curve
          const rowIdx = Math.floor(l / 4) % matrixRows;
          const rowTargetY = regionStartY + ((rowIdx + 0.5) / matrixRows) * regionH;
          const rcp1x = spineX + (rightEdgeX - spineX) * 0.42;
          const rcp2x = spineX + (rightEdgeX - spineX) * 0.68;

          ctx.strokeStyle = isBull
            ? `rgba(25, 245, 158, ${(alpha * 0.88).toFixed(2)})`
            : `rgba(255, 71, 105, ${(alpha * 0.88).toFixed(2)})`;
          ctx.lineWidth = 0.6 + m.flowWeight * 0.75;
          ctx.beginPath();
          ctx.moveTo(spineX, targetSpineY);
          ctx.bezierCurveTo(rcp1x, targetSpineY, rcp2x, rowTargetY, rightEdgeX, rowTargetY);
          ctx.stroke();

          if (isActiveStock && !highlightedStrandMeta) {
            highlightedStrandMeta = {
              stock,
              isBull,
              cp1x,
              cp1y,
              cp2x,
              cp2y,
              targetSpineY,
              rcp1x,
              rcp2x,
              rowTargetY,
            };
          }
        }
      };

      // Draw both Bullish and Bearish regions continuously so shifting midY animates both smoothly!
      drawRegionStrands(true, topBound, bullRegionH, bullPool);
      drawRegionStrands(false, midY, bearRegionH, bearPool);

      // 3. Highlight the Active Hovered/Pinned Stock's Chart Flow Beam on Canvas
      if (highlightedStrandMeta) {
        const h = highlightedStrandMeta;
        const col = h.isBull ? '#19f59e' : '#ff4769';
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.6;
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;

        ctx.beginPath();
        ctx.moveTo(originX, midY);
        ctx.bezierCurveTo(h.cp1x, h.cp1y, h.cp2x, h.cp2y, spineX, h.targetSpineY);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(spineX, h.targetSpineY);
        ctx.bezierCurveTo(h.rcp1x, h.targetSpineY, h.rcp2x, h.rowTargetY, rightEdgeX, h.rowTargetY);
        ctx.stroke();

        // Glowing node + stock flow callout tag on the spine
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(spineX, h.targetSpineY, 3.6, 0, Math.PI * 2);
        ctx.fill();

        const label = `${h.stock.symbol} · Buy ${Math.round(h.stock.buyPct ?? 50)}%`;
        ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(label).width + 10;
        const lx = Math.max(8, spineX - tw - 8);
        const ly = Math.max(18, Math.min(canvasH - 18, h.targetSpineY));
        ctx.fillStyle = 'rgba(3, 10, 14, 0.88)';
        ctx.fillRect(lx, ly - 8, tw, 15);
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.9;
        ctx.strokeRect(lx, ly - 8, tw, 15);
        ctx.fillStyle = col;
        ctx.fillText(label, lx + 5, ly + 2.5);
        ctx.restore();
      }

      // 4. Glowing Horizontal Horizon Line (shifts smoothly down/up with midY!)
      if (currentSplitRatio > 0.02 && currentSplitRatio < 0.98) {
        const horizonAlpha = Math.min(0.78, Math.min(currentSplitRatio, 1 - currentSplitRatio) * 2.4);
        ctx.strokeStyle = `rgba(226, 241, 255, ${horizonAlpha.toFixed(2)})`;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(originX, midY);
        ctx.lineTo(rightEdgeX, midY);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(originX, midY, 2.8, 0, Math.PI * 2);
        ctx.arc(spineX, midY, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // 5. Animated Flowing Particles Driven by Each Stock's Real Order-Flow Velocity
      for (const p of particles) {
        const isBull = p.bull;
        const regionH = isBull ? bullRegionH : bearRegionH;
        if (regionH < 8) continue;

        const pool = isBull ? bullPool : bearPool;
        const stock = pool.length ? pool[p.lane % pool.length] : null;
        const m = getStockChartFlowMetrics(stock, isBull);

        if (!animPaused) {
          p.t += p.baseSpeed * (0.65 + m.flowWeight * 0.95);
          if (p.t >= 1) p.t -= 1;
        }

        const lanesCount = Math.max(12, Math.min(24, pool.length || 16));
        const laneIdx = p.lane % lanesCount;
        const frac = (laneIdx + 0.5) / lanesCount;
        const regionStartY = isBull ? topBound : midY;
        const pad = Math.min(10, regionH * 0.06);
        const targetSpineY = regionStartY + pad + frac * Math.max(2, regionH - pad * 2);
        const regionRatio = regionH / totalSpan;

        const t = p.t;
        const inv = 1 - t;
        const cp1x = originX + (spineX - originX) * 0.34;
        const baseCp1y = isBull
          ? midY - (midY - targetSpineY) * (0.78 + m.pressureNorm * 0.16)
          : midY + (targetSpineY - midY) * (0.78 + m.pressureNorm * 0.16);
        const cp1y = baseCp1y - m.midInfl * 14 * regionRatio;
        const cp2x = originX + (spineX - originX) * 0.68;
        const cp2y = targetSpineY - m.endSlope * 10 * regionRatio + p.amp;

        const px =
          inv * inv * inv * originX +
          3 * inv * inv * t * cp1x +
          3 * inv * t * t * cp2x +
          t * t * t * spineX;
        const py =
          inv * inv * inv * midY +
          3 * inv * inv * t * cp1y +
          3 * inv * t * t * cp2y +
          t * t * t * targetSpineY;

        const isAct = Boolean(activeSym && stock && stock.symbol === activeSym);
        ctx.fillStyle = isAct ? '#ffffff' : isBull ? '#19f59e' : '#ff4769';
        ctx.beginPath();
        ctx.arc(px, py, isAct ? 2.5 : 1.1 + m.flowWeight * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    requestAnimationFrame(renderStreamFrame);
  }

  // ============================================================================
  // Hover & Click Event Delegation Across All 3 Columns + All-218 Screener
  // ============================================================================
  document.addEventListener('pointermove', e => {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;

    if (lockedSymbol) return;

    // 0. Hovering a Row in the All-218-Stocks Real-Time Screener Table
    const screenerRow = e.target.closest('.ob-screener-row[data-symbol]');
    if (screenerRow) {
      setHoveredStock(screenerRow.dataset.symbol, 'screener');
      return;
    }

    // 1. Hovering a Stock Tile in Middle Matrix or Tile Grid
    const tile = e.target.closest('.m-tile[data-symbol]');
    if (tile) {
      const inScreener = Boolean(tile.closest('#allStocksSection'));
      setHoveredStock(tile.dataset.symbol, inScreener ? 'screener' : 'matrix');
      return;
    }

    // 2. Hovering a Sector Node on Left Stream
    const secNode = e.target.closest('.sector-hud-node[data-sector]');
    if (secNode) {
      const secName = secNode.dataset.sector;
      if (hoveredSector !== secName) {
        hoveredSector = secName;
        renderSectorStacks(appState?.sectors || [], appState?.universe || []);
        renderStockMatrices(appState?.universe || []);
      }
      const candidates = (appState?.universe || []).filter(s => s.sector === secName);
      const leadStock =
        filterMode === 'BULL'
          ? candidates.find(s => s.side === 'BULL') || candidates[0]
          : filterMode === 'BEAR'
          ? candidates.find(s => s.side === 'BEAR') || candidates[0]
          : candidates[0];
      if (leadStock) {
        setHoveredStock(leadStock.symbol, 'stream');
      }
      return;
    }

    // 3. Hovering a Right-Hand Chart Card
    const chartCard = e.target.closest('.hud-chart-card[data-symbol]');
    if (chartCard) {
      lastPointer.zone = 'charts';
      els.hoverChartPopover.classList.add('hidden');
      const sym = chartCard.dataset.symbol;
      if (hoveredSymbol !== sym) {
        setHoveredStock(sym, 'charts');
      }
      return;
    }

    // 4. Hovering directly over the Left Flow Stream Canvas: map Y position to the exact stock strand
    if (e.target === els.flowCanvas && appState?.universe?.length) {
      const rect = els.flowCanvas.getBoundingClientRect();
      const relY = Math.max(0, Math.min(0.999, (e.clientY - rect.top) / Math.max(1, rect.height)));
      const split = Math.max(0.001, Math.min(0.999, currentSplitRatio));
      const isBullHalf = filterMode === 'BULL' ? true : filterMode === 'BEAR' ? false : relY <= split;
      const sideList = isBullHalf
        ? currentBullStreamStocks.length
          ? currentBullStreamStocks
          : (appState.universe || []).filter(s => s.side === 'BULL')
        : currentBearStreamStocks.length
        ? currentBearStreamStocks
        : (appState.universe || []).filter(s => s.side === 'BEAR');

      if (sideList.length) {
        const localFrac =
          filterMode === 'BULL' || filterMode === 'BEAR'
            ? relY
            : isBullHalf
            ? relY / split
            : (relY - split) / Math.max(0.001, 1 - split);
        const idx = Math.min(
          sideList.length - 1,
          Math.max(0, Math.floor(localFrac * sideList.length))
        );
        setHoveredStock(sideList[idx].symbol, 'stream');
      }
      return;
    }

    if (!e.target.closest('.ob-stage')) {
      lastPointer.zone = 'none';
      els.hoverChartPopover.classList.add('hidden');
    }
  });

  // Click to Lock/Pin stock or trigger Track / Remind / Filter buttons
  document.addEventListener('click', async e => {
    const qbtn = e.target.closest('.hcc-qbtn[data-action]');
    if (qbtn) {
      e.stopPropagation();
      const sym = qbtn.dataset.symbol;
      const action = qbtn.dataset.action;
      if (action === 'remind') {
        await fetch('/api/reminders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, minutes: 15 }),
        });
        showToast(`⏰ 15m Order-Block Reminder set for ${sym}`);
      } else if (action === 'track') {
        const mode = qbtn.dataset.side === 'BEAR' ? 'SELL_WATCH' : 'BUY_WATCH';
        await fetch('/api/tracker', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: sym,
            mode,
            notes: `Added from OrderBlock Observatory (${mode})`,
          }),
        });
        showToast(`📌 ${sym} added to My Stock Tracker (${mode === 'SELL_WATCH' ? 'Sell Watch' : 'Buy Watch'})`);
      }
      return;
    }

    const filterPill = e.target.closest('.ob-pill[data-filter-mode]');
    if (filterPill) {
      filterMode = filterPill.dataset.filterMode;
      document
        .querySelectorAll('.ob-pill[data-filter-mode]')
        .forEach(b => b.classList.toggle('active', b.dataset.filterMode === filterMode));
      refreshFilteredViews();
      if (filterMode === 'BULL') {
        showToast('🟢 Shifting Bearish down — Full-Screen Bullish Flow & Charts active');
      } else if (filterMode === 'BEAR') {
        showToast('🔴 Shifting Bullish up — Full-Screen Bearish Flow & Charts active');
      } else {
        showToast('⚖️ Split Bullish & Bearish Order-Flow stage restored');
      }
      return;
    }

    const rowOrTile = e.target.closest('.m-tile[data-symbol], .ob-screener-row[data-symbol]');
    if (rowOrTile && !e.target.closest('a, button')) {
      const sym = rowOrTile.dataset.symbol;
      if (lockedSymbol === sym) {
        lockedSymbol = null;
        els.pinLockBtn.classList.remove('locked');
        showToast(`🔓 Unlocked hover inspection`);
      } else {
        lockedSymbol = sym;
        els.pinLockBtn.classList.add('locked');
        setHoveredStock(sym, rowOrTile.classList.contains('ob-screener-row') ? 'screener' : 'matrix');
        showToast(`🔒 Pinned ${sym} to live chart (click again or press 🔒 to unlock)`);
      }
      return;
    }

    const secNode = e.target.closest('.sector-hud-node[data-sector]');
    if (secNode) {
      const sec = secNode.dataset.sector;
      if (selectedSector === sec) {
        selectedSector = 'ALL';
        hoveredSector = null;
      } else {
        selectedSector = sec;
        hoveredSector = sec;
      }
      if (els.sectorSelect) els.sectorSelect.value = selectedSector;
      refreshFilteredViews();
      showToast(
        selectedSector === 'ALL'
          ? '🌐 Showing all 22 sectors'
          : `🏷 Filtered by Sector: ${selectedSector}`
      );
    }
  });

  els.sectorSelect?.addEventListener('change', () => {
    selectedSector = els.sectorSelect.value || 'ALL';
    hoveredSector = selectedSector === 'ALL' ? null : selectedSector;
    refreshFilteredViews();
  });

  els.sortOrderSelect?.addEventListener('change', () => {
    sortOrder = els.sortOrderSelect.value || 'FLOW_SCORE';
    refreshFilteredViews();
    showToast(
      sortOrder === 'OB_STRENGTH'
        ? '🧱 Sorted by Strongest Order Block'
        : '⚡ Sorted by Strongest Flow'
    );
  });

  els.resetFiltersBtn?.addEventListener('click', () => {
    selectedSector = 'ALL';
    hoveredSector = null;
    filterMode = 'ALL';
    sortOrder = 'FLOW_SCORE';
    searchQuery = '';
    if (els.searchInput) els.searchInput.value = '';
    if (els.sectorSelect) els.sectorSelect.value = 'ALL';
    if (els.sortOrderSelect) els.sortOrderSelect.value = 'FLOW_SCORE';
    document
      .querySelectorAll('.ob-pill[data-filter-mode]')
      .forEach(b => b.classList.toggle('active', b.dataset.filterMode === 'ALL'));
    refreshFilteredViews();
    showToast('✕ Filters reset — showing all 218 F&O stocks');
  });

  els.toggleStageCollapseBtn?.addEventListener('click', () => {
    stageCollapsed = !stageCollapsed;
    els.obStage?.classList.toggle('hidden', stageCollapsed);
    els.toggleStageCollapseBtn.classList.toggle('active', stageCollapsed);
    els.toggleStageCollapseBtn.textContent = stageCollapsed
      ? '🌌 Show 3-Col Cyber-HUD'
      : '🌌 HUD + Screener';
    if (!stageCollapsed) setTimeout(resizeStreamCanvas, 50);
  });

  els.viewModeTableBtn?.addEventListener('click', () => {
    screenerViewMode = 'TABLE';
    els.viewModeTableBtn.classList.add('active');
    els.viewModeGridBtn?.classList.remove('active');
    els.screenerTableWrapper?.classList.remove('hidden');
    els.screenerGridContainer?.classList.add('hidden');
  });

  els.viewModeGridBtn?.addEventListener('click', () => {
    screenerViewMode = 'GRID';
    els.viewModeGridBtn.classList.add('active');
    els.viewModeTableBtn?.classList.remove('active');
    els.screenerGridContainer?.classList.remove('hidden');
    els.screenerTableWrapper?.classList.add('hidden');
  });

  // Search box (⌘K) with instant live filtering across all 218 stocks + dropdown
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      els.searchInput.focus();
    } else if (e.key === 'Escape') {
      els.searchDropdown.classList.add('hidden');
      if (lockedSymbol) {
        lockedSymbol = null;
        els.pinLockBtn.classList.remove('locked');
      }
    }
  });

  els.searchInput?.addEventListener('input', () => {
    const q = els.searchInput.value.trim().toUpperCase();
    searchQuery = q;
    refreshFilteredViews();

    if (!q || !appState?.universe) {
      els.searchDropdown.classList.add('hidden');
      return;
    }
    const matches = appState.universe
      .filter(
        s =>
          s.symbol.includes(q) ||
          (s.name || '').toUpperCase().includes(q) ||
          (s.sector || '').toUpperCase().includes(q)
      )
      .slice(0, 10);

    if (!matches.length) {
      els.searchDropdown.classList.add('hidden');
      return;
    }

    els.searchDropdown.classList.remove('hidden');
    els.searchDropdown.innerHTML = matches
      .map(
        m => `
        <div class="search-item" data-search-sym="${escapeHtml(m.symbol)}">
          <span><strong>${escapeHtml(m.symbol)}</strong> · <small>${escapeHtml(m.sector)}</small></span>
          <span style="color:${m.side === 'BEAR' ? '#ff4769' : '#19f59e'}">₹${fmtNum(m.ltp)} (${fmtPct(m.chgPct)}) · ${m.agree}/${m.totalChecks} ${m.side}</span>
        </div>
      `
      )
      .join('');

    setHoveredStock(matches[0].symbol, 'charts');
  });

  els.searchDropdown?.addEventListener('pointerover', e => {
    const item = e.target.closest('[data-search-sym]');
    if (item) setHoveredStock(item.dataset.searchSym, 'charts');
  });

  els.searchDropdown?.addEventListener('click', e => {
    const item = e.target.closest('[data-search-sym]');
    if (item) {
      lockedSymbol = item.dataset.searchSym;
      els.pinLockBtn.classList.add('locked');
      setHoveredStock(lockedSymbol, 'charts');
      els.searchDropdown.classList.add('hidden');
      showToast(`🔒 Pinned ${lockedSymbol}`);
    }
  });

  // Rail Controls
  els.toggleAnimBtn?.addEventListener('click', () => {
    animPaused = !animPaused;
    els.toggleAnimBtn.classList.toggle('active', !animPaused);
    showToast(animPaused ? '⏸ Stream particles paused' : '▶ Stream particles resumed');
  });

  els.filterTrackerBtn?.addEventListener('click', () => {
    trackerOnlyFilter = !trackerOnlyFilter;
    els.filterTrackerBtn.classList.toggle('active', trackerOnlyFilter);
    renderStockMatrices(appState?.universe || []);
    showToast(trackerOnlyFilter ? '📖 Showing My Tracker stocks first' : '📖 Showing all 218 F&O stocks');
  });

  els.toggleHoverPopupBtn?.addEventListener('click', () => {
    showHoverPopup = !showHoverPopup;
    els.toggleHoverPopupBtn.classList.toggle('active', showHoverPopup);
    if (!showHoverPopup) els.hoverChartPopover.classList.add('hidden');
    showToast(
      showHoverPopup
        ? '◉ Floating Hover Chart Magnifier ON'
        : '◉ Floating Hover Chart Magnifier OFF (Right-hand live charts still update on hover)'
    );
  });

  els.pinLockBtn?.addEventListener('click', () => {
    if (lockedSymbol) {
      lockedSymbol = null;
      els.pinLockBtn.classList.remove('locked');
      showToast('🔓 Hover lock released');
    } else if (hoveredSymbol) {
      lockedSymbol = hoveredSymbol;
      els.pinLockBtn.classList.add('locked');
      showToast(`🔒 Locked on ${lockedSymbol}`);
    }
  });

  els.quickRemindActiveBtn?.addEventListener('click', async () => {
    const sym = lockedSymbol || hoveredSymbol;
    if (!sym) return;
    await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, minutes: 15 }),
    });
    showToast(`⏰ 15m Reminder scheduled for ${sym}`);
  });

  els.quickTrackActiveBtn?.addEventListener('click', async () => {
    const sym = lockedSymbol || hoveredSymbol;
    if (!sym) return;
    const card = getStockCardFromUniverse(sym);
    const mode = card?.side === 'BEAR' ? 'SELL_WATCH' : 'BUY_WATCH';
    await fetch('/api/tracker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, mode, notes: 'Added from OrderBlock HUD' }),
    });
    showToast(`📌 Added ${sym} to My Tracker (${mode})`);
  });

  els.obSyncNowBtn?.addEventListener('click', async () => {
    els.obSyncNowBtn.textContent = '↻ Syncing…';
    try {
      await fetch('/api/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } finally {
      els.obSyncNowBtn.textContent = '↻ Sync';
    }
  });

  // Boot canvas + fetch state + connect SSE
  resizeStreamCanvas();
  requestAnimationFrame(renderStreamFrame);

  fetch('/api/state')
    .then(r => r.json())
    .then(renderAll)
    .catch(console.error);

  const es = new EventSource('/api/events');
  es.addEventListener('state', ev => {
    try {
      renderAll(JSON.parse(ev.data));
    } catch {}
  });
})();
