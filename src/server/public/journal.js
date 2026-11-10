/* global EventSource */
'use strict';

(() => {
  let appState = null;
  const detailCache = new Map();
  const pendingFetches = new Map();

  let statusFilter = 'ALL'; // ALL | OPEN | CLOSED | AT_RISK
  let sectorFilter = 'ALL';
  let searchQuery = '';
  let sortMode = 'NEWEST';
  let activeEntryId = null;

  const els = {
    liveSourceBadge: document.getElementById('liveSourceBadge'),
    kpiInvested: document.getElementById('kpiInvested'),
    kpiOpenCount: document.getElementById('kpiOpenCount'),
    kpiCurrentValue: document.getElementById('kpiCurrentValue'),
    kpiAvgReturn: document.getElementById('kpiAvgReturn'),
    kpiOpenPnl: document.getElementById('kpiOpenPnl'),
    kpiBestPerformer: document.getElementById('kpiBestPerformer'),
    kpiClosedPnl: document.getElementById('kpiClosedPnl'),
    kpiWinRate: document.getElementById('kpiWinRate'),
    kpiAtRiskCount: document.getElementById('kpiAtRiskCount'),
    kpiAtRiskSub: document.getElementById('kpiAtRiskSub'),
    sectorAllocPills: document.getElementById('sectorAllocPills'),
    tabCntAll: document.getElementById('tabCntAll'),
    tabCntOpen: document.getElementById('tabCntOpen'),
    tabCntClosed: document.getElementById('tabCntClosed'),
    tabCntRisk: document.getElementById('tabCntRisk'),
    journalSearchInput: document.getElementById('journalSearchInput'),
    journalSortSelect: document.getElementById('journalSortSelect'),
    bookletCardsGrid: document.getElementById('bookletCardsGrid'),
    ledgerTableBody: document.getElementById('ledgerTableBody'),
    inspSymbolTitle: document.getElementById('inspSymbolTitle'),
    inspVerdictBadge: document.getElementById('inspVerdictBadge'),
    inspChartContainer: document.getElementById('inspChartContainer'),
    inspMetaRow: document.getElementById('inspMetaRow'),
    formHeading: document.getElementById('formHeading'),
    journalForm: document.getElementById('journalForm'),
    entryIdInput: document.getElementById('entryIdInput'),
    fSymbol: document.getElementById('fSymbol'),
    fSymbolList: document.getElementById('fSymbolList'),
    fSide: document.getElementById('fSide'),
    fStatus: document.getElementById('fStatus'),
    fQty: document.getElementById('fQty'),
    fEntryPrice: document.getElementById('fEntryPrice'),
    fExitPrice: document.getElementById('fExitPrice'),
    fStopPrice: document.getElementById('fStopPrice'),
    fTargetPrice: document.getElementById('fTargetPrice'),
    fRating: document.getElementById('fRating'),
    fSetupType: document.getElementById('fSetupType'),
    fObZone: document.getElementById('fObZone'),
    fThesis: document.getElementById('fThesis'),
    fLessons: document.getElementById('fLessons'),
    fSyncTracker: document.getElementById('fSyncTracker'),
    saveEntryBtn: document.getElementById('saveEntryBtn'),
    resetFormBtn: document.getElementById('resetFormBtn'),
    newEntryBtn: document.getElementById('newEntryBtn'),
    jZoomOut: document.getElementById('jZoomOut'),
    jZoomReset: document.getElementById('jZoomReset'),
    jZoomIn: document.getElementById('jZoomIn'),
    toastStack: document.getElementById('jToastStack'),
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

  function fmtRs(n, digits = 0) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const sign = v < 0 ? '-' : '';
    return `${sign}₹${Math.abs(v).toLocaleString('en-IN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  }

  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    try {
      return new Date(ms).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return '—';
    }
  }

  function showToast(msg) {
    const div = document.createElement('div');
    div.className = 'j-toast';
    div.textContent = msg;
    els.toastStack.appendChild(div);
    setTimeout(() => div.remove(), 4200);
  }

  // Zoom controls
  let uiZoomPct = Number(localStorage.getItem('tredye_ui_zoom_pct') || 100);
  function applyZoom(pct) {
    uiZoomPct = Math.max(60, Math.min(140, Math.round(pct)));
    localStorage.setItem('tredye_ui_zoom_pct', String(uiZoomPct));
    document.documentElement.style.zoom = `${uiZoomPct}%`;
    if (els.jZoomReset) els.jZoomReset.textContent = `${uiZoomPct}%`;
  }
  applyZoom(uiZoomPct);
  els.jZoomOut?.addEventListener('click', () => applyZoom(uiZoomPct - 10));
  els.jZoomReset?.addEventListener('click', () => applyZoom(100));
  els.jZoomIn?.addEventListener('click', () => applyZoom(uiZoomPct + 10));

  async function ensureStockDetail(symbol) {
    if (!symbol) return null;
    const sym = symbol.toUpperCase();
    if (detailCache.has(sym)) return detailCache.get(sym);
    if (pendingFetches.has(sym)) return pendingFetches.get(sym);

    const p = fetch(`/api/stock/${encodeURIComponent(sym)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        pendingFetches.delete(sym);
        if (d && d.stock) detailCache.set(sym, d);
        return d;
      })
      .catch(() => {
        pendingFetches.delete(sym);
        return null;
      });
    pendingFetches.set(sym, p);
    return p;
  }

  function getFilteredEntries(entries = []) {
    let list = [...entries];

    if (statusFilter === 'OPEN') {
      list = list.filter(e => e.status === 'OPEN');
    } else if (statusFilter === 'CLOSED') {
      list = list.filter(e => e.status === 'CLOSED');
    } else if (statusFilter === 'AT_RISK') {
      list = list.filter(
        e => e.healthTone === 'warn' || e.healthTone === 'danger' || e.healthCode === 'STEP_BACK_WARNING' || e.healthCode === 'STOP_BREACHED'
      );
    }

    if (sectorFilter !== 'ALL') {
      list = list.filter(e => (e.sector || 'Other') === sectorFilter);
    }

    if (searchQuery) {
      const q = searchQuery.toUpperCase();
      list = list.filter(
        e =>
          e.symbol.includes(q) ||
          (e.sector || '').toUpperCase().includes(q) ||
          (e.setupType || '').toUpperCase().includes(q) ||
          (e.thesis || '').toUpperCase().includes(q) ||
          (e.lessons || '').toUpperCase().includes(q)
      );
    }

    list.sort((a, b) => {
      if (sortMode === 'CAPITAL_DESC') return (b.investedCapital || 0) - (a.investedCapital || 0);
      if (sortMode === 'PNL_DESC') return (b.pnlRs || 0) - (a.pnlRs || 0);
      if (sortMode === 'PNL_ASC') return (a.pnlRs || 0) - (b.pnlRs || 0);
      if (sortMode === 'FLOW_SCORE') return (b.liveStrength || 0) - (a.liveStrength || 0);
      return (b.entryAt || 0) - (a.entryAt || 0);
    });

    return list;
  }

  // Build Live 3-Minute Candlestick + Order Block + Personal Entry/Stop/Target Chart SVG
  function buildBookletPositionChartSvg(entry, detail) {
    const ltp = entry.liveLtp || entry.entryPrice || 100;
    const isBuy = entry.side !== 'SELL';
    const candles = detail?.candles || [];
    const W = 390;
    const H = 170;
    const padL = 8;
    const padR = 58;
    const padT = 12;
    const padB = 12;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let pts = [];
    if (candles.length >= 4) {
      pts = candles.slice(-48);
    } else {
      const startP = entry.entryPrice || ltp * 0.99;
      for (let i = 0; i < 28; i++) {
        const t = i / 27;
        const c = startP + (ltp - startP) * t + Math.sin(t * Math.PI * 3) * (ltp * 0.002);
        pts.push([0, c - ltp * 0.001, c + ltp * 0.0018, c - ltp * 0.0018, c, 1000]);
      }
    }

    const priceCandidates = [
      ltp,
      entry.entryPrice,
      entry.stopPrice,
      entry.targetPrice,
      entry.bullOB?.bot,
      entry.bullOB?.top,
      entry.bearOB?.bot,
      entry.bearOB?.top,
      ...pts.map(c => c[2]),
      ...pts.map(c => c[3]),
    ].filter(p => Number.isFinite(Number(p)) && Number(p) > 0);

    const minP = Math.min(...priceCandidates) * 0.9975;
    const maxP = Math.max(...priceCandidates) * 1.0025;
    const rangeP = Math.max(0.01, maxP - minP);

    const yOf = p => padT + ((maxP - p) / rangeP) * plotH;
    const xOf = i => padL + (i / Math.max(1, pts.length - 1)) * plotW;

    const strokeCol = (entry.pnlRs || 0) >= 0 ? '#19f59e' : '#ff4769';
    const svg = [];

    // Grid lines
    for (let g = 1; g <= 3; g++) {
      const gy = padT + (plotH * g) / 4;
      svg.push(
        `<line x1="${padL}" x2="${W - padR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="0.7"/>`
      );
    }

    // Order Block Shaded Zone (Bull OB or Bear OB)
    const ob = isBuy ? entry.bullOB || detail?.obInfo?.primaryOB : entry.bearOB || detail?.obInfo?.primaryOB;
    if (ob && ob.bot && ob.top) {
      const y1 = Math.max(padT, Math.min(H - padB, yOf(ob.top)));
      const y2 = Math.max(padT, Math.min(H - padB, yOf(ob.bot)));
      const bh = Math.max(4, Math.abs(y2 - y1));
      const obCol = ob.type === 'bear' ? '#ff4769' : '#19f59e';
      svg.push(
        `<rect x="${padL + plotW * 0.15}" y="${Math.min(y1, y2).toFixed(1)}" width="${(plotW * 0.85).toFixed(1)}" height="${bh.toFixed(1)}" fill="${obCol}" fill-opacity="0.16" stroke="${obCol}" stroke-opacity="0.55" stroke-dasharray="3 2" stroke-width="0.8"/>`,
        `<text x="${padL + plotW * 0.18}" y="${(Math.min(y1, y2) + 9).toFixed(1)}" fill="${obCol}" font-size="7" font-weight="700">OB ₹${ob.bot}–${ob.top}</text>`
      );
    }

    // Draw Personal Entry, Stop Loss, and Target Horizontal Lines
    const drawPositionLine = (price, label, col, dash = '3 2') => {
      if (!price || !Number.isFinite(Number(price))) return;
      const py = yOf(Number(price));
      if (py < padT || py > H - padB) return;
      svg.push(
        `<line x1="${padL}" x2="${W - 4}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" stroke="${col}" stroke-dasharray="${dash}" stroke-width="1"/>`,
        `<rect x="${W - padR + 2}" y="${(py - 6).toFixed(1)}" width="${padR - 6}" height="12" rx="2" fill="rgba(3,10,14,0.9)" stroke="${col}" stroke-width="0.7"/>`,
        `<text x="${W - padR + 5}" y="${(py + 2.5).toFixed(1)}" fill="${col}" font-size="6.4" font-weight="800">${label} ${Number(price).toFixed(0)}</text>`
      );
    };

    drawPositionLine(entry.entryPrice, 'ENTRY', '#f5b82e', '');
    drawPositionLine(entry.stopPrice, 'STOP', '#ff4769', '2 2');
    drawPositionLine(entry.targetPrice, 'TGT', '#38bdf8', '3 2');

    // Price Curve
    const coords = pts.map((c, idx) => [xOf(idx), yOf(c[4])]);
    const pathD = coords
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`)
      .join(' ');
    svg.push(`<path d="${pathD}" fill="none" stroke="${strokeCol}" stroke-width="1.6"/>`);

    const lastPt = coords[coords.length - 1];
    svg.push(
      `<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="5.5" fill="none" stroke="#ffffff" stroke-width="1"/>`,
      `<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2.5" fill="#ffffff"/>`
    );

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;display:block;" preserveAspectRatio="none">${svg.join('')}</svg>`;
  }

  function renderInspectorForEntry(entry) {
    if (!entry) return;
    activeEntryId = entry.id;
    const detail = detailCache.get(entry.symbol);
    if (!detail) {
      ensureStockDetail(entry.symbol).then(() => {
        if (activeEntryId === entry.id) renderInspectorForEntry(entry);
      });
    }

    els.inspSymbolTitle.textContent = `${entry.symbol} · ${entry.side} (${entry.status}) — LTP ${fmtRs(entry.liveLtp, 2)}`;
    els.inspVerdictBadge.textContent = entry.healthLabel || '—';
    els.inspVerdictBadge.style.color =
      entry.healthTone === 'warn' || entry.healthTone === 'danger'
        ? 'var(--dn)'
        : 'var(--up)';

    els.inspChartContainer.innerHTML = buildBookletPositionChartSvg(entry, detail);

    const pnlColor = (entry.pnlRs || 0) >= 0 ? 'var(--up)' : 'var(--dn)';
    els.inspMetaRow.innerHTML = `
      <div class="fin-cell">
        <span class="fin-lbl">Invested</span>
        <span class="fin-val">${fmtRs(entry.investedCapital)}</span>
      </div>
      <div class="fin-cell">
        <span class="fin-lbl">Live P&amp;L</span>
        <span class="fin-val" style="color:${pnlColor}">${entry.pnlRs >= 0 ? '+' : ''}${fmtRs(entry.pnlRs)} (${fmtPct(entry.pnlPct)})</span>
      </div>
      <div class="fin-cell">
        <span class="fin-lbl">Tredye Flow</span>
        <span class="fin-val">${entry.liveAgree}/${entry.liveTotalChecks} ${entry.liveSide} (${entry.liveBuyPct}%)</span>
      </div>
      <div class="fin-cell">
        <span class="fin-lbl">R-Multiple</span>
        <span class="fin-val gold">${entry.rMultiple !== null && entry.rMultiple !== undefined ? `${entry.rMultiple >= 0 ? '+' : ''}${entry.rMultiple}R` : '—'}</span>
      </div>
    `;
  }

  function renderBooklet(state) {
    appState = state;
    const entries = state.journal || [];
    const summary = state.journalSummary || {};

    // Populate symbol datalist from all 218 F&O stocks
    if (els.fSymbolList && state.universe?.length) {
      els.fSymbolList.innerHTML = state.universe
        .map(s => `<option value="${escapeHtml(s.symbol)}">${escapeHtml(s.symbol)} — ${escapeHtml(s.sector)} (₹${s.ltp})</option>`)
        .join('');
    }

    // KPIs
    els.kpiInvested.textContent = fmtRs(summary.totalInvestedOpen || 0);
    els.kpiOpenCount.textContent = `${summary.openCount || 0} active open holdings`;
    els.kpiCurrentValue.textContent = fmtRs(summary.totalCurrentOpen || 0);

    const openPnl = summary.openPnlRs || 0;
    const openPct = summary.openPnlPct || 0;
    els.kpiOpenPnl.textContent = `${openPnl >= 0 ? '+' : ''}${fmtRs(openPnl)} (${fmtPct(openPct)})`;
    els.kpiOpenPnl.className = `kpi-val ${openPnl >= 0 ? 'up' : 'dn'}`;

    const closedPnl = summary.closedPnlRs || 0;
    els.kpiClosedPnl.textContent = `${closedPnl >= 0 ? '+' : ''}${fmtRs(closedPnl)}`;
    els.kpiClosedPnl.className = `kpi-val ${closedPnl >= 0 ? 'up' : 'dn'}`;
    els.kpiWinRate.textContent = `Closed trades: ${summary.closedCount || 0} · Win rate: ${summary.winRatePct ?? 0}%`;

    els.kpiAtRiskCount.textContent = String(summary.atRiskCount || 0);
    els.kpiAtRiskCount.className = `kpi-val ${(summary.atRiskCount || 0) > 0 ? 'dn' : 'up'}`;

    // Sector Allocation Pills
    const alloc = summary.sectorAllocation || [];
    els.sectorAllocPills.innerHTML = [
      `<button type="button" class="alloc-pill ${sectorFilter === 'ALL' ? 'active' : ''}" data-sec-pill="ALL">All Sectors (${entries.length})</button>`,
      ...alloc.map(
        a =>
          `<button type="button" class="alloc-pill ${sectorFilter === a.sector ? 'active' : ''}" data-sec-pill="${escapeHtml(a.sector)}">
            <strong>${escapeHtml(a.sector)}</strong> · ${fmtRs(a.capital)} (${a.sharePct}%)
          </button>`
      ),
    ].join('');

    // Tab counts
    els.tabCntAll.textContent = String(entries.length);
    els.tabCntOpen.textContent = String(entries.filter(e => e.status === 'OPEN').length);
    els.tabCntClosed.textContent = String(entries.filter(e => e.status === 'CLOSED').length);
    els.tabCntRisk.textContent = String(
      entries.filter(
        e => e.healthTone === 'warn' || e.healthTone === 'danger' || e.healthCode === 'STEP_BACK_WARNING' || e.healthCode === 'STOP_BREACHED'
      ).length
    );

    const filtered = getFilteredEntries(entries);

    if (!activeEntryId && filtered.length) {
      activeEntryId = filtered[0].id;
    }
    const activeEntry =
      filtered.find(e => e.id === activeEntryId) || entries.find(e => e.id === activeEntryId) || filtered[0];
    if (activeEntry) {
      renderInspectorForEntry(activeEntry);
    }

    // 1. Booklet Cards Grid
    els.bookletCardsGrid.innerHTML = filtered
      .map(e => {
        const isBuy = e.side !== 'SELL';
        const isPnlPos = (e.pnlRs || 0) >= 0;
        const stars = '★'.repeat(Math.max(1, Math.min(5, e.rating || 4)));
        const isHov = activeEntryId === e.id;

        return `
          <article class="booklet-leaf ${e.status === 'CLOSED' ? 'closed-leaf' : ''} ${isHov ? 'is-hovered' : ''}"
                   data-entry-id="${e.id}"
                   data-symbol="${escapeHtml(e.symbol)}">
            <div class="leaf-top">
              <div>
                <div class="leaf-sym-row">
                  <span class="leaf-sym">${escapeHtml(e.symbol)}</span>
                  <span class="leaf-side ${isBuy ? 'buy' : 'sell'}">${escapeHtml(e.side)}</span>
                  <span class="leaf-status">${escapeHtml(e.status)}</span>
                </div>
                <div class="leaf-sub">${escapeHtml(e.sector || 'NSE F&O')} · ${escapeHtml(e.setupType || 'Order Block Setup')} · ${fmtDate(e.entryAt)}</div>
              </div>
              <span class="leaf-stars" title="Conviction Rating">${stars}</span>
            </div>

            <div class="leaf-fin-grid">
              <div class="fin-cell">
                <span class="fin-lbl">Qty × Entry</span>
                <span class="fin-val">${e.qty} × ₹${Number(e.entryPrice).toLocaleString('en-IN')}</span>
              </div>
              <div class="fin-cell">
                <span class="fin-lbl">Invested ₹</span>
                <span class="fin-val">${fmtRs(e.investedCapital)}</span>
              </div>
              <div class="fin-cell">
                <span class="fin-lbl">${e.status === 'CLOSED' ? 'Exit Price' : 'Live LTP'}</span>
                <span class="fin-val">₹${Number(e.refPrice || e.liveLtp).toLocaleString('en-IN')} <small style="color:${e.liveChgPct >= 0 ? 'var(--up)' : 'var(--dn)'}">(${fmtPct(e.liveChgPct)})</small></span>
              </div>
              <div class="fin-cell">
                <span class="fin-lbl">${e.status === 'CLOSED' ? 'Booked P&L' : 'Live P&L'}</span>
                <span class="fin-val ${isPnlPos ? 'up' : 'dn'}">${isPnlPos ? '+' : ''}${fmtRs(e.pnlRs)} (${fmtPct(e.pnlPct)})</span>
              </div>
            </div>

            <div class="verdict-banner ${escapeHtml(e.healthCode || 'HOLD_STRONG')}">
              <div class="vb-top">
                <span>${escapeHtml(e.healthLabel)}</span>
                <span>Stop: ${e.stopPrice ? `₹${e.stopPrice}` : '—'} · Tgt: ${e.targetPrice ? `₹${e.targetPrice}` : '—'}${e.rMultiple !== null ? ` · ${e.rMultiple >= 0 ? '+' : ''}${e.rMultiple}R` : ''}</span>
              </div>
              <div class="vb-reason">${escapeHtml(e.healthReason)}</div>
            </div>

            <div class="leaf-notes">
              ${e.obZone ? `<div><small>Order Block Zone:</small> <strong style="color:var(--gold)">${escapeHtml(e.obZone)}</strong></div>` : ''}
              ${e.thesis ? `<div><small>Why I Invested:</small> ${escapeHtml(e.thesis)}</div>` : ''}
              ${e.lessons ? `<div><small>Booklet Review:</small> ${escapeHtml(e.lessons)}</div>` : ''}
            </div>

            <div class="leaf-foot">
              <span>Current Value: <strong>${fmtRs(e.currentValue)}</strong></span>
              <div class="leaf-actions">
                <button type="button" class="leaf-btn" data-j-action="edit" data-id="${e.id}">✏ Edit</button>
                ${
                  e.status === 'OPEN'
                    ? `<button type="button" class="leaf-btn" data-j-action="close" data-id="${e.id}">🏁 Book / Close</button>`
                    : ''
                }
                <a href="/app/orderblock" class="leaf-btn" style="text-decoration:none;">🌌 HUD</a>
                <button type="button" class="leaf-btn" data-j-action="delete" data-id="${e.id}">🗑</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    // 2. Responsive Ledger Table
    els.ledgerTableBody.innerHTML = filtered
      .map(e => {
        const isPnlPos = (e.pnlRs || 0) >= 0;
        const isHov = activeEntryId === e.id;
        return `
          <tr class="ledger-row ${isHov ? 'is-hovered' : ''}" data-entry-id="${e.id}">
            <th scope="row">
              <div><strong>${escapeHtml(e.symbol)}</strong> <small style="color:var(--text-mid)">(${escapeHtml(e.side)})</small></div>
              <div style="font-size:0.56rem;color:var(--text-mid)">${escapeHtml(e.sector)} · ${fmtDate(e.entryAt)}</div>
            </th>
            <td>
              <div><strong>${escapeHtml(e.status)}</strong></div>
              <div style="font-size:0.58rem;color:var(--text-mid)">${escapeHtml(e.setupType || 'OB Setup')}</div>
            </td>
            <td class="num">
              <div>${e.qty} sh</div>
              <div style="color:var(--text-mid)">@ ₹${Number(e.entryPrice).toLocaleString('en-IN')}</div>
            </td>
            <td class="num"><strong>${fmtRs(e.investedCapital)}</strong></td>
            <td class="num">
              <div>₹${Number(e.refPrice || e.liveLtp).toLocaleString('en-IN')}</div>
              <div style="font-size:0.58rem;color:${e.liveChgPct >= 0 ? 'var(--up)' : 'var(--dn)'}">${fmtPct(e.liveChgPct)} today</div>
            </td>
            <td class="num" style="color:${isPnlPos ? 'var(--up)' : 'var(--dn)'};font-weight:800;">
              <div>${isPnlPos ? '+' : ''}${fmtRs(e.pnlRs)}</div>
              <div>${fmtPct(e.pnlPct)}</div>
            </td>
            <td class="num" style="font-size:0.6rem;">
              <div>SL: ₹${e.stopPrice || '—'} · Tgt: ₹${e.targetPrice || '—'}</div>
              <div style="color:var(--gold)">${e.rMultiple !== null ? `${e.rMultiple >= 0 ? '+' : ''}${e.rMultiple}R` : '—'}</div>
            </td>
            <td>
              <div style="font-weight:800;font-size:0.62rem;">${escapeHtml(e.healthLabel)}</div>
              <div style="font-size:0.56rem;color:var(--text-mid)">${e.liveAgree}/${e.liveTotalChecks} ${e.liveSide} · Buy ${e.liveBuyPct}%</div>
            </td>
            <td>
              <div class="leaf-actions">
                <button type="button" class="leaf-btn" data-j-action="edit" data-id="${e.id}">✏</button>
                ${
                  e.status === 'OPEN'
                    ? `<button type="button" class="leaf-btn" data-j-action="close" data-id="${e.id}">🏁</button>`
                    : ''
                }
                <button type="button" class="leaf-btn" data-j-action="delete" data-id="${e.id}">🗑</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // Auto-populateEntryPrice, Stop, Target, and OB Zone when user types a symbol in the form
  els.fSymbol?.addEventListener('change', () => {
    const sym = els.fSymbol.value.trim().toUpperCase();
    if (!sym || !appState?.universe) return;
    const stock = appState.universe.find(s => s.symbol === sym);
    if (!stock) return;

    if (!els.fEntryPrice.value) els.fEntryPrice.value = String(stock.ltp);
    const ob = stock.primaryOB || stock.bestBullOB || stock.bestBearOB;
    if (ob && !els.fObZone.value) {
      els.fObZone.value = `${ob.type === 'bear' ? 'Bear' : 'Bull'} OB ₹${ob.bot}–₹${ob.top} (${ob.str}x)`;
    }
    if (!els.fStopPrice.value && stock.ltp) {
      const sl = ob?.bot ? Number((ob.bot * 0.994).toFixed(1)) : Number((stock.ltp * 0.982).toFixed(1));
      els.fStopPrice.value = String(sl);
    }
    if (!els.fTargetPrice.value && stock.ltp) {
      const tgt = Number((stock.ltp * 1.045).toFixed(1));
      els.fTargetPrice.value = String(tgt);
    }
  });

  function clearForm() {
    els.entryIdInput.value = '';
    els.formHeading.textContent = '➕ Log Investment / Trade in Booklet';
    els.saveEntryBtn.textContent = '💾 Save to Investment Booklet';
    els.journalForm.reset();
  }

  function loadEntryIntoForm(entry) {
    if (!entry) return;
    els.entryIdInput.value = String(entry.id);
    els.formHeading.textContent = `✏ Edit Booklet Entry — ${entry.symbol}`;
    els.saveEntryBtn.textContent = `💾 Update ${entry.symbol} in Booklet`;
    els.fSymbol.value = entry.symbol;
    els.fSide.value = entry.side || 'BUY';
    els.fStatus.value = entry.status || 'OPEN';
    els.fQty.value = String(entry.qty || 1);
    els.fEntryPrice.value = String(entry.entryPrice || '');
    els.fExitPrice.value = entry.exitPrice !== null && entry.exitPrice !== undefined ? String(entry.exitPrice) : '';
    els.fStopPrice.value = entry.stopPrice !== null && entry.stopPrice !== undefined ? String(entry.stopPrice) : '';
    els.fTargetPrice.value = entry.targetPrice !== null && entry.targetPrice !== undefined ? String(entry.targetPrice) : '';
    els.fRating.value = String(entry.rating || 4);
    els.fSetupType.value = entry.setupType || '';
    els.fObZone.value = entry.obZone || '';
    els.fThesis.value = entry.thesis || '';
    els.fLessons.value = entry.lessons || '';
    document.getElementById('entryFormCard')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  els.resetFormBtn?.addEventListener('click', clearForm);
  els.newEntryBtn?.addEventListener('click', () => {
    clearForm();
    els.fSymbol?.focus();
  });

  els.journalForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const id = els.entryIdInput.value.trim();
    const payload = {
      symbol: els.fSymbol.value.trim().toUpperCase(),
      side: els.fSide.value,
      status: els.fStatus.value,
      qty: Number(els.fQty.value || 1),
      entryPrice: Number(els.fEntryPrice.value),
      exitPrice: els.fExitPrice.value ? Number(els.fExitPrice.value) : null,
      stopPrice: els.fStopPrice.value ? Number(els.fStopPrice.value) : null,
      targetPrice: els.fTargetPrice.value ? Number(els.fTargetPrice.value) : null,
      rating: Number(els.fRating.value || 4),
      setupType: els.fSetupType.value.trim(),
      obZone: els.fObZone.value.trim(),
      thesis: els.fThesis.value.trim(),
      lessons: els.fLessons.value.trim(),
      syncToTracker: Boolean(els.fSyncTracker?.checked),
    };

    const url = id ? `/api/journal/${encodeURIComponent(id)}` : '/api/journal';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      if (appState) {
        appState.journal = data.journal;
        appState.journalSummary = data.journalSummary;
        if (data.item) activeEntryId = data.item.id;
        renderBooklet(appState);
      }
      showToast(id ? `✅ Updated ${payload.symbol} in Investment Booklet` : `📖 Added ${payload.symbol} to Investment Booklet`);
      clearForm();
    } else {
      showToast(`⚠️ ${data.error || 'Could not save entry'}`);
    }
  });

  // Hover delegation to update Live 3-Minute Order-Block & Entry/Stop/Target Chart
  document.addEventListener('pointerover', e => {
    const cardOrRow = e.target.closest('[data-entry-id]');
    if (!cardOrRow || !appState?.journal) return;
    const id = Number(cardOrRow.dataset.entryId);
    if (id === activeEntryId) return;
    const entry = appState.journal.find(x => x.id === id);
    if (entry) {
      document
        .querySelectorAll('.booklet-leaf.is-hovered, .ledger-row.is-hovered')
        .forEach(el => el.classList.remove('is-hovered'));
      document
        .querySelectorAll(`[data-entry-id="${id}"]`)
        .forEach(el => el.classList.add('is-hovered'));
      renderInspectorForEntry(entry);
    }
  });

  // Click delegation for tabs, sector pills, and Edit / Close / Delete buttons
  document.addEventListener('click', async e => {
    const tabBtn = e.target.closest('.tab-pill[data-status-filter]');
    if (tabBtn) {
      statusFilter = tabBtn.dataset.statusFilter;
      document
        .querySelectorAll('.tab-pill[data-status-filter]')
        .forEach(b => b.classList.toggle('active', b.dataset.statusFilter === statusFilter));
      if (appState) renderBooklet(appState);
      return;
    }

    const secBtn = e.target.closest('.alloc-pill[data-sec-pill]');
    if (secBtn) {
      sectorFilter = secBtn.dataset.secPill;
      if (appState) renderBooklet(appState);
      return;
    }

    const actBtn = e.target.closest('[data-j-action]');
    if (actBtn && appState?.journal) {
      e.stopPropagation();
      const id = Number(actBtn.dataset.id);
      const action = actBtn.dataset.jAction;
      const entry = appState.journal.find(x => x.id === id);
      if (!entry) return;

      if (action === 'edit') {
        loadEntryIntoForm(entry);
      } else if (action === 'close') {
        const exitPrice = entry.liveLtp || entry.entryPrice;
        const res = await fetch(`/api/journal/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'CLOSED',
            exitPrice,
            lessons: entry.lessons
              ? `${entry.lessons} · Closed at ₹${exitPrice}`
              : `Booked at live LTP ₹${exitPrice}`,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          appState.journal = data.journal;
          appState.journalSummary = data.journalSummary;
          renderBooklet(appState);
          showToast(`🏁 Closed ${entry.symbol} at ₹${exitPrice}`);
        }
      } else if (action === 'delete') {
        const res = await fetch(`/api/journal/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          appState.journal = data.journal;
          appState.journalSummary = data.journalSummary;
          renderBooklet(appState);
          showToast(`🗑 Removed ${entry.symbol} from Booklet`);
        }
      }
    }
  });

  els.journalSearchInput?.addEventListener('input', () => {
    searchQuery = els.journalSearchInput.value.trim();
    if (appState) renderBooklet(appState);
  });

  els.journalSortSelect?.addEventListener('change', () => {
    sortMode = els.journalSortSelect.value || 'NEWEST';
    if (appState) renderBooklet(appState);
  });

  // Check URL query parameters (?symbol=RELIANCE&action=new) from /app/orderblock
  function checkUrlPrefill() {
    const params = new URLSearchParams(window.location.search);
    const sym = params.get('symbol')?.trim().toUpperCase();
    if (!sym || !els.fSymbol) return;
    els.fSymbol.value = sym;
    els.fSymbol.dispatchEvent(new Event('change'));
    els.fThesis?.focus();
    showToast(`💼 Pre-filled ${sym} from OrderBlock HUD — review qty/thesis and click Save!`);
  }

  fetch('/api/state')
    .then(r => r.json())
    .then(state => {
      renderBooklet(state);
      checkUrlPrefill();
    })
    .catch(console.error);

  const es = new EventSource('/api/events');
  es.addEventListener('state', ev => {
    try {
      renderBooklet(JSON.parse(ev.data));
    } catch {}
  });
})();
