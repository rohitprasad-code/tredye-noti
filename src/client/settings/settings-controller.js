(function () {
  'use strict';

  const linkError = (el, shown) => {
    const errorId = el.dataset?.error;
    if (!errorId) return;
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter(id => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  };

  // Single polite live-region announcer for field errors (validate-input-after-interaction)
  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.classList.add('visually-hidden');
  document.body.append(announcer);
  let announceTimer;
  let announcedField;

  const spokenText = node => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
    copy
      .querySelectorAll('[role="img"][aria-label]')
      .forEach(n => n.replaceWith(`${n.getAttribute('aria-label')}: `));
    return copy.textContent.replace(/\s+/g, ' ').trim();
  };

  const announceError = el => {
    const errEl = el.dataset?.error ? document.getElementById(el.dataset.error) : null;
    if (!errEl) return;
    const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announcedField = el;
    announceTimer = setTimeout(() => {
      announcer.textContent = label + spokenText(errEl);
    }, 500);
  };

  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
  const supportsHas = CSS.supports('selector(:has(a))');
  const dirtyState = new WeakMap();
  const flagged = new WeakSet();
  const announced = new WeakSet();

  const updateFallbackClasses = (input, isInvalid) => {
    if (!supportsUserInvalid) {
      input.classList.toggle('user-invalid-fallback', isInvalid);
      input.classList.toggle('user-valid-fallback', !isInvalid);
    }
    if (!supportsHas) {
      for (const selector of ['.field', '.card-section']) {
        const container = input.closest(selector);
        if (container) {
          const anyErr = container.querySelector(':is(:user-invalid, .user-invalid-fallback)');
          container.classList.toggle('has-error-fallback', Boolean(anyErr));
        }
      }
    }
  };

  const syncAria = (el, announce = false, forceInvalid = false) => {
    if (!el.matches?.('input, select, textarea')) return;
    const isInvalid =
      forceInvalid ||
      (supportsUserInvalid ? el.matches(':user-invalid') : el.classList.contains('user-invalid-fallback'));
    if (isInvalid) {
      if (announce && !announced.has(el)) {
        announceError(el);
        announced.add(el);
      }
      el.setAttribute('aria-invalid', 'true');
      linkError(el, true);
      flagged.add(el);
    } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
      el.setAttribute('aria-invalid', 'false');
      linkError(el, false);
      flagged.delete(el);
      announced.delete(el);
      if (announcedField === el) {
        clearTimeout(announceTimer);
        announcer.textContent = '';
      }
    }
  };

  const initValidation = () => {
    document.querySelectorAll('input, select, textarea').forEach(el => {
      el.setAttribute('aria-invalid', 'false');
    });

    if (!supportsUserInvalid) {
      const handleFallback = event => {
        const input = event.target;
        if (!input?.checkValidity) return;
        if (event.type === 'invalid') {
          dirtyState.set(input, { hasInteracted: true, hasBlurred: true });
          updateFallbackClasses(input, !input.validity.valid);
          return;
        }
        const state = dirtyState.get(input) || { hasInteracted: false, hasBlurred: false };
        if (event.type === 'input' || event.type === 'change') {
          state.hasInteracted = true;
          dirtyState.set(input, state);
          if (state.hasBlurred) updateFallbackClasses(input, !input.validity.valid);
        } else if (event.type === 'blur') {
          state.hasBlurred = true;
          dirtyState.set(input, state);
          if (state.hasInteracted) updateFallbackClasses(input, !input.validity.valid);
        }
      };
      document.addEventListener('blur', handleFallback, true);
      document.addEventListener('input', handleFallback);
      document.addEventListener('change', handleFallback);
      document.addEventListener('invalid', handleFallback, true);
    }

    document.addEventListener('blur', e => syncAria(e.target, true), true);
    document.addEventListener('input', e => {
      if (e.target.hasAttribute?.('aria-invalid')) syncAria(e.target, false);
    });
    document.addEventListener('change', e => syncAria(e.target, true), true);
    document.addEventListener(
      'invalid',
      e => {
        announced.add(e.target);
        syncAria(e.target, false, true);
      },
      true
    );
  };

  let upstoxSaved = false;

  const setFormStatus = (el, text, kind = '') => {
    if (!el) return;
    el.className = 'form-status' + (kind ? ` ${kind}` : '');
    el.textContent = text;
  };

  const validateFormOrFocus = form => {
    if (form.checkValidity()) return true;
    const firstInvalid = form.querySelector(':invalid');
    if (firstInvalid) {
      updateFallbackClasses(firstInvalid, true);
      syncAria(firstInvalid, false, true);
      firstInvalid.focus();
    }
    return false;
  };

  const bindSecretToggle = (btnId, inputId, label) => {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return null;
    const setVisible = visible => {
      input.type = visible ? 'text' : 'password';
      btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      btn.setAttribute('aria-label', visible ? `Hide ${label}` : `Show ${label}`);
      btn.textContent = visible ? 'Hide' : 'Show';
    };
    btn.addEventListener('click', () => setVisible(input.type !== 'text'));
    return { input, reset: () => setVisible(false) };
  };

  const formatIstTimestamp = ms => {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const renderUpstoxStatus = u => {
    const section = document.getElementById('upstoxSection');
    const badge = document.getElementById('upstoxStatusBadge');
    const metaEl = document.getElementById('upstoxTokenMeta');
    const keysPill = document.getElementById('oauthKeysSummaryPill');
    const redirEl = document.getElementById('upstoxRedirectCode');
    const tokenInput = document.getElementById('upstoxAnalyticsToken');
    const keyInput = document.getElementById('upstoxApiKey');
    const secretInput = document.getElementById('upstoxApiSecret');
    const connectBtn = document.getElementById('upstoxConnectBtn');
    const disBtn = document.getElementById('upstoxDisconnectBtn');

    if (redirEl && u.redirectUri) redirEl.textContent = u.redirectUri;
    if (keyInput && u.apiKeyPreview && u.hasApiKey) {
      keyInput.placeholder = `Saved (${u.apiKeyPreview}) — leave blank to keep`;
    }
    if (secretInput && u.configured) {
      secretInput.placeholder = 'Saved on server — leave blank to keep';
    }
    if (keysPill) {
      keysPill.className = 'summary-pill' + (u.configured ? ' ok' : '');
      keysPill.textContent = u.configured
        ? `Keys saved${u.apiKeyPreview ? ' (' + u.apiKeyPreview + ')' : ''}`
        : 'Not set';
    }
    if (connectBtn) {
      connectBtn.textContent = u.configured ? 'Login Today with Saved Keys' : 'Save Keys & Login with Upstox';
    }
    if (tokenInput) {
      const hasAnalyticsToken = Boolean(u.connected && u.tokenType === 'analytics');
      tokenInput.placeholder = hasAnalyticsToken
        ? 'Active 1-Year Analytics Token saved (paste a new one to replace)'
        : 'Paste 1-Year Analytics Token';
      tokenInput.required = !hasAnalyticsToken;
      const reqStar = document.getElementById('analyticsReqStar');
      if (reqStar) reqStar.hidden = hasAnalyticsToken;
    }

    if (section) section.classList.toggle('is-connected', Boolean(u.connected));

    if (badge) {
      let badgeCls = 'status-pill';
      let badgeText = 'Not connected';
      if (u.connected) {
        badgeCls += ' ok';
        if (u.tokenType === 'analytics') {
          badgeText = `Connected · 1-Year Analytics Token${u.wsConnected ? ' · WS Live' : ''}`;
        } else if (u.tokenType === 'daily_oauth') {
          badgeText = `Connected · Daily OAuth${u.user?.userName ? ' · ' + u.user.userName : ''}${
            u.wsConnected ? ' · WS Live' : ''
          }`;
        } else {
          badgeText = `Connected${u.user?.userName ? ' · ' + u.user.userName : ''}${
            u.wsConnected ? ' · WS Live' : ''
          }`;
        }
      } else if (u.tokenExpired) {
        badgeCls += ' err';
        badgeText = 'Daily token expired · Paste 1-Year Token';
      } else if (u.authFailed) {
        badgeCls += ' err';
        badgeText = 'Token rejected · Update Token';
      } else if (u.configured) {
        badgeCls += ' warn';
        badgeText = 'API keys saved · Token needed';
      }
      badge.className = badgeCls;
      badge.textContent = badgeText;
    }

    if (metaEl) {
      let metaText =
        'Use a 1-Year Analytics Token below so you never have to log in or enter keys daily.';
      let isErr = false;
      const expStr = formatIstTimestamp(u.expiresAt);
      if (u.connected) {
        if (u.tokenType === 'analytics') {
          const daysTxt = u.expiresInDays !== null ? `${u.expiresInDays} days left` : 'Active';
          metaText = `1-Year Analytics Token active · ${daysTxt}${expStr ? ` (expires ${expStr} IST)` : ''}. No daily login required.`;
        } else if (expStr) {
          metaText = `Daily OAuth session active · expires ${expStr} IST. Switch to an Analytics Token below to stop daily logins.`;
        }
      } else if (u.tokenExpired) {
        isErr = true;
        metaText = `Your daily Upstox token expired${expStr ? ` at ${expStr} IST` : ''}. Upstox OAuth tokens reset every day at 03:30 AM IST — paste a 1-Year Analytics Token below once to avoid daily login.`;
      } else if (u.authFailed && u.lastError) {
        isErr = true;
        metaText = `Upstox rejected the active token: ${u.lastError}`;
      } else if (u.configured) {
        metaText =
          'Your API Key & Secret are already saved on this server. Paste a 1-Year Analytics Token below for one-time setup, or open Daily OAuth Login to re-authorize with saved keys.';
      }
      metaEl.className = 'help-text' + (isErr ? ' is-err' : '');
      metaEl.textContent = metaText;
    }

    if (disBtn) disBtn.hidden = !(u.connected || u.hasToken);
  };

  const refreshState = async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return;
      const st = await res.json();
      const u = st.upstox || {};
      upstoxSaved = Boolean(u.hasApiKey && u.configured);
      renderUpstoxStatus(u);

      const cfg = st.config || {};
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
      };
      setVal('cfgPollInterval', cfg.pollIntervalSec ?? 60);
      setVal('cfgTopN', cfg.topN ?? 5);
      setVal('cfgMinAgree', cfg.minAgree ?? 4);
      setVal('cfgObProx', cfg.obProximityPct ?? 0.5);
      setVal('cfgConfirmPolls', cfg.confirmPolls ?? 2);
      setVal('cfgMinPrice', cfg.minPrice ?? 0);
      setVal('cfgWatchlist', (cfg.watchlist || []).join(', '));
      setVal('cfgIgnore', (cfg.ignoreSymbols || []).join(', '));
    } catch {
      // Ignore transient load error
    }
  };

  initValidation();
  refreshState();

  const initMarketStatus = () => {
    const pill = document.getElementById('settingsMarketPill');
    if (!pill) return;
    const render = () => {
      if (!window.NSEMarketHours?.getMarketStatus) return;
      const ms = window.NSEMarketHours.getMarketStatus(new Date());
      pill.className = 'market-status-pill ' + (ms.open ? 'is-open' : 'is-closed');
      pill.textContent = `NSE ${ms.shortText}`;
      pill.title = ms.detailText;
      pill.setAttribute('aria-label', ms.detailText);
    };
    render();
    if (typeof setInterval === 'function') setInterval(render, 1000);
  };
  initMarketStatus();

  const initFxControls = () => {
    const toggleBtn = document.getElementById('fxToggleBtn');
    const toggleLabel = document.getElementById('fxToggleLabel');
    const badge = document.getElementById('fxStatusBadge');
    const msgEl = document.getElementById('fxStatusMsg');
    if (!toggleBtn) return;

    const readPaused = () => {
      try {
        return localStorage.getItem('ob_fx_paused') === '1';
      } catch {
        return false;
      }
    };

    const syncFxUi = (paused, announce = false) => {
      const playing = !paused;
      toggleBtn.setAttribute('aria-checked', String(playing));
      toggleBtn.setAttribute('aria-label', playing ? 'Play FX enabled. Click to Pause FX' : 'Pause FX enabled. Click to Play FX');
      toggleBtn.classList.toggle('is-on', playing);
      toggleBtn.classList.toggle('is-paused', paused);
      if (toggleLabel) toggleLabel.textContent = playing ? 'Play FX' : 'Pause FX';
      if (badge) {
        badge.className = 'status-pill ' + (paused ? 'warn' : 'ok');
        badge.textContent = paused ? 'FX Paused' : 'FX Playing';
      }
      if (announce) {
        setFormStatus(
          msgEl,
          paused
            ? 'Ambient FX paused. Order Block stage saves CPU & GPU until resumed.'
            : 'Ambient FX enabled on Order Block stage.',
          'ok'
        );
      }
    };

    const setFxPaused = paused => {
      try {
        localStorage.setItem('ob_fx_paused', paused ? '1' : '0');
      } catch {
        // Ignore storage restrictions
      }
      syncFxUi(Boolean(paused), true);
    };

    syncFxUi(readPaused(), false);
    toggleBtn.addEventListener('click', () => setFxPaused(!readPaused()));
    window.addEventListener?.('storage', e => {
      if (e && e.key === 'ob_fx_paused') syncFxUi(e.newValue === '1', false);
    });
  };
  initFxControls();

  const copyBtn = document.getElementById('copyRedirectBtn');
  const upstoxStatus = document.getElementById('upstoxStatusMsg');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const txt =
        document.getElementById('upstoxRedirectCode')?.textContent ||
        'http://localhost:4600/api/upstox/callback';
      navigator.clipboard?.writeText(txt).catch(() => {});
      copyBtn.textContent = 'Copied!';
      setFormStatus(upstoxStatus, 'Redirect URL copied to clipboard.', 'ok');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1500);
    });
  }

  const analyticsToggle = bindSecretToggle('toggleAnalyticsBtn', 'upstoxAnalyticsToken', 'Analytics Token');
  const secretToggle = bindSecretToggle('toggleSecretBtn', 'upstoxApiSecret', 'API Secret');
  const analyticsInput = analyticsToggle?.input || document.getElementById('upstoxAnalyticsToken');
  const secretInput = secretToggle?.input || document.getElementById('upstoxApiSecret');

  const tokenForm = document.getElementById('upstoxTokenForm');
  const tokenStatus = document.getElementById('upstoxTokenStatusMsg');
  const saveTokenBtn = document.getElementById('upstoxSaveTokenBtn');
  const resetTokenControl = stillConnected => {
    if (!tokenForm || !analyticsInput) return;
    analyticsInput.required = !stillConnected;
    tokenForm.reset();
    analyticsToggle?.reset();
    dirtyState.delete(analyticsInput);
    updateFallbackClasses(analyticsInput, false);
    syncAria(analyticsInput, false);
  };

  if (tokenForm && analyticsInput) {
    tokenForm.addEventListener('submit', async e => {
      e.preventDefault();
      analyticsInput.required = true;
      if (!validateFormOrFocus(tokenForm)) return;

      if (saveTokenBtn) saveTokenBtn.disabled = true;
      setFormStatus(tokenStatus, 'Verifying token with Upstox…');
      try {
        const res = await fetch('/api/upstox/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ token: analyticsInput.value.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          setFormStatus(tokenStatus, data.error || 'Token verification failed.', 'err');
          return;
        }
        resetTokenControl(Boolean(data.status?.connected));
        const days = data.status?.expiresInDays;
        const msg =
          days !== null && days !== undefined
            ? `Token verified & saved (${days} days remaining). Live quotes & WebSocket starting.`
            : 'Upstox token verified & saved. Live quotes & WebSocket starting.';
        setFormStatus(tokenStatus, msg, 'ok');
        refreshState();
      } catch {
        setFormStatus(tokenStatus, 'Network error contacting Upstox token verification endpoint.', 'err');
      } finally {
        if (saveTokenBtn) saveTokenBtn.disabled = false;
      }
    });
  }

  const upstoxForm = document.getElementById('upstoxForm');
  const keyInput = document.getElementById('upstoxApiKey');
  const connectBtn = document.getElementById('upstoxConnectBtn');
  if (upstoxForm) {
    upstoxForm.addEventListener('submit', async e => {
      e.preventDefault();
      const apiKey = keyInput?.value.trim() || '';
      const apiSecret = secretInput?.value.trim() || '';

      // Require keys only if none are saved yet, or if user started entering one
      const needKeys = !upstoxSaved || Boolean(apiKey || apiSecret);
      if (keyInput) keyInput.required = needKeys && (!upstoxSaved || Boolean(apiSecret));
      if (secretInput) secretInput.required = needKeys && (!upstoxSaved || Boolean(apiKey));

      if (!validateFormOrFocus(upstoxForm)) return;

      const redirectUri =
        document.getElementById('upstoxRedirectCode')?.textContent?.trim() ||
        'http://localhost:4600/api/upstox/callback';
      if (connectBtn) connectBtn.disabled = true;
      setFormStatus(upstoxStatus, 'Saving Upstox keys & preparing login…');

      try {
        const res = await fetch('/api/upstox/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: apiKey || undefined,
            apiSecret: apiSecret || undefined,
            redirectUri,
          }),
        });
        const data = await res.json();
        if (!data.ok || !data.authUrl) {
          setFormStatus(upstoxStatus, 'Please enter both Upstox API Key and API Secret.', 'err');
          if (connectBtn) connectBtn.disabled = false;
          return;
        }
        window.location.href = data.authUrl;
      } catch {
        setFormStatus(upstoxStatus, 'Network error contacting Upstox setup endpoint.', 'err');
        if (connectBtn) connectBtn.disabled = false;
      }
    });
  }

  const disBtn = document.getElementById('upstoxDisconnectBtn');
  if (disBtn) {
    disBtn.addEventListener('click', async () => {
      await fetch('/api/upstox/disconnect', { method: 'POST' });
      resetTokenControl(false);
      setFormStatus(tokenStatus, 'Upstox token cleared.', 'ok');
      setFormStatus(upstoxStatus, '');
      refreshState();
    });
  }

  const rulesForm = document.getElementById('rulesForm');
  const rulesStatus = document.getElementById('rulesStatusMsg');
  const saveRulesBtn = document.getElementById('saveRulesBtn');
  if (rulesForm) {
    rulesForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!validateFormOrFocus(rulesForm)) return;

      const splitList = str =>
        String(str || '')
          .split(',')
          .map(s => s.trim().toUpperCase())
          .filter(Boolean);

      const payload = {
        pollIntervalSec: Number(document.getElementById('cfgPollInterval')?.value || 60),
        topN: Number(document.getElementById('cfgTopN')?.value || 5),
        minAgree: Number(document.getElementById('cfgMinAgree')?.value || 4),
        obProximityPct: Number(document.getElementById('cfgObProx')?.value || 0.5),
        confirmPolls: Number(document.getElementById('cfgConfirmPolls')?.value || 2),
        minPrice: Number(document.getElementById('cfgMinPrice')?.value || 0),
        watchlist: splitList(document.getElementById('cfgWatchlist')?.value),
        ignoreSymbols: splitList(document.getElementById('cfgIgnore')?.value),
      };

      if (saveRulesBtn) saveRulesBtn.disabled = true;
      setFormStatus(rulesStatus, 'Saving rules & refreshing live snapshot…');
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        await fetch('/api/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        setFormStatus(rulesStatus, 'Rules saved and live feed refreshed.', 'ok');
      } catch {
        setFormStatus(rulesStatus, 'Failed to save rules. Please try again.', 'err');
      } finally {
        if (saveRulesBtn) saveRulesBtn.disabled = false;
      }
    });
  }
})();
