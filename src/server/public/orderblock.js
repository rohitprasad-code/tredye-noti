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
  let sortOrder = 'MAX_GAINS'; // MAX_GAINS (Max Gains / Bulls & Bears) | FLOW_SCORE (Strongest Flow)
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
  let currentBullStreamStocks = []; // Top picked Bulls from the TOP green bracket [ ]
  let currentBearStreamStocks = []; // Bottom picked Bears from the BOTTOM red bracket [ ]
  let currentAllBullSpine = [];     // All Bulls sorted from Max Gain (top) down to 0% (midY)
  let currentAllBearSpine = [];     // All Bears sorted from 0% (midY) down to Max Loss (bottom)

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

  // Compute enriched sectors ordered from Maximum Gain (top) to Maximum Loss (bottom)
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

    enriched.sort((a, b) => {
      if (Math.abs((b.avgChgPct || 0) - (a.avgChgPct || 0)) > 0.01) {
        return (b.avgChgPct || 0) - (a.avgChgPct || 0);
      }
      return (b.flowCr || 0) - (a.flowCr || 0);
    });
    return enriched;
  }

  // Render Left Sector Stack Nodes (Sorted Top-to-Bottom by Gain %, with 10 Bull/Bear split segments per card)
  function renderSectorStacks(sectors = [], universe = []) {
    const ordered = getOrderedSectors(sectors, universe);

    let bullSectors = ordered.filter(s => s.avgChgPct >= 0 || s.flowCr >= 0);
    let bearSectors = ordered.filter(s => s.avgChgPct < 0 && s.flowCr < 0);

    if (bullSectors.length < 4 && ordered.length >= 6) {
      const half = Math.ceil(ordered.length / 2);
      bullSectors = ordered.slice(0, half);
      bearSectors = ordered.slice(half);
    } else if (bearSectors.length < 4 && ordered.length >= 6) {
      const half = Math.ceil(ordered.length / 2);
      bullSectors = ordered.slice(0, half);
      bearSectors = ordered.slice(half);
    }

    const bullLimit = filterMode === 'BULL' ? 12 : 9;
    const bearLimit = filterMode === 'BEAR' ? 12 : 8;
    // Top stack: highest gain at very top, tapering down toward 0%
    const displayBullSectors = (filterMode === 'BULL' && bullSectors.length < 10 ? ordered : bullSectors).slice(0, bullLimit);
    // Bottom stack: mildest bear near 0% at top of bottom stack, most negative bear at very bottom
    const bearSource = filterMode === 'BEAR' && bearSectors.length < 10 ? ordered.slice(-bearLimit) : bearSectors.slice(-bearLimit);
    const displayBearSectors = bearSource;

    const totalBullCr = displayBullSectors.reduce((a, s) => a + Math.abs(s.flowCr), 0);
    const totalBearCr = displayBearSectors.reduce((a, s) => a + Math.abs(s.flowCr), 0);
    if (els.spineBullVal) els.spineBullVal.textContent = `+${totalBullCr.toFixed(0)} Cr`;
    if (els.spineBearVal) els.spineBearVal.textContent = `-${totalBearCr.toFixed(0)} Cr`;

    const activeSec = selectedSector !== 'ALL' ? selectedSector : hoveredSector;

    const buildSectorNodeHtml = (sec, isBull) => {
      const totalStocks = Math.max(1, (sec.bullCount || 0) + (sec.bearCount || 0));
      const rawBullRatio = (sec.bullCount || 0) / totalStocks;
      const greenSegs = isBull
        ? Math.max(4, Math.min(9, Math.round(rawBullRatio * 10)))
        : Math.max(1, Math.min(6, Math.round(rawBullRatio * 10)));
      let segs = '';
      for (let i = 0; i < 10; i++) {
        const cls = i < greenSegs ? 'on-up' : 'on-dn';
        segs += `<span class="shn-seg ${cls}"></span>`;
      }
      const isAct = activeSec === sec.sector;
      const pctVal = Number(sec.avgChgPct || 0);
      return `
        <div class="sector-hud-node ${isBull ? 'bull' : 'bear'} ${isAct ? 'active' : ''}"
             data-sector="${escapeHtml(sec.sector)}"
             data-side="${isBull ? 'BULL' : 'BEAR'}">
          <div class="shn-top">
            <span class="shn-name">${escapeHtml(sec.sector.toUpperCase())}</span>
            <span class="shn-pct ${isBull ? 'up' : 'dn'}">${pctVal >= 0 ? '+' : ''}${pctVal.toFixed(1)}%</span>
          </div>
          <div class="shn-bars">${segs}</div>
        </div>
      `;
    };

    els.sectorNodesTop.innerHTML = displayBullSectors.map(s => buildSectorNodeHtml(s, true)).join('');
    els.sectorNodesBottom.innerHTML = displayBearSectors.map(s => buildSectorNodeHtml(s, false)).join('');
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

  // Compute signed spine rank score so stocks sort cleanly from Maximum Gains & Strongest Bulls (TOP)
  // down through 0 (MIDDLE) to Maximum Losses & Strongest Bears (BOTTOM)
  function getSignedSpineMetric(stock) {
    const isBull = stock.side !== 'BEAR';
    const chg = Number(stock.chgPct || 0);
    const score = Number(stock.strengthScore || 50);
    const flow = Math.abs(Number(stock.rupeeFlowCr || 0));
    const obStr = Number(getCardOrderBlockMeta(stock).str || 1.0);

    if (sortOrder === 'FLOW_SCORE') {
      const mag = score * 2.5 + Math.abs(chg) * 14 + Math.min(80, flow * 0.15);
      return isBull ? mag : -mag;
    }
    // Default 'MAX_GAINS': sorted by Maximum Gains (Bulls at top) down to Maximum Losses (Bears at bottom)
    const gainMag = Math.max(0.02, isBull ? Math.max(0.05, chg) : Math.max(0.05, -chg));
    const composite = gainMag * 100 + score * 0.35 + obStr * 6;
    return isBull ? composite : -composite;
  }

  // Build the Top-to-Bottom Spine-Sorted pools and pick the top few Bulls from the TOP and bottom few Bears from the BOTTOM
  function getSpineSortedPools(universe = []) {
    const trackerSet = new Set((appState?.tracker || []).map(t => t.symbol));
    const activeSec = selectedSector !== 'ALL' ? selectedSector : hoveredSector;

    let base = [...universe];
    if (trackerOnlyFilter) {
      base = base.filter(s => trackerSet.has(s.symbol));
    }
    if (activeSec) {
      base = base.filter(s => s.sector === activeSec);
    }
    if (searchQuery) {
      const q = searchQuery.toUpperCase();
      base = base.filter(
        s =>
          s.symbol.includes(q) ||
          (s.name || '').toUpperCase().includes(q) ||
          (s.sector || '').toUpperCase().includes(q) ||
          (s.buildup || '').toUpperCase().includes(q)
      );
    }

    // All Bulls sorted from TOP (Maximum Gain / Strongest Bull) down to MID (Mildest Bull near 0%)
    const allBulls = base
      .filter(s => s.side === 'BULL')
      .sort((a, b) => getSignedSpineMetric(b) - getSignedSpineMetric(a));

    // All Bears sorted from MID (Mildest Bear near 0%) down to BOTTOM (Maximum Loss / Strongest Bear at the very end)
    const allBears = base
      .filter(s => s.side === 'BEAR')
      .sort((a, b) => getSignedSpineMetric(b) - getSignedSpineMetric(a));

    return { allBulls, allBears };
  }

  // Filter and sort the 218-stock universe according to Sector, Side (All/Bullish/Bearish), Search, and Sort
  function getFilteredAndSortedStocks(universe = [], { ignoreSidePill = false } = {}) {
    const { allBulls, allBears } = getSpineSortedPools(universe);

    if (!ignoreSidePill && filterMode === 'BULL') {
      return allBulls;
    }
    if (!ignoreSidePill && filterMode === 'BEAR') {
      // Return strongest / maximum-loss bears first when viewing Bearish list
      return [...allBears].reverse();
    }

    // Full top-to-bottom spine order: Maximum Gain Bulls at top -> Mild Bulls -> Mild Bears -> Maximum Loss Bears at bottom
    return [...allBulls, ...allBears];
  }

  // Render Middle Stock Matrix by picking the top few from the TOP of the spine and bottom few from the BOTTOM of the spine
  function renderStockMatrices(universe = []) {
    const isBullOnly = filterMode === 'BULL';
    const isBearOnly = filterMode === 'BEAR';

    // Update target split ratio for the Flow Stream Canvas smooth animation
    targetSplitRatio = isBullOnly ? 1.0 : isBearOnly ? 0.0 : 0.5;

    if (els.obStage) {
      els.obStage.classList.toggle('side-only-bull', isBullOnly);
      els.obStage.classList.toggle('side-only-bear', isBearOnly);
    }

    const { allBulls, allBears } = getSpineSortedPools(universe);
    const maxBullTiles = isBullOnly ? 32 : 16;
    const maxBearTiles = isBearOnly ? 32 : 16;

    // Pick the few ones from the very TOP of the sorted spine (Maximum Gains / Strongest Bulls)
    let bulls = allBulls.slice(0, maxBullTiles);
    // Pick the few ones from the very BOTTOM of the sorted spine (Maximum Losses / Strongest Bears)
    let bears = [...allBears].reverse().slice(0, maxBearTiles);

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

    // Store both the full top-to-bottom spine arrays AND the top/bottom picked bracket subsets
    currentAllBullSpine = allBulls.length ? allBulls : bulls;
    currentAllBearSpine = allBears.length ? allBears : [...bears].reverse();
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

    // Pick the top few Bulls from the TOP of the spine and the bottom few Bears from the BOTTOM of the spine
    const { allBulls, allBears } = getSpineSortedPools(universe);
    const extremeBearsFromBottom = [...allBears].reverse();
    let bullCards = (allBulls.length >= bullSlotCount
      ? allBulls
      : universe.filter(s => s.side === 'BULL')
    ).slice(0, bullSlotCount);
    let bearCards = (extremeBearsFromBottom.length >= bearSlotCount
      ? extremeBearsFromBottom
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
        sortOrder === 'FLOW_SCORE' ? '⚡ Strongest Flow' : '📈 Max Gains / Bulls & Bears';
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

  // Deterministic hash helper so each stock has a stable intraday wave signature & OB trigger marker
  function symHash(sym = '') {
    let h = 2166136261;
    for (let i = 0; i < sym.length; i++) {
      h ^= sym.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  // Evaluate a wavy intraday stock trajectory at normalized horizontal progress t in [0..1]
  function evalWavyTrajectoryY(t, midY, targetY, stock, isBull, nowMs, laneIdx = 0) {
    const h = symHash(stock?.symbol || `S${laneIdx}`);
    const p1 = (h % 100) * 0.0628;
    const p2 = ((h >> 7) % 100) * 0.0628;
    const gainPower = 0.62 + ((h % 19) / 19) * 0.26;
    const baseProgress = Math.pow(t, gainPower);
    const baseY = midY + (targetY - midY) * baseProgress;

    const env = Math.sin(t * Math.PI);
    const dist = Math.abs(targetY - midY);
    const amp = Math.min(22, Math.max(3.5, dist * 0.095));
    const drift = animPaused ? 0 : nowMs * 0.00055;
    const wave =
      (Math.sin(t * Math.PI * 3.2 + p1 + drift) * 0.62 +
        Math.cos(t * Math.PI * 6.4 + p2 - drift * 0.7) * 0.38) *
      amp *
      env;

    return baseY + wave;
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

      const topBound = 12;
      const botBound = canvasH - 18;
      const totalSpan = Math.max(100, botBound - topBound);
      const midY = topBound + totalSpan * currentSplitRatio;
      const bullRegionH = Math.max(0, midY - topBound);
      const bearRegionH = Math.max(0, botBound - midY);

      const originX = 28;
      const spineX = Math.round(canvasW * 0.715);
      const bracketW = Math.max(38, Math.round(canvasW * 0.115));
      const bracketRightX = spineX + bracketW;
      const rightEdgeX = canvasW;
      const streamSpanX = Math.max(80, spineX - originX);

      // Top Green Bracket [ ] & Bottom Red Bracket [ ] vertical bounds on the sorted spine
      const topBracketTop = topBound + 2;
      const topBracketH = bullRegionH > 20 ? Math.max(36, Math.min(bullRegionH * 0.32, 92)) : 0;
      const topBracketBot = topBracketTop + topBracketH;

      const botBracketBot = botBound - 2;
      const botBracketH = bearRegionH > 20 ? Math.max(36, Math.min(bearRegionH * 0.32, 92)) : 0;
      const botBracketTop = botBracketBot - botBracketH;

      const activeSym = lockedSymbol || hoveredSymbol;

      const bullPool = currentBullStreamStocks.length
        ? currentBullStreamStocks
        : (appState?.universe || []).filter(s => s.side === 'BULL').slice(0, 16);
      const bearPool = currentBearStreamStocks.length
        ? currentBearStreamStocks
        : (appState?.universe || []).filter(s => s.side === 'BEAR').slice(0, 16);

      const allBullSpine = currentAllBullSpine.length ? currentAllBullSpine : bullPool;
      const allBearSpine = currentAllBearSpine.length ? currentAllBearSpine : [...bearPool].reverse();

      // =========================================================================
      // 1. Left Y-Axis Gain/Loss Scale (+3 .. 0 .. -4) & Bottom X-Axis Time Ticks
      // =========================================================================
      ctx.save();
      ctx.font = '600 7.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      if (bullRegionH > 48) {
        const bullTicks = [
          { lbl: '+3', f: 0.04 },
          { lbl: '+2', f: 0.19 },
          { lbl: '+1', f: 0.44 },
          { lbl: '+0.5', f: 0.71 },
          { lbl: '+0.2', f: 0.86 },
        ];
        for (const tk of bullTicks) {
          const ty = topBound + bullRegionH * tk.f;
          ctx.fillStyle = 'rgba(148, 184, 168, 0.52)';
          ctx.fillText(tk.lbl, originX - 5, ty);
          ctx.strokeStyle = 'rgba(148, 184, 168, 0.28)';
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(originX - 3, ty);
          ctx.lineTo(originX, ty);
          ctx.stroke();
        }
      }

      if (currentSplitRatio > 0.03 && currentSplitRatio < 0.97) {
        ctx.fillStyle = 'rgba(226, 241, 255, 0.78)';
        ctx.fillText('0', originX - 5, midY);
      }

      if (bearRegionH > 48) {
        const bearTicks = [
          { lbl: '-0.2', f: 0.09 },
          { lbl: '-0.5', f: 0.24 },
          { lbl: '-0.75', f: 0.36 },
          { lbl: '-1', f: 0.45 },
          { lbl: '-1.25', f: 0.56 },
          { lbl: '-1.5', f: 0.66 },
          { lbl: '-2', f: 0.78 },
          { lbl: '-3', f: 0.90 },
          { lbl: '-4', f: 0.98 },
        ];
        for (const tk of bearTicks) {
          const ty = midY + bearRegionH * tk.f;
          ctx.fillStyle = 'rgba(148, 184, 168, 0.52)';
          ctx.fillText(tk.lbl, originX - 5, ty);
          ctx.strokeStyle = 'rgba(148, 184, 168, 0.28)';
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(originX - 3, ty);
          ctx.lineTo(originX, ty);
          ctx.stroke();
        }
      }

      // Bottom X-axis time scale (09:30 .. 12:30)
      const timeTicks = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(148, 184, 168, 0.52)';
      for (let i = 0; i < timeTicks.length; i++) {
        const tx = originX + 18 + ((i + 0.2) / timeTicks.length) * (streamSpanX - 24);
        ctx.fillText(timeTicks[i], tx, canvasH - 2);
      }
      ctx.restore();

      // =========================================================================
      // 2. Dotted Cyber-Matrix Heatmap Field + Electric-Blue Reference Glow Lines
      // =========================================================================
      const cellStepX = 4.2;
      const cellStepY = 3.8;
      for (let cx = originX + 10; cx < spineX - 2; cx += cellStepX) {
        const xFrac = (cx - originX) / streamSpanX;
        const envFrac = Math.pow(xFrac, 0.56);

        // Bullish matrix cells
        if (bullRegionH > 12) {
          const bullTopEnv = midY - bullRegionH * envFrac;
          for (let cy = midY - 3; cy >= bullTopEnv; cy -= cellStepY) {
            const yFrac = (midY - cy) / Math.max(1, bullRegionH);
            const bandPulse =
              0.5 +
              0.5 * Math.sin(yFrac * 26 + cx * 0.04) * Math.cos(yFrac * 11 - xFrac * 2.2);
            const rightDense = 0.25 + 0.75 * Math.pow(xFrac, 0.85);
            const alpha = (0.06 + bandPulse * 0.26) * rightDense;
            if (alpha > 0.05) {
              ctx.fillStyle = `rgba(25, 245, 158, ${Math.min(0.52, alpha).toFixed(2)})`;
              ctx.fillRect(cx, cy, 2.3, 1.6);
            }
          }
        }

        // Bearish matrix cells
        if (bearRegionH > 12) {
          const bearBotEnv = midY + bearRegionH * envFrac;
          for (let cy = midY + 3; cy <= bearBotEnv; cy += cellStepY) {
            const yFrac = (cy - midY) / Math.max(1, bearRegionH);
            const bandPulse =
              0.5 +
              0.5 * Math.sin(yFrac * 24 + cx * 0.038) * Math.cos(yFrac * 12 + xFrac * 2.0);
            const rightDense = 0.25 + 0.75 * Math.pow(xFrac, 0.85);
            const alpha = (0.06 + bandPulse * 0.26) * rightDense;
            if (alpha > 0.05) {
              ctx.fillStyle = `rgba(255, 71, 105, ${Math.min(0.52, alpha).toFixed(2)})`;
              ctx.fillRect(cx, cy, 2.3, 1.6);
            }
          }
        }
      }

      // Electric-Blue / Cyan Horizontal Reference Glow Lines across the stream field
      const drawCyanGlowLine = (y, startXFrac, intensity = 0.65) => {
        const sx = originX + streamSpanX * startXFrac;
        ctx.save();
        ctx.strokeStyle = `rgba(32, 156, 255, ${(intensity * 0.38).toFixed(2)})`;
        ctx.lineWidth = 4.5;
        ctx.beginPath();
        ctx.moveTo(sx, y);
        ctx.lineTo(spineX, y);
        ctx.stroke();

        ctx.strokeStyle = `rgba(96, 205, 255, ${intensity.toFixed(2)})`;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.moveTo(sx, y);
        ctx.lineTo(spineX, y);
        ctx.stroke();
        ctx.restore();
      };

      if (bullRegionH > 60) {
        drawCyanGlowLine(topBound + bullRegionH * 0.19, 0.22, 0.35);
        drawCyanGlowLine(topBound + bullRegionH * 0.44, 0.16, 0.72);
        drawCyanGlowLine(topBound + bullRegionH * 0.71, 0.10, 0.78);
      }
      if (bearRegionH > 60) {
        drawCyanGlowLine(midY + bearRegionH * 0.24, 0.14, 0.42);
        drawCyanGlowLine(midY + bearRegionH * 0.36, 0.18, 0.48);
        drawCyanGlowLine(midY + bearRegionH * 0.56, 0.22, 0.38);
        drawCyanGlowLine(midY + bearRegionH * 0.90, 0.28, 0.44);
      }

      // =========================================================================
      // 3. Wavy Intraday Stock Trajectories (originX -> spineX) + [ ] OB Trigger Boxes
      //    & Fan-Out Connectors from Top/Bottom Selection Brackets (bracketRightX -> rightEdgeX)
      // =========================================================================
      const drawWavyCurve = (targetY, stock, isBull, laneIdx, alpha, lineW, drawObMarker) => {
        const steps = 18;
        ctx.strokeStyle = isBull
          ? `rgba(25, 245, 158, ${alpha.toFixed(2)})`
          : `rgba(255, 71, 105, ${alpha.toFixed(2)})`;
        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(originX, midY);

        let obMarkerPt = null;
        const h = symHash(stock?.symbol || `L${laneIdx}`);
        const obStep = 4 + (h % 6); // Between 22% and 50% along the intraday timeline

        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const x = originX + t * streamSpanX;
          const y = evalWavyTrajectoryY(t, midY, targetY, stock, isBull, nowMs, laneIdx);
          ctx.lineTo(x, y);
          if (drawObMarker && s === obStep) {
            obMarkerPt = { x, y };
          }
        }
        ctx.stroke();

        // Draw small hollow neon [ ] Order-Block trigger box + trailing dotted level ray
        if (obMarkerPt) {
          const bx = obMarkerPt.x;
          const by = obMarkerPt.y;
          ctx.save();
          ctx.strokeStyle = isBull
            ? `rgba(25, 245, 158, ${Math.min(0.92, alpha + 0.35).toFixed(2)})`
            : `rgba(255, 71, 105, ${Math.min(0.92, alpha + 0.35).toFixed(2)})`;
          ctx.lineWidth = 0.95;
          ctx.strokeRect(bx - 2.5, by - 3.5, 5, 7);

          // Dotted horizontal ray from the OB trigger box toward the spine
          ctx.setLineDash([1.5, 2.5]);
          ctx.strokeStyle = isBull
            ? `rgba(25, 245, 158, ${(alpha * 0.55).toFixed(2)})`
            : `rgba(255, 71, 105, ${(alpha * 0.55).toFixed(2)})`;
          ctx.lineWidth = 0.65;
          ctx.beginPath();
          ctx.moveTo(bx + 3, by);
          ctx.lineTo(spineX, by);
          ctx.stroke();
          ctx.restore();
        }
      };

      // 3A. Draw unpicked middle-spine trajectories (between topBracketBot and botBracketTop)
      if (bullRegionH > 30 && allBullSpine.length > bullPool.length) {
        const midBulls = allBullSpine.slice(bullPool.length, bullPool.length + 22);
        const spanH = Math.max(8, midY - topBracketBot - 4);
        for (let i = 0; i < midBulls.length; i++) {
          const st = midBulls[i];
          const frac = (i + 0.5) / midBulls.length;
          const targetY = topBracketBot + 2 + frac * spanH;
          drawWavyCurve(targetY, st, true, i + 30, 0.24, 0.65, i % 2 === 0);
        }
      }
      if (bearRegionH > 30 && allBearSpine.length > bearPool.length) {
        const midBears = allBearSpine.slice(0, Math.min(22, Math.max(0, allBearSpine.length - bearPool.length)));
        const spanH = Math.max(8, botBracketTop - midY - 4);
        for (let i = 0; i < midBears.length; i++) {
          const st = midBears[i];
          const frac = (i + 0.5) / midBears.length;
          const targetY = midY + 2 + frac * spanH;
          drawWavyCurve(targetY, st, false, i + 60, 0.24, 0.65, i % 2 === 0);
        }
      }

      // 3B. Draw PICKED TOP BULLS (entering Top Green Bracket [ ]) & PICKED BOTTOM BEARS (entering Bottom Red Bracket [ ])
      //     and fan their connectors out from the right edge of the [ ] brackets to the Matrix!
      let highlightedStrandMeta = null;

      const drawPickedBracketGroup = (isBull, pool, bracketTop, bracketBot, regionStartY, regionH) => {
        if (regionH < 10 || !pool.length) return;
        const count = pool.length;
        const bSpan = Math.max(8, bracketBot - bracketTop - 4);

        for (let i = 0; i < count; i++) {
          const stock = pool[i];
          const m = getStockChartFlowMetrics(stock, isBull);
          // For Bulls: #1 Max Gain is at very top (bracketTop).
          // For Bears: #1 Max Loss is at very bottom (bracketBot), so reverse index inside bottom bracket!
          const spineSlotFrac = isBull ? (i + 0.5) / count : 1 - (i + 0.5) / count;
          const spineY = bracketTop + 2 + spineSlotFrac * bSpan;

          const alpha = Math.min(0.76, 0.32 + m.flowWeight * 0.36);
          const lineW = 0.85 + m.flowWeight * 0.65;
          drawWavyCurve(spineY, stock, isBull, i, alpha, lineW, i % 3 === 0);

          // Fan-out curve leaving the RIGHT edge of the [ ] selection bracket (bracketRightX -> rightEdgeX)
          const matrixTargetFrac = (i + 0.5) / count;
          const matrixTargetY = regionStartY + 4 + matrixTargetFrac * Math.max(8, regionH - 8);
          const rcp1x = bracketRightX + (rightEdgeX - bracketRightX) * 0.38;
          const rcp2x = bracketRightX + (rightEdgeX - bracketRightX) * 0.66;

          ctx.strokeStyle = isBull
            ? `rgba(25, 245, 158, ${(alpha * 0.82).toFixed(2)})`
            : `rgba(255, 71, 105, ${(alpha * 0.82).toFixed(2)})`;
          ctx.lineWidth = 0.65 + m.flowWeight * 0.45;
          ctx.beginPath();
          ctx.moveTo(bracketRightX, spineY);
          ctx.bezierCurveTo(rcp1x, spineY, rcp2x, matrixTargetY, rightEdgeX, matrixTargetY);
          ctx.stroke();

          if (activeSym && stock && stock.symbol === activeSym && !highlightedStrandMeta) {
            highlightedStrandMeta = {
              stock,
              isBull,
              laneIdx: i,
              spineY,
              rcp1x,
              rcp2x,
              matrixTargetY,
            };
          }
        }
      };

      drawPickedBracketGroup(true, bullPool, topBracketTop, topBracketBot, topBound, bullRegionH);
      drawPickedBracketGroup(false, bearPool, botBracketTop, botBracketBot, midY, bearRegionH);

      // =========================================================================
      // 4. Right-Side Sorted Vertical Spine (Maximum Gains at Top -> 0 -> Maximum Losses at Bottom)
      //    + Glowing Top Green [ ] & Bottom Red [ ] Selection Brackets
      // =========================================================================
      // Subtle dotted matrix inside the dark concave lens between spineX and bracketRightX
      ctx.fillStyle = 'rgba(148, 184, 168, 0.12)';
      for (let lx = spineX + 6; lx < bracketRightX - 2; lx += 5) {
        for (let ly = topBound + 6; ly < botBound - 6; ly += 5) {
          ctx.fillRect(lx, ly, 1, 1);
        }
      }

      // Faint dotted vertical right boundary of the spine column (at bracketRightX)
      ctx.save();
      ctx.setLineDash([1.5, 2.5]);
      ctx.strokeStyle = 'rgba(148, 184, 168, 0.26)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(bracketRightX, topBound);
      ctx.lineTo(bracketRightX, botBound);
      ctx.stroke();
      ctx.restore();

      // Horizontal sorted gain/loss bars along spineX -> bracketRightX
      const spineBarsCount = Math.max(90, Math.floor(totalSpan / 3.2));
      const spineStepY = totalSpan / spineBarsCount;

      for (let i = 0; i <= spineBarsCount; i++) {
        const y = topBound + i * spineStepY;
        const isTop = y <= midY;
        if (isTop && bullRegionH < 6) continue;
        if (!isTop && bearRegionH < 6) continue;

        let barLen = 0;
        let alpha = 0.45;

        if (isTop) {
          if (y <= topBracketBot) {
            // Inside the Top Green Selection Bracket [ ]: maximum gains span full bracket width
            const bFrac = (y - topBracketTop) / Math.max(1, topBracketH);
            barLen = bracketW * (0.98 - bFrac * 0.08);
            alpha = 0.78 - bFrac * 0.16;
          } else {
            // Taper smoothly from topBracketBot down to 0 at midY (concave silhouette)
            const t = (y - topBracketBot) / Math.max(1, midY - topBracketBot);
            barLen = bracketW * 0.68 * Math.pow(Math.max(0, 1 - t), 1.55);
            alpha = 0.18 + (1 - t) * 0.42;
          }
          ctx.fillStyle = `rgba(25, 245, 158, ${alpha.toFixed(2)})`;
        } else {
          if (y >= botBracketTop) {
            // Inside the Bottom Red Selection Bracket [ ]: maximum losses span full bracket width
            const bFrac = (y - botBracketTop) / Math.max(1, botBracketH);
            barLen = bracketW * (0.90 + bFrac * 0.08);
            alpha = 0.62 + bFrac * 0.18;
          } else {
            // Grow smoothly from 0 at midY down to botBracketTop (concave silhouette)
            const t = (y - midY) / Math.max(1, botBracketTop - midY);
            barLen = bracketW * 0.68 * Math.pow(Math.max(0, t), 1.55);
            alpha = 0.18 + t * 0.42;
          }
          ctx.fillStyle = `rgba(255, 71, 105, ${alpha.toFixed(2)})`;
        }

        if (barLen >= 1.2) {
          ctx.fillRect(spineX + 0.5, y - 0.8, barLen, 1.75);
        }
      }

      // Main glowing vertical spine axis line at spineX
      ctx.strokeStyle = 'rgba(226, 241, 255, 0.72)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(spineX, topBound);
      ctx.lineTo(spineX, botBound);
      ctx.stroke();

      // Helper to draw the glowing [ ] selection brackets at the very TOP and very BOTTOM of the spine
      const drawSelectionBracket = (bTop, bBot, isBull) => {
        if (bBot - bTop < 16) return;
        const col = isBull ? '#19f59e' : '#ff4769';
        const glowFill = isBull ? 'rgba(25, 245, 158, 0.10)' : 'rgba(255, 71, 105, 0.10)';
        const serif = 6;

        ctx.save();
        ctx.fillStyle = glowFill;
        ctx.fillRect(spineX, bTop, bracketW, bBot - bTop);

        ctx.strokeStyle = col;
        ctx.lineWidth = 1.8;
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;

        // Left bracket wall [
        ctx.beginPath();
        ctx.moveTo(spineX + serif, bTop);
        ctx.lineTo(spineX, bTop);
        ctx.lineTo(spineX, bBot);
        ctx.lineTo(spineX + serif, bBot);
        ctx.stroke();

        // Right bracket wall ]
        ctx.beginPath();
        ctx.moveTo(bracketRightX - serif, bTop);
        ctx.lineTo(bracketRightX, bTop);
        ctx.lineTo(bracketRightX, bBot);
        ctx.lineTo(bracketRightX - serif, bBot);
        ctx.stroke();

        // Crisp white corner ticks + interior sparkle dots (matches screenshot)
        ctx.shadowBlur = 4;
        ctx.fillStyle = '#ffffff';
        const sparkles = [
          [spineX + bracketW * 0.35, bTop + (bBot - bTop) * 0.28],
          [spineX + bracketW * 0.68, bTop + (bBot - bTop) * 0.52],
          [spineX + bracketW * 0.44, bTop + (bBot - bTop) * 0.78],
        ];
        for (const [sx, sy] of sparkles) {
          ctx.beginPath();
          ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      };

      if (bullRegionH > 30) {
        drawSelectionBracket(topBracketTop, topBracketBot, true);
      }
      if (bearRegionH > 30) {
        drawSelectionBracket(botBracketTop, botBracketBot, false);
      }

      // =========================================================================
      // 5. Center 0 Horizon Line + Glowing White Comet Streak + Matrix Split Curve
      // =========================================================================
      if (currentSplitRatio > 0.02 && currentSplitRatio < 0.98) {
        const horizonAlpha = Math.min(0.85, Math.min(currentSplitRatio, 1 - currentSplitRatio) * 2.5);
        ctx.save();
        ctx.strokeStyle = `rgba(218, 238, 255, ${horizonAlpha.toFixed(2)})`;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(originX, midY);
        ctx.lineTo(bracketRightX, midY);
        // Smooth S-curve from (bracketRightX, midY) to the Matrix split line
        const splitTargetY = midY;
        ctx.bezierCurveTo(
          bracketRightX + (rightEdgeX - bracketRightX) * 0.4,
          midY,
          bracketRightX + (rightEdgeX - bracketRightX) * 0.6,
          splitTargetY,
          rightEdgeX,
          splitTargetY
        );
        ctx.stroke();

        // Glowing White Comet Streak along the 0 horizon line (matches screenshot)
        const cometHeadX = originX + streamSpanX * 0.61;
        const cometTailX = originX + streamSpanX * 0.36;
        const cometGrad = ctx.createLinearGradient(cometTailX, midY, cometHeadX, midY);
        cometGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        cometGrad.addColorStop(0.7, 'rgba(200, 238, 255, 0.65)');
        cometGrad.addColorStop(1, 'rgba(255, 255, 255, 1)');
        ctx.strokeStyle = cometGrad;
        ctx.lineWidth = 2.8;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(cometTailX, midY);
        ctx.lineTo(cometHeadX, midY);
        ctx.stroke();

        // Glowing white intersection dots at originX, cometHeadX, spineX, and bracketRightX
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(originX, midY, 2.8, 0, Math.PI * 2);
        ctx.arc(cometHeadX, midY, 2.3, 0, Math.PI * 2);
        ctx.arc(spineX, midY, 2.5, 0, Math.PI * 2);
        ctx.arc(bracketRightX, midY, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // =========================================================================
      // 6. Highlight Active Hovered / Pinned Stock's Trajectory + Bracket Node
      // =========================================================================
      if (highlightedStrandMeta) {
        const h = highlightedStrandMeta;
        const col = h.isBull ? '#19f59e' : '#ff4769';
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.4;
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;

        ctx.beginPath();
        ctx.moveTo(originX, midY);
        for (let s = 1; s <= 20; s++) {
          const t = s / 20;
          const x = originX + t * streamSpanX;
          const y = evalWavyTrajectoryY(t, midY, h.spineY, h.stock, h.isBull, nowMs, h.laneIdx);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(bracketRightX, h.spineY);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(bracketRightX, h.spineY);
        ctx.bezierCurveTo(h.rcp1x, h.spineY, h.rcp2x, h.matrixTargetY, rightEdgeX, h.matrixTargetY);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(spineX, h.spineY, 3.2, 0, Math.PI * 2);
        ctx.arc(bracketRightX, h.spineY, 3.2, 0, Math.PI * 2);
        ctx.fill();

        const label = `${h.stock.symbol} (${fmtPct(h.stock.chgPct)})`;
        ctx.font = '700 8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(label).width + 10;
        const lx = Math.max(originX + 6, spineX - tw - 6);
        const ly = Math.max(16, Math.min(canvasH - 18, h.spineY));
        ctx.fillStyle = 'rgba(3, 10, 14, 0.9)';
        ctx.fillRect(lx, ly - 8, tw, 15);
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.9;
        ctx.strokeRect(lx, ly - 8, tw, 15);
        ctx.fillStyle = col;
        ctx.fillText(label, lx + 5, ly + 2.5);
        ctx.restore();
      }

      // =========================================================================
      // 7. Animated Flowing Particles Along the Picked Top/Bottom Trajectories
      // =========================================================================
      for (const p of particles) {
        const isBull = p.bull;
        const regionH = isBull ? bullRegionH : bearRegionH;
        if (regionH < 12) continue;

        const pool = isBull ? bullPool : bearPool;
        if (!pool.length) continue;
        const laneIdx = p.lane % pool.length;
        const stock = pool[laneIdx];
        const m = getStockChartFlowMetrics(stock, isBull);

        if (!animPaused) {
          p.t += p.baseSpeed * (0.65 + m.flowWeight * 0.9);
          if (p.t >= 1) p.t -= 1;
        }

        const bracketTop = isBull ? topBracketTop : botBracketTop;
        const bracketBot = isBull ? topBracketBot : botBracketBot;
        const bSpan = Math.max(8, bracketBot - bracketTop - 4);
        const spineSlotFrac = isBull ? (laneIdx + 0.5) / pool.length : 1 - (laneIdx + 0.5) / pool.length;
        const targetSpineY = bracketTop + 2 + spineSlotFrac * bSpan;

        const px = originX + p.t * streamSpanX;
        const py = evalWavyTrajectoryY(p.t, midY, targetSpineY, stock, isBull, nowMs, laneIdx);

        const isAct = Boolean(activeSym && stock && stock.symbol === activeSym);
        ctx.fillStyle = isAct ? '#ffffff' : isBull ? '#19f59e' : '#ff4769';
        ctx.beginPath();
        ctx.arc(px, py, isAct ? 2.2 : 1.0 + m.flowWeight * 0.85, 0, Math.PI * 2);
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
    sortOrder = els.sortOrderSelect.value || 'MAX_GAINS';
    refreshFilteredViews();
    showToast(
      sortOrder === 'FLOW_SCORE'
        ? '⚡ Sorted by Strongest Flow (Top Bulls & Bottom Bears)'
        : '📈 Sorted by Max Gains / Bulls & Bears (Picking top & bottom leaders)'
    );
  });

  els.resetFiltersBtn?.addEventListener('click', () => {
    selectedSector = 'ALL';
    hoveredSector = null;
    filterMode = 'ALL';
    sortOrder = 'MAX_GAINS';
    searchQuery = '';
    if (els.searchInput) els.searchInput.value = '';
    if (els.sectorSelect) els.sectorSelect.value = 'ALL';
    if (els.sortOrderSelect) els.sortOrderSelect.value = 'MAX_GAINS';
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
