'use strict';

(() => {
  let appState = null;
  let selectedSymbol = new URLSearchParams(window.location.search).get('symbol')?.toUpperCase() || null;
  let activeAlertFilter = 'ALL';

  const els = {
    sourceBadge: document.getElementById('sourceBadge'),
    marketBadge: document.getElementById('marketBadge'),
    pollMeta: document.getElementById('pollMeta'),
    pollNowBtn: document.getElementById('pollNowBtn'),
    testNotifyBtn: document.getElementById('testNotifyBtn'),
    openCredentialsBtn: document.getElementById('openCredentialsBtn'),
    openSettingsBtn: document.getElementById('openSettingsBtn'),
    connectionBanner: document.getElementById('connectionBanner'),
    connBannerTitle: document.getElementById('connBannerTitle'),
    connBannerDesc: document.getElementById('connBannerDesc'),
    bannerConnectBtn: document.getElementById('bannerConnectBtn'),
    sectorRibbon: document.getElementById('sectorRibbon'),
    bullCountBadge: document.getElementById('bullCountBadge'),
    bearCountBadge: document.getElementById('bearCountBadge'),
    topBullList: document.getElementById('topBullList'),
    topBearList: document.getElementById('topBearList'),
    inspectorTitle: document.getElementById('inspectorTitle'),
    inspectorSub: document.getElementById('inspectorSub'),
    inspectorQuickActions: document.getElementById('inspectorQuickActions'),
    inspectorBody: document.getElementById('inspectorBody'),
    reminderCountBadge: document.getElementById('reminderCountBadge'),
    quickReminderForm: document.getElementById('quickReminderForm'),
    quickReminderSymbol: document.getElementById('quickReminderSymbol'),
    quickReminderMin: document.getElementById('quickReminderMin'),
    pendingRemindersList: document.getElementById('pendingRemindersList'),
    markAllReviewedBtn: document.getElementById('markAllReviewedBtn'),
    alertsFeed: document.getElementById('alertsFeed'),
    credentialsDialog: document.getElementById('credentialsDialog'),
    credentialsForm: document.getElementById('credentialsForm'),
    credStatusMsg: document.getElementById('credStatusMsg'),
    settingsDialog: document.getElementById('settingsDialog'),
    settingsForm: document.getElementById('settingsForm'),
    toastStack: document.getElementById('toastStack'),
    trackerSellCountBadge: document.getElementById('trackerSellCountBadge'),
    trackerBuyCountBadge: document.getElementById('trackerBuyCountBadge'),
    trackerAddForm: document.getElementById('trackerAddForm'),
    trSymbol: document.getElementById('trSymbol'),
    trMode: document.getElementById('trMode'),
    trEntryPrice: document.getElementById('trEntryPrice'),
    trTargetPrice: document.getElementById('trTargetPrice'),
    trStopPrice: document.getElementById('trStopPrice'),
    trNotes: document.getElementById('trNotes'),
    symbolSuggestions: document.getElementById('symbolSuggestions'),
    trackerList: document.getElementById('trackerList'),
  };

  function fmtINR(v, digits = 2) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    return '₹' + Number(v).toLocaleString('en-IN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtSignedPct(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Fallback for browsers without <dialog closedby="any"> support (e.g. Safari)
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      });
    }
  }

  document.querySelectorAll('[data-close-dialog]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close-dialog');
      document.getElementById(id)?.close();
    });
  });

  // Persistent Toast Notification using popover="manual"
  let toastSeq = 0;
  function showToast({ title, message, side = 'BULL', durationMs = 5500 }) {
    const id = `toast-${++toastSeq}`;
    const toast = document.createElement('div');
    toast.id = id;
    toast.setAttribute('popover', 'manual');
    toast.className = 'toast-popover';
    toast.style.borderColor = side === 'BEAR' ? 'var(--down)' : 'var(--up)';

    toast.innerHTML = `
      <div class="toast-head">
        <span>${escapeHtml(title)}</span>
        <button type="button" class="btn btn-ghost btn-xs" popovertarget="${id}" popovertargetaction="hide" aria-label="Dismiss notification">✕</button>
      </div>
      <div class="toast-body">${escapeHtml(message)}</div>
    `;

    els.toastStack.appendChild(toast);
    try {
      if (typeof toast.showPopover === 'function') {
        toast.showPopover();
      }
    } catch {
      // ignore if polyfill pending
    }

    const closeBtn = toast.querySelector('button');
    const removeToast = () => {
      try {
        if (typeof toast.hidePopover === 'function') toast.hidePopover();
      } catch {}
      toast.remove();
    };
    closeBtn?.addEventListener('click', removeToast);
    setTimeout(removeToast, durationMs);
  }

  function renderHeaderAndBanner(state) {
    // Source badge
    if (state.sourceMode === 'LIVE') {
      els.sourceBadge.className = 'badge badge-up';
      els.sourceBadge.textContent = '● LIVE TREDYE';
      els.connectionBanner.classList.add('hidden');
    } else {
      els.sourceBadge.className = 'badge badge-warn';
      els.sourceBadge.textContent = '● SAMPLE REPLAY';
      els.connectionBanner.classList.remove('hidden');
      if (state.lastError) {
        els.connBannerTitle.textContent = 'Tredye Auth / Connection Issue:';
        els.connBannerDesc.textContent = `${state.lastError} — Showing replay snapshot meanwhile.`;
      } else {
        els.connBannerTitle.textContent = 'Sample Replay Active:';
        els.connBannerDesc.textContent =
          'Inspecting NSE Order-Flow + Order-Block replay. Click "Tredye Login" to connect your live Tredye account.';
      }
    }

    // Market status badge
    const mkt = state.market;
    if (mkt?.open) {
      els.marketBadge.className = 'badge badge-up';
      els.marketBadge.textContent = `NSE LIVE · ${mkt.ist?.shortTimeStr || ''}`;
    } else {
      els.marketBadge.className = 'badge badge-neutral';
      els.marketBadge.textContent = `NSE ${mkt?.phase || 'CLOSED'} · ${mkt?.ist?.shortTimeStr || ''}`;
    }

    updatePollMetaDisplay();
  }

  function updatePollMetaDisplay() {
    if (!appState?.lastPollAt) return;
    const t = new Date(appState.lastPollAt).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const nextSec = appState.nextPollAt
      ? Math.max(0, Math.round((appState.nextPollAt - Date.now()) / 1000))
      : null;
    const nextStr = nextSec !== null ? ` · Next check in ${nextSec}s` : '';
    els.pollMeta.textContent = `Synced ${t} IST · ${appState.orderflowMeta?.totalStocks || 0} stocks${nextStr}`;
  }

  function renderSectorRibbon(sectors = []) {
    els.sectorRibbon.innerHTML = sectors
      .map(s => {
        const cls = s.flowCr >= 0 ? 'up' : 'down';
        const sign = s.flowCr >= 0 ? '+' : '';
        return `<span class="sector-pill ${cls}">${escapeHtml(s.sector)} (${s.count}) ${sign}${s.flowCr.toFixed(1)} Cr</span>`;
      })
      .join('');
  }

  function renderConfluenceDots(agree, total, side) {
    const dotCls = side === 'BULL' ? 'on-up' : 'on-down';
    let html = '<span class="dots-group">';
    for (let i = 0; i < total; i++) {
      html += `<span class="conf-dot ${i < agree ? dotCls : ''}"></span>`;
    }
    html += '</span>';
    return html;
  }

  function buildFlowCardHtml(card) {
    const isBull = card.side === 'BULL';
    const ob = card.primaryOB;
    const plan = card.referencePlan;
    const isSelected = selectedSymbol === card.symbol;
    const inZone = ob?.status === 'IN_ZONE';

    let distBadge = '';
    if (ob) {
      if (ob.distPct === 0 || ob.status === 'IN_ZONE') {
        distBadge = `<span class="badge ${isBull ? 'badge-up' : 'badge-down'}">🎯 IN OB ZONE NOW</span>`;
      } else {
        distBadge = `<span class="badge badge-neutral">${ob.distPct.toFixed(2)}% from OB · ${escapeHtml(ob.status.toLowerCase())}</span>`;
      }
    } else {
      distBadge = `<span class="badge badge-neutral">No unmitigated OB</span>`;
    }

    const cardCls = [
      'flow-card',
      isSelected ? 'active' : '',
      inZone ? (isBull ? 'in-zone-bull' : 'in-zone-bear') : '',
    ]
      .filter(Boolean)
      .join(' ');

    return `
      <article class="${cardCls}" data-symbol="${escapeHtml(card.symbol)}">
        <div class="fc-top">
          <div class="fc-sym-group">
            <span class="badge ${isBull ? 'badge-up' : 'badge-down'}">#${card.rank} ${isBull ? 'BUY FLOW' : 'SELL FLOW'}</span>
            <span class="fc-symbol">${escapeHtml(card.symbol)}</span>
            <span class="fc-sector">${escapeHtml(card.sector)}</span>
          </div>
          <div class="fc-price-group">
            <span class="fc-ltp">${fmtINR(card.ltp)}</span>
            <span class="fc-chg ${card.chgPct >= 0 ? 'text-up' : 'text-down'}">${fmtSignedPct(card.chgPct)}</span>
          </div>
        </div>

        <div class="fc-metrics-row">
          <span class="strength-pill">
            Strength ${card.strengthScore}/100 · ${card.agree}/${card.totalChecks}
            ${renderConfluenceDots(card.agree, card.totalChecks, card.side)}
          </span>
          <span>
            <strong class="text-up">${Math.round(card.buyPct)}% Buy</strong> ·
            <strong class="text-down">${Math.round(100 - card.buyPct)}% Sell</strong> ·
            CVD <strong class="${card.rupeeFlowCr >= 0 ? 'text-up' : 'text-down'}">${card.rupeeFlowCr >= 0 ? '+' : ''}${card.rupeeFlowCr} Cr</strong>
          </span>
        </div>

        <div class="ob-zone-box ${isBull ? 'bull' : 'bear'}">
          <div class="ob-zone-main">
            <span class="ob-zone-title ${isBull ? 'text-up' : 'text-down'}">
              ${isBull ? '🟢 Bullish OB (Buy Zone):' : '🔴 Bearish OB (Sell Zone):'}
              ${plan ? escapeHtml(plan.zoneText) : '—'}
              ${ob ? `(${ob.str}× · ${escapeHtml(ob.timeIST)})` : ''}
            </span>
            ${distBadge}
          </div>
          <div class="ob-zone-levels">
            <span>VWAP: <strong>${fmtINR(card.vwap)}</strong></span>
            <span>POC: <strong>${fmtINR(card.poc)}</strong></span>
            ${plan?.invalidation ? `<span>Ref Inval: <strong>${fmtINR(plan.invalidation)}</strong></span>` : ''}
            ${plan?.target1 ? `<span>Ref T1: <strong>${fmtINR(plan.target1)}</strong></span>` : ''}
          </div>
        </div>

        <div class="fc-actions">
          <div class="fc-remind-group">
            <button type="button" class="btn btn-xs" data-remind-sym="${escapeHtml(card.symbol)}" data-remind-min="5">⏰ +5m</button>
            <button type="button" class="btn btn-xs" data-remind-sym="${escapeHtml(card.symbol)}" data-remind-min="15">⏰ +15m</button>
            <button type="button" class="btn btn-xs" data-track-sym="${escapeHtml(card.symbol)}" data-track-mode="SELL_WATCH" data-track-ltp="${card.ltp}" title="Add to My Tracker for Sell / Step-Back Reminder">🛑 Track Sell</button>
            <button type="button" class="btn btn-xs" data-track-sym="${escapeHtml(card.symbol)}" data-track-mode="BUY_WATCH" data-track-ltp="${card.ltp}" title="Add to My Tracker for Tredye Buy-at-Right-Time">🎯 Track Buy</button>
          </div>
          <div class="fc-remind-group">
            <button type="button" class="btn btn-xs" data-inspect-sym="${escapeHtml(card.symbol)}">📊 Inspect OB Chart</button>
            <a href="https://www.tredye.com/pulse/?view=orderflow" target="_blank" rel="noopener" class="btn btn-ghost btn-xs" onclick="event.stopPropagation()">Tredye ↗</a>
          </div>
        </div>
      </article>
    `;
  }

  function renderTracker(state) {
    const tracker = state.tracker || [];
    const sellCount = tracker.filter(t => t.mode === 'SELL_WATCH').length;
    const buyCount = tracker.filter(t => t.mode === 'BUY_WATCH').length;

    if (els.trackerSellCountBadge) {
      els.trackerSellCountBadge.textContent = `${sellCount} Sell / Step-Back Watch`;
    }
    if (els.trackerBuyCountBadge) {
      els.trackerBuyCountBadge.textContent = `${buyCount} Tredye Buy Watch`;
    }

    // Populate symbol autocomplete from universe
    if (els.symbolSuggestions && state.universe?.length) {
      els.symbolSuggestions.innerHTML = state.universe
        .map(u => `<option value="${escapeHtml(u.symbol)}">${escapeHtml(u.name || '')} (${escapeHtml(u.sector || '')})</option>`)
        .join('');
    }

    if (!els.trackerList) return;
    if (tracker.length === 0) {
      els.trackerList.innerHTML =
        '<div class="empty-state">No stocks in My Tracker yet. Add a stock above (or click "🛑 Track Sell" / "🎯 Track Buy" on any Tredye stock card below) so we alert you when to step back / sell and when to buy back at the right Bullish Order Block.</div>';
      return;
    }

    els.trackerList.innerHTML = tracker
      .map(item => {
        const isSellWatch = item.mode === 'SELL_WATCH';
        const isUrgent = item.verdictCode === 'STEP_BACK_NOW' || item.verdictCode === 'BUY_RIGHT_TIME';
        const tone = item.verdictTone || 'neutral';
        const pnlBadge =
          item.pnlPct !== null && item.pnlPct !== undefined
            ? `<span class="badge ${item.pnlPct >= 0 ? 'badge-up' : 'badge-down'}">P&amp;L ${fmtSignedPct(item.pnlPct)} (Entry ${fmtINR(item.entryPrice)})</span>`
            : item.entryPrice
            ? `<span class="badge badge-neutral">Entry ${fmtINR(item.entryPrice)}</span>`
            : '';

        const modeBadge = isSellWatch
          ? `<span class="badge badge-down">🛑 STEP 1: SELL / STEP-BACK WATCH</span>`
          : `<span class="badge badge-up">🎯 STEP 2: TREDYE BUY-AT-RIGHT-TIME</span>`;

        const verdictCls = `tracker-verdict-box tone-${escapeHtml(tone)} ${isUrgent ? 'urgent-pulse' : ''}`;

        const switchActionBtn = isSellWatch
          ? `<button type="button" class="btn btn-xs btn-switch-buy" data-tracker-switch="BUY_WATCH" data-tracker-sym="${escapeHtml(item.symbol)}" title="I stepped back / sold — now watch Tredye for the right time to BUY back">↪ Stepped Back → Watch to Buy at Right Time</button>`
          : `<button type="button" class="btn btn-xs btn-switch-sell" data-tracker-switch="SELL_WATCH" data-tracker-sym="${escapeHtml(item.symbol)}" data-tracker-ltp="${item.ltp || ''}" title="I bought — now watch for Sell / Step-Back reminder">✅ Bought @ ${fmtINR(item.ltp)} → Watch for Sell Reminder</button>`;

        return `
          <article class="tracker-card mode-${isSellWatch ? 'sell' : 'buy'} ${isUrgent ? 'tracker-urgent-' + tone : ''}" data-symbol="${escapeHtml(item.symbol)}">
            <div class="tc-head">
              <div class="tc-sym-wrap">
                ${modeBadge}
                <span class="fc-symbol">${escapeHtml(item.symbol)}</span>
                <span class="fc-sector">${escapeHtml(item.sector || '')}</span>
                ${pnlBadge}
              </div>
              <div class="fc-price-group">
                <span class="fc-ltp">${fmtINR(item.ltp)}</span>
                <span class="fc-chg ${(item.chgPct || 0) >= 0 ? 'text-up' : 'text-down'}">${fmtSignedPct(item.chgPct)}</span>
              </div>
            </div>

            <div class="${verdictCls}">
              <div class="tv-title">${escapeHtml(item.verdictTitle || 'Monitoring…')}</div>
              <div class="tv-reason">${escapeHtml(item.verdictReason || '')}</div>
            </div>

            <div class="tc-zones-row">
              <div class="tc-zone-pill sell-pill ${isSellWatch ? 'highlighted' : ''}">
                <span class="tc-zone-label">🔴 Sell / Step-Back Zone (Bearish OB / R1):</span>
                <strong>${escapeHtml(item.bearZoneStr || '—')}</strong>
                ${item.targetPrice && isSellWatch ? `<span class="text-muted">· My Target: ${fmtINR(item.targetPrice)}</span>` : ''}
                ${item.stopPrice ? `<span class="text-muted">· Floor: ${fmtINR(item.stopPrice)}</span>` : ''}
              </div>
              <div class="tc-zone-pill buy-pill ${!isSellWatch ? 'highlighted' : ''}">
                <span class="tc-zone-label">🟢 Right-Time Buy Zone (Bullish OB / S1):</span>
                <strong>${escapeHtml(item.bullZoneStr || '—')}</strong>
                ${item.targetPrice && !isSellWatch ? `<span class="text-muted">· My Buy Target: ${fmtINR(item.targetPrice)}</span>` : ''}
              </div>
            </div>

            <div class="fc-metrics-row">
              <span class="strength-pill">
                Tredye Flow: <span class="${item.side === 'BULL' ? 'text-up' : item.side === 'BEAR' ? 'text-down' : ''}">${escapeHtml(item.side || 'FLAT')} (${item.agree ?? 0}/${item.totalChecks ?? 5})</span>
                ${item.found ? renderConfluenceDots(item.agree, item.totalChecks, item.side) : ''}
              </span>
              <span>
                <strong class="text-up">${Math.round(item.buyPct || 50)}% Buy</strong> ·
                <strong class="text-down">${Math.round(100 - (item.buyPct || 50))}% Sell</strong> ·
                CVD <strong class="${(item.rupeeFlowCr || 0) >= 0 ? 'text-up' : 'text-down'}">${(item.rupeeFlowCr || 0) >= 0 ? '+' : ''}${item.rupeeFlowCr ?? 0} Cr</strong> ·
                VWAP <strong>${fmtINR(item.vwap)}</strong>
              </span>
            </div>

            ${item.notes ? `<div class="tc-notes">📝 ${escapeHtml(item.notes)}</div>` : ''}

            <div class="tc-actions">
              <div class="fc-remind-group">
                ${switchActionBtn}
              </div>
              <div class="fc-remind-group">
                <button type="button" class="btn btn-xs" data-inspect-sym="${escapeHtml(item.symbol)}">📊 Inspect OB</button>
                <button type="button" class="btn btn-xs" data-remind-sym="${escapeHtml(item.symbol)}" data-remind-min="15">⏰ +15m</button>
                <button type="button" class="btn btn-ghost btn-xs" data-tracker-remove="${escapeHtml(item.symbol)}" title="Remove from My Tracker">✕</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  function renderTopFlows(state) {
    els.bullCountBadge.textContent = `Top ${state.topBull?.length || 0}`;
    els.bearCountBadge.textContent = `Top ${state.topBear?.length || 0}`;

    els.topBullList.innerHTML =
      state.topBull?.length > 0
        ? state.topBull.map(buildFlowCardHtml).join('')
        : '<div class="empty-state">No bullish flow stocks match current filters.</div>';

    els.topBearList.innerHTML =
      state.topBear?.length > 0
        ? state.topBear.map(buildFlowCardHtml).join('')
        : '<div class="empty-state">No bearish flow stocks match current filters.</div>';
  }

  function renderCandlestickSvg(detailData) {
    const candles = detailData.candles || [];
    if (!candles.length) {
      return '<div class="empty-state">No intraday candles available for this symbol.</div>';
    }

    const stock = detailData.stock;
    const obs = detailData.obInfo?.allOBs || [];
    const levels = (detailData.levels || []).filter(l => l.kind === 's' || l.kind === 'r');

    const W = 900;
    const H = 310;
    const padTop = 14;
    const padBot = 24;
    const rightAxisW = 110;
    const plotW = W - rightAxisW;

    const minLow = Math.min(...candles.map(c => c[3]), ...(obs.map(o => o.bot)));
    const maxHigh = Math.max(...candles.map(c => c[2]), ...(obs.map(o => o.top)));
    const span = (maxHigh - minLow) || 1;
    const lo = minLow - span * 0.08;
    const hi = maxHigh + span * 0.08;

    const yOf = p => padTop + (1 - (p - lo) / (hi - lo || 1)) * (H - padTop - padBot);
    const slotW = plotW / candles.length;
    const xOf = i => i * slotW + slotW / 2;

    // Running VWAP curve (matching Tredye's sx() chart)
    let cumPV = 0;
    let cumV = 0;
    const vwapPts = candles
      .map((c, idx) => {
        const typ = (c[2] + c[3] + c[4]) / 3;
        cumPV += typ * c[5];
        cumV += c[5];
        const vwapVal = cumV ? cumPV / cumV : c[4];
        return `${xOf(idx).toFixed(1)},${yOf(vwapVal).toFixed(1)}`;
      })
      .join(' ');

    // Value Area box (VAH - VAL)
    const vahY = yOf(stock.vah || maxHigh);
    const valY = yOf(stock.val || minLow);
    const pocY = yOf(stock.poc || stock.ltp);

    // Order Block shaded zones (extended to right edge so user clearly sees entry zones!)
    const obRects = obs
      .map(ob => {
        const xStart = Math.max(0, xOf(ob.i) - slotW / 2);
        const yTop = yOf(ob.top);
        const yBot = yOf(ob.bot);
        const rectH = Math.max(4, yBot - yTop);
        const fill = ob.bull ? 'rgba(16, 185, 129, 0.22)' : 'rgba(244, 63, 94, 0.22)';
        const stroke = ob.bull ? '#10b981' : '#f43f5e';
        const dash = ob.mit && ob.status !== 'IN_ZONE' ? 'stroke-dasharray="4 3"' : '';
        const label = `${ob.bull ? 'BUY OB ▲' : 'SELL OB ▼'} ₹${ob.bot}–${ob.top} (${ob.str}×)`;
        return `
          <g>
            <rect x="${xStart.toFixed(1)}" y="${yTop.toFixed(1)}" width="${(plotW - xStart).toFixed(1)}" height="${rectH.toFixed(1)}"
                  fill="${fill}" stroke="${stroke}" stroke-width="1.3" ${dash} />
            <text x="${(xStart + 6).toFixed(1)}" y="${(yTop + 11).toFixed(1)}" fill="${stroke}" font-size="10" font-weight="700">
              ${escapeHtml(label)}
            </text>
          </g>
        `;
      })
      .join('');

    // Support / Resistance horizontal lines
    const srLines = levels
      .filter(l => l.price >= lo && l.price <= hi)
      .map(l => {
        const y = yOf(l.price);
        const color = l.kind === 's' ? '#10b981' : '#f43f5e';
        return `
          <line x1="0" x2="${plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-opacity="0.45" stroke-dasharray="3 4" stroke-width="1" />
          <text x="${plotW + 6}" y="${(y + 3).toFixed(1)}" fill="${color}" font-size="10" font-weight="600">${escapeHtml(l.label)} ${l.price.toFixed(1)}</text>
        `;
      })
      .join('');

    // Candles
    const candleG = candles
      .map((c, idx) => {
        const isUp = c[4] >= c[1];
        const color = isUp ? '#10b981' : '#f43f5e';
        const x = xOf(idx);
        const yHigh = yOf(c[2]);
        const yLow = yOf(c[3]);
        const yBodyTop = yOf(Math.max(c[1], c[4]));
        const yBodyBot = yOf(Math.min(c[1], c[4]));
        const bodyH = Math.max(2, yBodyBot - yBodyTop);
        const bodyW = Math.max(3, slotW * 0.62);
        return `
          <g>
            <line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${yHigh.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1.2" />
            <rect x="${(x - bodyW / 2).toFixed(1)}" y="${yBodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" rx="1" />
          </g>
        `;
      })
      .join('');

    // Current LTP line
    const ltpY = yOf(stock.ltp);

    // CVD sparkline
    const cvdVals = candles.map(c => c[7]);
    const minCvd = Math.min(0, ...cvdVals);
    const maxCvd = Math.max(0, ...cvdVals);
    const yCvd = v => 6 + (1 - (v - minCvd) / (maxCvd - minCvd || 1)) * 48;
    const cvdPoints = cvdVals.map((v, idx) => `${xOf(idx).toFixed(1)},${yCvd(v).toFixed(1)}`).join(' ');
    const cvdColor = stock.cvd >= 0 ? '#10b981' : '#f43f5e';

    return `
      <div class="chart-box">
        <svg viewBox="0 0 ${W} ${H}" class="candle-svg" role="img" aria-label="${escapeHtml(stock.symbol)} candles and order blocks">
          <!-- Value Area VAH..VAL -->
          <rect x="0" y="${vahY.toFixed(1)}" width="${plotW}" height="${Math.max(2, valY - vahY).toFixed(1)}" fill="rgba(99, 102, 241, 0.07)" />
          <!-- POC line -->
          <line x1="0" x2="${plotW}" y1="${pocY.toFixed(1)}" y2="${pocY.toFixed(1)}" stroke="#f59e0b" stroke-dasharray="6 4" stroke-width="1.2" />
          <text x="${plotW + 6}" y="${(pocY + 3).toFixed(1)}" fill="#f59e0b" font-size="10" font-weight="700">POC ${stock.poc.toFixed(1)}</text>
          ${srLines}
          ${obRects}
          <!-- Running VWAP -->
          <polyline points="${vwapPts}" fill="none" stroke="#94a3b8" stroke-dasharray="3 3" stroke-width="1.4" />
          ${candleG}
          <!-- LTP tag -->
          <line x1="0" x2="${plotW}" y1="${ltpY.toFixed(1)}" y2="${ltpY.toFixed(1)}" stroke="#6366f1" stroke-width="1" />
          <rect x="${plotW + 2}" y="${(ltpY - 8).toFixed(1)}" width="104" height="16" rx="3" fill="#6366f1" />
          <text x="${plotW + 7}" y="${(ltpY + 3).toFixed(1)}" fill="#ffffff" font-size="10" font-weight="700">LTP ₹${stock.ltp.toFixed(2)}</text>
        </svg>

        <svg viewBox="0 0 ${W} 60" class="cvd-svg" aria-label="Cumulative volume delta">
          <line x1="0" x2="${plotW}" y1="${yCvd(0).toFixed(1)}" y2="${yCvd(0).toFixed(1)}" stroke="rgba(148,163,184,0.25)" stroke-width="1" />
          <polyline points="${cvdPoints}" fill="none" stroke="${cvdColor}" stroke-width="2" />
          <text x="6" y="14" fill="#94a3b8" font-size="10">Cumulative Delta (CVD)</text>
        </svg>

        <div class="chart-legend">
          <span>🟢 <strong>Bullish OB (Buy Zone):</strong> Last down candle before strong impulse breaking structure</span>
          <span>🔴 <strong>Bearish OB (Sell Zone):</strong> Last up candle before strong breakdown</span>
          <span>🟡 <strong>Dashed Amber:</strong> Point of Control (POC)</span>
          <span>⚪ <strong>Dotted Grey:</strong> Session VWAP</span>
        </div>
      </div>
    `;
  }

  async function selectAndInspectSymbol(symbol) {
    if (!symbol) return;
    selectedSymbol = symbol.toUpperCase();
    els.quickReminderSymbol.value = selectedSymbol;

    // Highlight active card
    document.querySelectorAll('.flow-card').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-symbol') === selectedSymbol);
    });

    try {
      const res = await fetch(`/api/stock/${encodeURIComponent(selectedSymbol)}`);
      if (!res.ok) return;
      const detail = await res.json();

      const { stock, flow, obInfo } = detail;
      const isBull = flow?.side === 'BULL';
      const plan = obInfo?.referencePlan;
      const primaryOB = obInfo?.primaryOB;

      els.inspectorTitle.innerHTML = `
        <span>${escapeHtml(stock.symbol)} · ${escapeHtml(stock.name || '')}</span>
        <span class="badge ${isBull ? 'badge-up' : flow?.side === 'BEAR' ? 'badge-down' : 'badge-neutral'}">
          ${escapeHtml(flow?.tag || flow?.side || '')} (${flow?.agree || 0}/${flow?.n || 5})
        </span>
      `;
      els.inspectorSub.textContent = `${detail.candleMin || 3}-minute order-flow candles · Strength ${flow?.strengthScore || 0}/100 · Net Rupee CVD ${flow?.rupeeFlowCr >= 0 ? '+' : ''}${(flow?.rupeeFlowCr || 0).toFixed(2)} Cr`;

      els.inspectorQuickActions.innerHTML = `
        <button type="button" class="btn btn-sm" data-remind-sym="${escapeHtml(stock.symbol)}" data-remind-min="5">⏰ Remind 5m</button>
        <button type="button" class="btn btn-sm" data-remind-sym="${escapeHtml(stock.symbol)}" data-remind-min="15">⏰ Remind 15m</button>
        <button type="button" class="btn btn-sm" data-remind-sym="${escapeHtml(stock.symbol)}" data-remind-min="30">⏰ Remind 30m</button>
        <button type="button" class="btn btn-sm" data-snooze-sym="${escapeHtml(stock.symbol)}">🔕 Snooze 30m</button>
      `;

      const allOBBadges = (obInfo?.allOBs || [])
        .map(ob => {
          const cls = ob.bull ? 'badge-up' : 'badge-down';
          return `<span class="badge ${cls}">OB ${ob.bull ? '▲ BUY' : '▼ SELL'} ₹${ob.bot}–₹${ob.top} · ${ob.timeIST} · ${ob.status} (${ob.str}×)</span>`;
        })
        .join(' ');

      els.inspectorBody.innerHTML = `
        <div class="inspector-grid">
          ${renderCandlestickSvg(detail)}
          <div class="inspector-side-cards">
            <div class="ob-zone-box ${isBull ? 'bull' : 'bear'}">
              <div class="ob-zone-title ${isBull ? 'text-up' : 'text-down'}">
                ${plan ? escapeHtml(plan.action) : 'Order Block Reference'}
              </div>
              <div style="font-size:1.05rem;font-weight:800;margin:0.15rem 0;">
                ${plan ? escapeHtml(plan.zoneText) : 'No unmitigated OB'}
              </div>
              <div class="ob-zone-levels">
                <span>Status: <strong>${escapeHtml(primaryOB?.status || '—')}</strong></span>
                <span>Distance: <strong>${primaryOB?.distPct === 0 ? 'IN ZONE' : primaryOB?.distPct != null ? `${primaryOB.distPct}%` : '—'}</strong></span>
                <span>Impulse: <strong>${primaryOB?.str ? `${primaryOB.str}× avg range` : '—'}</strong></span>
              </div>
              <hr class="form-divider">
              <div class="ob-zone-levels">
                <span>Ref Invalidation: <strong>${fmtINR(plan?.invalidation)}</strong></span>
                <span>Ref Target 1: <strong>${fmtINR(plan?.target1)}</strong></span>
                <span>Ref Target 2: <strong>${fmtINR(plan?.target2)}</strong></span>
              </div>
            </div>

            <div class="detail-kv-grid">
              <div class="detail-kv">
                <span class="detail-kv-label">Last Traded Price</span>
                <span class="detail-kv-val">${fmtINR(stock.ltp)} (${fmtSignedPct(stock.chg_pct)})</span>
              </div>
              <div class="detail-kv">
                <span class="detail-kv-label">Aggressive Buy / Sell</span>
                <span class="detail-kv-val"><span class="text-up">${Math.round(stock.buy_pct)}%</span> / <span class="text-down">${Math.round(100 - stock.buy_pct)}%</span></span>
              </div>
              <div class="detail-kv">
                <span class="detail-kv-label">VWAP / POC</span>
                <span class="detail-kv-val">${fmtINR(stock.vwap)} / ${fmtINR(stock.poc)}</span>
              </div>
              <div class="detail-kv">
                <span class="detail-kv-label">Value Area (VAL–VAH)</span>
                <span class="detail-kv-val">${fmtINR(stock.val, 0)}–${fmtINR(stock.vah, 0)}</span>
              </div>
            </div>

            <div>
              <div style="font-size:0.72rem;font-weight:700;margin-bottom:0.35rem;color:var(--text-muted);">
                Session Order Blocks (${(obInfo?.allOBs || []).length}):
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:0.35rem;">
                ${allOBBadges || '<span class="text-muted" style="font-size:0.74rem;">None detected in current window</span>'}
              </div>
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      console.error('Failed to load stock detail:', err);
    }
  }

  function renderReminders(reminders = []) {
    els.reminderCountBadge.textContent = `${reminders.length} pending`;
    if (!reminders.length) {
      els.pendingRemindersList.innerHTML =
        '<div class="empty-state">No active timers. Tap "⏰ +15m" on any stock or alert to re-verify its Order Block later.</div>';
      return;
    }

    const now = Date.now();
    els.pendingRemindersList.innerHTML = reminders
      .map(r => {
        const remSec = Math.max(0, Math.round((r.dueAt - now) / 1000));
        const mins = Math.floor(remSec / 60);
        const secs = remSec % 60;
        const zoneTxt = r.obBot && r.obTop ? ` · OB ₹${r.obBot}–${r.obTop}` : '';
        return `
          <div class="reminder-item">
            <div>
              <strong>${escapeHtml(r.symbol)}</strong>
              <span class="badge ${r.expectedSide === 'BEAR' ? 'badge-down' : 'badge-up'}">${escapeHtml(r.expectedSide || 'FLOW')}</span>
              <span style="color:var(--text-muted);">${escapeHtml(zoneTxt)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:0.4rem;">
              <span class="badge badge-neutral">in ${mins}m ${String(secs).padStart(2, '0')}s</span>
              <button type="button" class="btn btn-ghost btn-xs" data-cancel-rem="${r.id}" title="Cancel timer">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderAlerts(alerts = []) {
    const filtered =
      activeAlertFilter === 'ALL'
        ? alerts
        : activeAlertFilter === 'TRACKER'
        ? alerts.filter(a => a.type === 'TRACKER_SELL' || a.type === 'TRACKER_BUY')
        : alerts.filter(a => a.type === activeAlertFilter);

    if (!filtered.length) {
      els.alertsFeed.innerHTML =
        '<div class="empty-state">No alerts in this view yet. Strong flow &amp; Order Block proximity alerts appear here automatically.</div>';
      return;
    }

    els.alertsFeed.innerHTML = filtered
      .map(a => {
        const timeStr = new Date(a.createdAt).toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        return `
          <div class="alert-card priority-${escapeHtml(a.priority)} side-${escapeHtml(a.side)} ${a.reviewed ? 'reviewed' : ''}" data-symbol="${escapeHtml(a.symbol)}">
            <div class="alert-title-row">
              <span class="alert-title">${escapeHtml(a.title)}</span>
              <span class="alert-time">${escapeHtml(timeStr)}</span>
            </div>
            <p class="alert-msg">${escapeHtml(a.message)}</p>
            <div class="alert-actions">
              <button type="button" class="btn btn-xs" data-inspect-sym="${escapeHtml(a.symbol)}">📊 Inspect OB</button>
              <button type="button" class="btn btn-xs" data-remind-sym="${escapeHtml(a.symbol)}" data-remind-min="5">⏰ 5m</button>
              <button type="button" class="btn btn-xs" data-remind-sym="${escapeHtml(a.symbol)}" data-remind-min="15">⏰ 15m</button>
              <button type="button" class="btn btn-xs" data-snooze-sym="${escapeHtml(a.symbol)}">🔕 Snooze</button>
              ${
                !a.reviewed
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-review-id="${a.id}">✓ Reviewed</button>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderAll(state) {
    appState = state;
    renderHeaderAndBanner(state);
    renderSectorRibbon(state.sectors);
    renderTracker(state);
    renderTopFlows(state);
    renderReminders(state.reminders);
    renderAlerts(state.alerts);

    if (!selectedSymbol) {
      const first = state.tracker?.[0]?.symbol || state.topBull?.[0]?.symbol || state.topBear?.[0]?.symbol;
      if (first) selectAndInspectSymbol(first);
    } else {
      selectAndInspectSymbol(selectedSymbol);
    }
  }

  // Event delegation for stock cards, tracker cards, reminders, snooze, inspect
  document.body.addEventListener('click', async e => {
    const trackBtn = e.target.closest('[data-track-sym]');
    if (trackBtn) {
      e.stopPropagation();
      const symbol = trackBtn.getAttribute('data-track-sym');
      const mode = trackBtn.getAttribute('data-track-mode') || 'SELL_WATCH';
      const ltp = Number(trackBtn.getAttribute('data-track-ltp') || 0) || null;
      await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          mode,
          entryPrice: mode === 'SELL_WATCH' ? ltp : null,
        }),
      });
      showToast({
        title: mode === 'SELL_WATCH' ? `🛑 Added ${symbol} to Sell / Step-Back Watch` : `🎯 Added ${symbol} to Tredye Buy Watch`,
        message:
          mode === 'SELL_WATCH'
            ? `Monitoring ${symbol} for Bearish Order Blocks & BEAR flow so you can step back in time.`
            : `Monitoring ${symbol} for Bullish Order Blocks & BULL flow so you can buy at the right time.`,
        side: mode === 'SELL_WATCH' ? 'BEAR' : 'BULL',
      });
      return;
    }

    const switchBtn = e.target.closest('[data-tracker-switch]');
    if (switchBtn) {
      e.stopPropagation();
      const symbol = switchBtn.getAttribute('data-tracker-sym');
      const mode = switchBtn.getAttribute('data-tracker-switch');
      const ltp = Number(switchBtn.getAttribute('data-tracker-ltp') || 0) || null;
      await fetch('/api/tracker/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          mode,
          entryPrice: mode === 'SELL_WATCH' && ltp ? ltp : undefined,
        }),
      });
      showToast({
        title:
          mode === 'BUY_WATCH'
            ? `↪ ${symbol} Switched to Tredye Buy-at-Right-Time`
            : `✅ ${symbol} Switched to Sell / Step-Back Watch`,
        message:
          mode === 'BUY_WATCH'
            ? `You stepped back on ${symbol}. Now watching Tredye for Bullish Order Block + BULL flow re-entry.`
            : `Now watching ${symbol} for Bearish Order Block or flow flip to remind you when to step back.`,
        side: mode === 'BUY_WATCH' ? 'BULL' : 'BEAR',
      });
      return;
    }

    const removeTrBtn = e.target.closest('[data-tracker-remove]');
    if (removeTrBtn) {
      e.stopPropagation();
      const symbol = removeTrBtn.getAttribute('data-tracker-remove');
      await fetch(`/api/tracker/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      showToast({
        title: `Removed ${symbol} from My Tracker`,
        message: `${symbol} is no longer in your personal tracker.`,
      });
      return;
    }

    const remindBtn = e.target.closest('[data-remind-sym]');
    if (remindBtn) {
      e.stopPropagation();
      const symbol = remindBtn.getAttribute('data-remind-sym');
      const minutes = Number(remindBtn.getAttribute('data-remind-min') || 15);
      await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, minutes }),
      });
      showToast({
        title: `⏰ Reminder Set: ${symbol}`,
        message: `Will re-check ${symbol} Order Flow & OB zone in ${minutes} min with fresh data.`,
        side: 'BULL',
      });
      return;
    }

    const inspectBtn = e.target.closest('[data-inspect-sym]');
    if (inspectBtn) {
      e.stopPropagation();
      const sym = inspectBtn.getAttribute('data-inspect-sym');
      await selectAndInspectSymbol(sym);
      document.getElementById('inspectorPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const cancelRemBtn = e.target.closest('[data-cancel-rem]');
    if (cancelRemBtn) {
      const id = cancelRemBtn.getAttribute('data-cancel-rem');
      await fetch(`/api/reminders/${id}`, { method: 'DELETE' });
      return;
    }

    const snoozeBtn = e.target.closest('[data-snooze-sym]');
    if (snoozeBtn) {
      e.stopPropagation();
      const symbol = snoozeBtn.getAttribute('data-snooze-sym');
      await fetch('/api/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, minutes: 30 }),
      });
      showToast({
        title: `🔕 Snoozed ${symbol}`,
        message: `Alerts for ${symbol} paused for 30 minutes.`,
      });
      return;
    }

    const reviewBtn = e.target.closest('[data-review-id]');
    if (reviewBtn) {
      e.stopPropagation();
      const id = reviewBtn.getAttribute('data-review-id');
      await fetch(`/api/alerts/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed: true }),
      });
      return;
    }

    const cardEl = e.target.closest('.flow-card, .tracker-card');
    if (cardEl) {
      const sym = cardEl.getAttribute('data-symbol');
      if (sym) selectAndInspectSymbol(sym);
    }
  });

  if (els.trackerAddForm) {
    els.trackerAddForm.addEventListener('submit', async e => {
      e.preventDefault();
      const symbol = els.trSymbol.value.trim().toUpperCase();
      if (!symbol) return;
      const mode = els.trMode.value || 'SELL_WATCH';
      const entryPrice = els.trEntryPrice.value ? Number(els.trEntryPrice.value) : null;
      const targetPrice = els.trTargetPrice.value ? Number(els.trTargetPrice.value) : null;
      const stopPrice = els.trStopPrice.value ? Number(els.trStopPrice.value) : null;
      const notes = els.trNotes.value.trim() || null;

      await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          mode,
          entryPrice,
          targetPrice,
          stopPrice,
          notes,
        }),
      });

      els.trSymbol.value = '';
      els.trEntryPrice.value = '';
      els.trTargetPrice.value = '';
      els.trStopPrice.value = '';
      els.trNotes.value = '';

      showToast({
        title:
          mode === 'SELL_WATCH'
            ? `🛑 Added ${symbol} — Sell / Step-Back Reminder`
            : `🎯 Added ${symbol} — Tredye Buy-at-Right-Time`,
        message:
          mode === 'SELL_WATCH'
            ? `We'll alert you when ${symbol} hits a Bearish OB, R1 resistance, or BEAR flow so you can step back.`
            : `We'll alert you when ${symbol} pulls into a Bullish OB with Tredye BULL flow so you can buy at the right time.`,
        side: mode === 'SELL_WATCH' ? 'BEAR' : 'BULL',
      });
    });
  }

  // Filter tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAlertFilter = btn.getAttribute('data-filter') || 'ALL';
      if (appState) renderAlerts(appState.alerts);
    });
  });

  // Topbar Zoom / Density Controls (works alongside native browser Cmd- / Cmd+ zoom)
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const zoomResetBtn = document.getElementById('zoomResetBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  let uiZoomPct = Number(localStorage.getItem('tredye_ui_zoom_pct') || 100);

  function applyUiZoom(pct) {
    uiZoomPct = Math.max(60, Math.min(140, Math.round(pct)));
    localStorage.setItem('tredye_ui_zoom_pct', String(uiZoomPct));
    document.documentElement.style.zoom = `${uiZoomPct}%`;
    if (zoomResetBtn) zoomResetBtn.textContent = `${uiZoomPct}%`;
  }
  applyUiZoom(uiZoomPct);

  zoomOutBtn?.addEventListener('click', () => applyUiZoom(uiZoomPct - 10));
  zoomResetBtn?.addEventListener('click', () => applyUiZoom(100));
  zoomInBtn?.addEventListener('click', () => applyUiZoom(uiZoomPct + 10));

  // Topbar Buttons
  els.pollNowBtn.addEventListener('click', async () => {
    els.pollNowBtn.disabled = true;
    els.pollNowBtn.textContent = '↻ Syncing…';
    try {
      await fetch('/api/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } finally {
      els.pollNowBtn.disabled = false;
      els.pollNowBtn.textContent = '↻ Sync Now';
    }
  });

  els.testNotifyBtn.addEventListener('click', async () => {
    await fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: selectedSymbol }),
    });
  });

  const openCredModal = () => {
    if (appState?.configuredEmail) {
      document.getElementById('credEmail').value = appState.configuredEmail;
    }
    els.credStatusMsg.textContent = '';
    els.credentialsDialog.showModal();
  };
  els.openCredentialsBtn.addEventListener('click', openCredModal);
  els.bannerConnectBtn.addEventListener('click', openCredModal);

  els.openSettingsBtn.addEventListener('click', () => {
    const cfg = appState?.config || {};
    const pollInput = document.getElementById('cfgPollInterval');
    if (pollInput) pollInput.value = cfg.pollIntervalSec ?? 60;
    document.getElementById('cfgTopN').value = cfg.topN ?? 5;
    document.getElementById('cfgMinAgree').value = cfg.minAgree ?? 4;
    document.getElementById('cfgObProx').value = cfg.obProximityPct ?? 0.5;
    document.getElementById('cfgCooldown').value = cfg.cooldownMinutes ?? 20;
    document.getElementById('cfgConfirmPolls').value = cfg.confirmPolls ?? 2;
    document.getElementById('cfgMinPrice').value = cfg.minPrice ?? 0;
    document.getElementById('cfgWatchlist').value = (cfg.watchlist || []).join(', ');
    document.getElementById('cfgIgnore').value = (cfg.ignoreSymbols || []).join(', ');
    els.settingsDialog.showModal();
  });

  els.credentialsForm.addEventListener('submit', async e => {
    e.preventDefault();
    els.credStatusMsg.textContent = 'Connecting to Tredye…';
    const payload = {
      email: document.getElementById('credEmail').value.trim(),
      password: document.getElementById('credPassword').value,
      cookie: document.getElementById('credCookie').value.trim(),
      telegramBotToken: document.getElementById('credTgToken').value.trim(),
      telegramChatId: document.getElementById('credTgChat').value.trim(),
    };
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      els.credStatusMsg.style.color = 'var(--down)';
      els.credStatusMsg.textContent = data.error || 'Could not authenticate with Tredye';
      return;
    }
    els.credentialsDialog.close();
    showToast({
      title: '✅ Tredye Credentials Saved',
      message: 'Session updated and order flow synced.',
      side: 'BULL',
    });
  });

  els.settingsForm.addEventListener('submit', async e => {
    e.preventDefault();
    const splitList = str =>
      String(str || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const payload = {
      pollIntervalSec: Number(document.getElementById('cfgPollInterval')?.value || 60),
      topN: Number(document.getElementById('cfgTopN').value),
      minAgree: Number(document.getElementById('cfgMinAgree').value),
      obProximityPct: Number(document.getElementById('cfgObProx').value),
      cooldownMinutes: Number(document.getElementById('cfgCooldown').value),
      confirmPolls: Number(document.getElementById('cfgConfirmPolls').value),
      minPrice: Number(document.getElementById('cfgMinPrice').value),
      watchlist: splitList(document.getElementById('cfgWatchlist').value),
      ignoreSymbols: splitList(document.getElementById('cfgIgnore').value),
    };
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    els.settingsDialog.close();
    await fetch('/api/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    showToast({
      title: '⚙ Rules Updated',
      message: `Every ${payload.pollIntervalSec}s · Top ${payload.topN}/side · ≥${payload.minAgree}/5 signals · OB within ${payload.obProximityPct}%.`,
    });
  });

  els.quickReminderForm.addEventListener('submit', async e => {
    e.preventDefault();
    const symbol = els.quickReminderSymbol.value.trim().toUpperCase();
    const minutes = Number(els.quickReminderMin.value || 15);
    if (!symbol) return;
    await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, minutes }),
    });
    showToast({
      title: `⏰ Reminder Scheduled: ${symbol}`,
      message: `We'll re-verify ${symbol}'s flow & Order Block in ${minutes} minutes.`,
    });
  });

  els.markAllReviewedBtn.addEventListener('click', async () => {
    await fetch('/api/alerts/review-all', { method: 'POST' });
  });

  // Update countdown timer display every second
  setInterval(() => {
    updatePollMetaDisplay();
    if (appState?.reminders?.length) {
      renderReminders(appState.reminders);
    }
  }, 1000);

  // Initial state load + SSE subscription
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
  es.addEventListener('alert', ev => {
    try {
      const a = JSON.parse(ev.data);
      showToast({
        title: a.title,
        message: a.message,
        side: a.side,
        durationMs: 7500,
      });
    } catch {}
  });
  es.addEventListener('toast', ev => {
    try {
      const t = JSON.parse(ev.data);
      showToast(t);
    } catch {}
  });
})();

