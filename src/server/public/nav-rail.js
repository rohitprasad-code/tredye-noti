(function () {
  function readThemeCookie() {
    const match = document.cookie.match(/(?:^|;\s*)ob_theme=(light|dark|system)(?:;|$)/);
    if (!match) return 'dark';
    if (match[1] === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }
    return match[1];
  }

  function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    if (t === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    document.querySelectorAll('#obSideRail .rt-btn').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-theme-set') === t);
    });
  }

  function writeThemeCookie(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.cookie = 'ob_theme=' + t + '; path=/; max-age=31536000; SameSite=Lax';
    applyTheme(t);
  }

  // Apply theme as early as possible to avoid flash
  applyTheme(readThemeCookie());

  function mountNavRail() {
    if (!document.body || !document.body.classList.contains('has-ob-rail')) return;
    if (document.getElementById('obSideRail')) return;

    const expanded = (function () {
      try {
        return localStorage.getItem('ob_rail_expanded') === '1';
      } catch (_e) {
        return false;
      }
    })();
    if (expanded) {
      document.body.classList.add('rail-expanded');
    }

    const path = (location.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    const params = new URLSearchParams(location.search || '');
    const isAlerts = path === '/' || path === '/app';
    const isOrderBlock = path === '/app/orderblock';
    const isJournal = path === '/app/journal' || path === '/journal';
    const isNewTrade = isJournal && params.get('action') === 'new';

    const curTheme =
      document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

    const aside = document.createElement('aside');
    aside.className = 'ob-side-rail';
    aside.id = 'obSideRail';
    aside.setAttribute('aria-label', 'Primary Navigation');
    aside.innerHTML =
      '<div class="rail-top">' +
        '<a href="/app/orderblock" class="rail-logo" title="Order Block">' +
          '<span class="logo-bars" aria-hidden="true">' +
            '<i class="b1"></i>' +
            '<i class="b2"></i>' +
            '<i class="b3"></i>' +
          '</span>' +
          '<span class="rail-lbl rail-brand-lbl">Terminal</span>' +
        '</a>' +
        '<button type="button" class="rail-collapse" id="obRailToggle" title="Expand / Collapse sidebar" aria-label="Toggle sidebar">' +
          (expanded ? '«' : '»') +
        '</button>' +
        '<div class="rail-divider"></div>' +
        '<a href="/" class="rail-item' + (isAlerts ? ' active' : '') + '" title="Alert Desk &amp; Tracker (/)" data-tip="Alert Desk">' +
          '<span class="rail-ic">⌂</span>' +
          '<span class="rail-lbl">Alert Desk</span>' +
        '</a>' +
        '<a href="/app/orderblock" class="rail-item' + (isOrderBlock ? ' active' : '') + '" title="Order Block Terminal (/app/orderblock)" data-tip="Order Block">' +
          '<span class="rail-ic">⟁</span>' +
          '<span class="rail-lbl">Order Block</span>' +
        '</a>' +
        '<a href="/app/journal" class="rail-item journey' + (isJournal && !isNewTrade ? ' active' : '') + '" title="My Journey &amp; Investment Booklet (/app/journal)" data-tip="My Journey">' +
          '<span class="rail-ic">📖</span>' +
          '<span class="rail-lbl">My Journey</span>' +
        '</a>' +
        '<a href="/app/journal?action=new" class="rail-item' + (isNewTrade ? ' active' : '') + '" title="Log New Investment in My Journey" data-tip="Log Trade">' +
          '<span class="rail-ic">➕</span>' +
          '<span class="rail-lbl">Log Trade</span>' +
        '</a>' +
      '</div>' +
      '<div class="rail-bottom">' +
        '<div class="rail-live" title="Live 218 NSE F&amp;O Feed" data-tip="Live 218 F&O">' +
          '<span class="rail-live-dot"></span>' +
          '<span class="rail-lbl">218 Live</span>' +
        '</div>' +
        '<div class="rail-theme-pill" role="group" aria-label="Theme toggle">' +
          '<button type="button" class="rt-btn' + (curTheme === 'light' ? ' on' : '') + '" data-theme-set="light" title="Light theme" aria-label="Light theme">☀</button>' +
          '<button type="button" class="rt-btn' + (curTheme === 'dark' ? ' on' : '') + '" data-theme-set="dark" title="Dark theme" aria-label="Dark theme">☾</button>' +
        '</div>' +
      '</div>';

    document.body.insertBefore(aside, document.body.firstChild);

    const toggleBtn = document.getElementById('obRailToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        const exp = document.body.classList.toggle('rail-expanded');
        toggleBtn.textContent = exp ? '«' : '»';
        try {
          localStorage.setItem('ob_rail_expanded', exp ? '1' : '0');
        } catch (_e) {
          // Ignore storage errors
        }
      });
    }

    aside.querySelectorAll('.rt-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const next = btn.getAttribute('data-theme-set') || 'dark';
        writeThemeCookie(next);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountNavRail);
  } else {
    mountNavRail();
  }
})();
