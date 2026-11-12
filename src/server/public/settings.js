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

  const syncAria = (el, announce = false) => {
    if (!el.matches?.('input, select, textarea')) return;
    const isInvalid = supportsUserInvalid
      ? el.matches(':user-invalid')
      : el.classList.contains('user-invalid-fallback');
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
        syncAria(e.target, false);
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

  const refreshState = async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return;
      const st = await res.json();
      const u = st.upstox || {};
      upstoxSaved = Boolean(u.hasApiKey && u.configured);

      const section = document.getElementById('upstoxSection');
      const badge = document.getElementById('upstoxStatusBadge');
      const redirEl = document.getElementById('upstoxRedirectCode');
      const keyInput = document.getElementById('upstoxApiKey');
      const secretInput = document.getElementById('upstoxApiSecret');
      const disBtn = document.getElementById('upstoxDisconnectBtn');

      if (redirEl && u.redirectUri) redirEl.textContent = u.redirectUri;
      if (keyInput && u.apiKeyPreview && u.hasApiKey) {
        keyInput.placeholder = `Saved (${u.apiKeyPreview})`;
      }
      if (secretInput && u.configured) {
        secretInput.placeholder = 'Saved (paste to update)';
      }

      if (section) section.classList.toggle('is-connected', Boolean(u.connected));
      if (badge) {
        badge.className = 'status-pill' + (u.connected ? ' ok' : u.configured ? ' warn' : '');
        badge.textContent = u.connected
          ? `Connected${u.user?.userName ? ' · ' + u.user.userName : ''}${u.wsConnected ? ' · WS Live' : ''}`
          : u.configured
          ? 'Keys saved · Login required'
          : 'Not connected';
      }
      if (disBtn) disBtn.hidden = !u.connected;

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

  const toggleSecretBtn = document.getElementById('toggleSecretBtn');
  const secretInput = document.getElementById('upstoxApiSecret');
  if (toggleSecretBtn && secretInput) {
    toggleSecretBtn.addEventListener('click', () => {
      const showing = secretInput.type === 'text';
      secretInput.type = showing ? 'password' : 'text';
      toggleSecretBtn.setAttribute('aria-pressed', showing ? 'false' : 'true');
      toggleSecretBtn.setAttribute('aria-label', showing ? 'Show API Secret' : 'Hide API Secret');
      toggleSecretBtn.textContent = showing ? 'Show' : 'Hide';
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

      if (!upstoxForm.checkValidity()) {
        const firstInvalid = upstoxForm.querySelector(':invalid');
        if (firstInvalid) {
          updateFallbackClasses(firstInvalid, true);
          syncAria(firstInvalid, false);
          firstInvalid.focus();
        }
        return;
      }

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
      setFormStatus(upstoxStatus, 'Upstox disconnected.', 'ok');
      refreshState();
    });
  }

  const rulesForm = document.getElementById('rulesForm');
  const rulesStatus = document.getElementById('rulesStatusMsg');
  const saveRulesBtn = document.getElementById('saveRulesBtn');
  if (rulesForm) {
    rulesForm.addEventListener('submit', async e => {
      e.preventDefault();
      if (!rulesForm.checkValidity()) {
        const firstInvalid = rulesForm.querySelector(':invalid');
        if (firstInvalid) {
          updateFallbackClasses(firstInvalid, true);
          syncAria(firstInvalid, false);
          firstInvalid.focus();
        }
        return;
      }

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
